import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { DEFAULT_TTS_PROVIDER, resolveTtsProvider } from "@/lib/tts";
import { parseTargetSeconds, pickBgm, resolveRenderEngine, runVideoPipeline } from "@/lib/video/pipeline";
import { renderViaOpenClaw } from "@/lib/video/legacy-openclaw";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const maxUploadBytes = 30 * 1024 * 1024;
const allowedImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/**
 * SSE 心跳间隔（毫秒）。
 *
 * 出片是几十秒起步的长任务，而 SSE 只在有进展时才发事件；中间那段纯渲染时间
 * 完全静默，反向代理会当成空闲连接掐掉。参照 messages/route.ts 的 15s ping。
 */
const HEARTBEAT_MS = 15_000;

function sseEncode(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function formatProgressMessage(
  progress: string[],
  videoUrl?: string,
  error?: string,
  narration?: string,
  title?: string
): string {
  const lines = ["## 一键生成视频", "", ...progress.map((item) => `- ${item}`)];
  if (title) lines.push("", "## 视频标题", `> ${title}`);
  if (narration) lines.push("", "## 旁白文案", `> ${narration}`);
  if (videoUrl) lines.push("", "## 视频生成完成", `视频成片：${videoUrl}`);
  if (error) lines.push("", "## 视频生成失败", error);
  return lines.join("\n");
}

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const conversation = await prisma.conversation.findFirst({ where: { id: context.params.id, userId: user.id } });
  if (!conversation) return jsonError("对话不存在。", 404);

  const form = await request.formData();
  const imageFiles = (form.getAll("image") || []).filter(
    (entry): entry is File => entry instanceof File && entry.size > 0
  );
  if (!imageFiles.length) return jsonError("请至少上传一张参考图。");
  const requirement = String(form.get("requirement") ?? "").trim();
  // 用户在对话框里选择的语音引擎（qwen / zhipu）；非法值回落到全局默认（千问）。
  const ttsProvider = resolveTtsProvider(form.get("ttsProvider"), DEFAULT_TTS_PROVIDER);
  // 视频风格。空 = 自动（由识图结果推断）。不校验 key 是否存在：
  // 未知主题由 remotion 侧 resolveTheme() 回落到默认，报错反而阻断出片。
  const theme = String(form.get("theme") ?? "").trim() || undefined;

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  // 参考图落在 public/uploads 下，两条引擎都直接读本机绝对路径；
  // 不再需要往 ~/.openclaw/workspace/remotion-refs/ 复制一份（旧路径的媒体白名单限制）。
  const uploadsRoot = join(process.cwd(), "public", "uploads", "gen-video-refs", token);
  await mkdir(uploadsRoot, { recursive: true });

  const savedImagePaths: string[] = [];
  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const extension = extname(file.name).toLowerCase();
    if (!allowedImageExtensions.has(extension)) continue;
    if (file.size > maxUploadBytes) continue;
    const target = join(uploadsRoot, `ref-${i}${extension}`);
    await writeFile(target, Buffer.from(await file.arrayBuffer()));
    savedImagePaths.push(target);
  }
  if (!savedImagePaths.length) return jsonError("参考图格式不支持，请上传 JPG / PNG / WebP。");

  const engine = resolveRenderEngine();
  const task = await prisma.openClawTask.create({
    data: { userId: user.id, type: "gen-video", prompt: requirement.slice(0, 200), status: "RUNNING" },
  });
  const progress = ["已接收参考图，正在准备 Remotion 视频创作任务…"];
  const progressMessage = await prisma.message.create({
    data: { conversationId: conversation.id, role: "ASSISTANT", content: formatProgressMessage(progress) },
  });
  let progressWrite = Promise.resolve();
  const stream = new ReadableStream({
    async start(controller) {
      // 心跳：渲染期间没有任何事件下发，靠定时 ping 让连接保持存活
      const heartbeat = setInterval(() => {
        controller.enqueue(sseEncode({ type: "ping", at: Date.now() }));
      }, HEARTBEAT_MS);

      const sendProgress = (text: string) => {
        if (!text.trim()) return;
        progress.push(text);
        progressWrite = progressWrite.then(() =>
          prisma.message
            .update({ where: { id: progressMessage.id }, data: { content: formatProgressMessage(progress) } })
            .then(() => undefined)
        );
        controller.enqueue(sseEncode({ type: "delta", text: `${text}\n` }));
      };
      try {
        // 出片全流程收敛到编排层：旁白 → 配音 → 分镜(DeepSeek/兜底) → Remotion 渲染
        // → 混音 → 字幕 → 片头 → 封面。参数与顺序与改造前一致。
        const result = await runVideoPipeline({
          mode: "generate",
          token,
          materials: savedImagePaths,
          requirement,
          // 视频时长由旁白 TTS 时长决定；这里给的是「配文阶段」的目标时长
          targetSeconds: parseTargetSeconds(requirement),
          ttsProvider,
          theme,
          bgmPath: pickBgm(),
          renderOverride: engine === "openclaw" ? renderViaOpenClaw : undefined,
          onProgress: sendProgress,
        });

        if (!result.ok) throw new Error(result.error || "视频生成失败。");

        const finalUrl = result.videoUrl ?? null;
        const coverUrl = result.coverUrl ?? null;
        const narrationText = result.narration;
        const videoTitle = result.title;

        // ---- 落库 ----
        await progressWrite;
        const finalMessage = await prisma.message.update({
          where: { id: progressMessage.id },
          data: {
            content: formatProgressMessage(progress, finalUrl ?? undefined, undefined, narrationText || undefined, videoTitle || undefined),
          },
        });
        let saved: { id: string; title: string; category: string; videoUrl: string; coverImageUrl?: string } | undefined;
        if (finalUrl) {
          const item = await prisma.contentItem.create({
            data: {
              userId: user.id,
              title: videoTitle || `一键生成视频-${token}`,
              body: narrationText,
              category: "视频",
              videoUrl: finalUrl,
              coverImageUrl: coverUrl,
              sourceConversationId: conversation.id,
            },
          });
          saved = {
            id: item.id,
            title: item.title,
            category: item.category ?? "视频",
            videoUrl: finalUrl,
            coverImageUrl: coverUrl ?? undefined,
          };
        }
        await prisma.openClawTask.update({
          where: { id: task.id },
          data: {
            status: "SUCCEEDED",
            resultJson: JSON.stringify({
              videoUrl: finalUrl,
              title: videoTitle || null,
              coverUrl,
              narration: narrationText || null,
              messageId: finalMessage.id,
              contentId: saved?.id ?? null,
              // 排查用：实际走了哪条引擎、分镜是否兜底、后期每一步的成败
              engine: result.engineUsed,
              storyboardFallback: result.diagnostics.storyboardFallback,
              dshAvailable: result.diagnostics.dshAvailable,
              postSteps: result.diagnostics.postSteps,
            }),
          },
        });
        controller.enqueue(
          sseEncode({
            type: "final",
            videoUrl: finalUrl,
            title: videoTitle || null,
            coverUrl,
            narration: narrationText || null,
            contentSaved: saved,
          })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "视频生成失败。";
        await progressWrite.catch(() => undefined);
        await prisma.message
          .update({
            where: { id: progressMessage.id },
            data: { content: formatProgressMessage(progress, undefined, message) },
          })
          .catch(() => undefined);
        await prisma.openClawTask.update({ where: { id: task.id }, data: { status: "FAILED", error: message } });
        controller.enqueue(sseEncode({ type: "error", error: message }));
      } finally {
        // 必须清掉心跳：流 close 之后继续 enqueue 会抛错
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
