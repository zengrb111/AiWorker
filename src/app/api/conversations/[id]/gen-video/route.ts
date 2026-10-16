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

/**
 * 生成视频时用于回显「本次输入」的素材：参考图与创作要求。
 *
 * 为什么放进消息正文而不是新增字段：Message.content 本身就是 Markdown，
 * 而 renderMarkdown（src/lib/markdown.ts:29-40）已支持整行 `![alt](url)` 图片，
 * 且只放行以 `/` 或 http(s) 开头的同源/外链 URL。所以把参考图按
 * `/uploads/gen-video-refs/{token}/ref-N.ext` 写成 Markdown 图片即可直接显示，
 * 前端零改动；同时这份内容天然随消息落库，刷新页面后依然在。
 */
type VideoInputContext = {
  /** 参考图的可访问 URL（不是落盘绝对路径——那个只有服务端能读）。 */
  referenceImages: string[];
  /** 用户填写的创作要求/提示词，可空。 */
  requirement: string;
};

function formatProgressMessage(
  input: VideoInputContext,
  progress: string[],
  videoUrl?: string,
  error?: string,
  narration?: string,
  title?: string
): string {
  const lines = ["## 一键生成视频", "", ...progress.map((item) => `- ${item}`)];
  // 输入回显：放在进度之后、标题之前。这个函数每次从头重建整段，
  // 所以 progress 持续增长也不会打乱各区块的相对顺序。
  if (input.referenceImages.length) {
    lines.push("", "### 参考图", "");
    input.referenceImages.forEach((url, i) => lines.push(`![参考图 ${i + 1}](${url})`));
  }
  if (input.requirement) {
    // 走引用块：保留原样换行，且 renderMarkdown 会对文本做 HTML 转义。
    lines.push("", "### 创作要求", "", ...input.requirement.split(/\r?\n/).map((l) => `> ${l}`));
  }
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
  // 参考图的对外可访问 URL。落盘路径是本机绝对路径，只有服务端能读；
  // 前端要回显必须用 /uploads/... 形式。两者在同一次循环里 push，索引天然对齐。
  const referenceImageUrls: string[] = [];
  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const extension = extname(file.name).toLowerCase();
    if (!allowedImageExtensions.has(extension)) continue;
    if (file.size > maxUploadBytes) continue;
    const target = join(uploadsRoot, `ref-${i}${extension}`);
    await writeFile(target, Buffer.from(await file.arrayBuffer()));
    savedImagePaths.push(target);
    referenceImageUrls.push(`/uploads/gen-video-refs/${token}/ref-${i}${extension}`);
  }
  if (!savedImagePaths.length) return jsonError("参考图格式不支持，请上传 JPG / PNG / WebP。");

  // 本次输入的回显上下文，全程传给 formatProgressMessage（占位 / 进度 / 完成 / 失败四处共用）。
  const inputContext: VideoInputContext = { referenceImages: referenceImageUrls, requirement };

  const engine = resolveRenderEngine();
  const task = await prisma.openClawTask.create({
    data: { userId: user.id, type: "gen-video", prompt: requirement.slice(0, 200), status: "RUNNING" },
  });
  const progress = ["已接收参考图，正在准备 Remotion 视频创作任务…"];
  const progressMessage = await prisma.message.create({
    data: { conversationId: conversation.id, role: "ASSISTANT", content: formatProgressMessage(inputContext, progress) },
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
            .update({ where: { id: progressMessage.id }, data: { content: formatProgressMessage(inputContext, progress) } })
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
          // 归属用户：配音 / 分镜 / 识图都按该用户「系统配置」里的模型服务来调用
          userId: user.id,
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
            content: formatProgressMessage(inputContext, progress, finalUrl ?? undefined, undefined, narrationText || undefined, videoTitle || undefined),
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
              // 参考图一并入库：内容库的「主图」区按 inlineImagesJson 平铺展示
              // （platform-client.tsx 的 parseInlineImages 已通用），
              // 这样出片后仍能回看「这条视频是用哪几张图做出来的」。
              inlineImagesJson: JSON.stringify(referenceImageUrls),
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
            data: { content: formatProgressMessage(inputContext, progress, undefined, message) },
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
