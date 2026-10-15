import { jsonError } from "@/lib/http";
import { parseSrtCues, transcribeVideoToSrt } from "@/lib/asr";
import { concatVideoClips } from "@/lib/video-stitch";
import { prisma } from "@/lib/prisma";
import { probeDuration } from "@/lib/ffmpeg";
import { requireUser } from "@/lib/session";
import { pickBgm, runVideoPipeline } from "@/lib/video/pipeline";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const maxUploadBytes = 500 * 1024 * 1024;
const allowedExtensions = new Set([".mp4", ".mov", ".m4v", ".webm", ".jpg", ".jpeg", ".png", ".webp"]);

/**
 * SSE 心跳间隔（毫秒）。出片是几十秒起步的长任务，中间纯渲染阶段没有任何事件，
 * 不发 ping 会被反向代理当成空闲连接掐掉。参照 messages/route.ts。
 */
const HEARTBEAT_MS = 15_000;

function sseEncode(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function formatProgressMessage(progress: string[], videoUrl?: string, error?: string): string {
  const lines = ["## 一键剪视频", "", ...progress.map((item) => `- ${item}`)];
  if (videoUrl) lines.push("", "## 剪辑完成", `视频成片：${videoUrl}`);
  if (error) lines.push("", "## 剪辑失败", error);
  return lines.join("\n");
}

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const conversation = await prisma.conversation.findFirst({ where: { id: context.params.id, userId: user.id } });
  if (!conversation) return jsonError("对话不存在。", 404);

  const form = await request.formData();
  const file = form.get("video");
  if (!(file instanceof File) || file.size === 0) return jsonError("请选择需要剪辑的主视频文件。");
  if (file.size > maxUploadBytes) return jsonError("视频文件不能超过 500MB。");
  const extension = extname(file.name).toLowerCase();
  if (!allowedExtensions.has(extension)) return jsonError("仅支持 MP4、MOV、M4V、WebM 视频或图片素材。");

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const uploadsDir = join(process.cwd(), "public", "uploads");
  const videosDir = join(process.cwd(), "public", "videos");
  await Promise.all([mkdir(uploadsDir, { recursive: true }), mkdir(videosDir, { recursive: true })]);
  const inputPath = join(uploadsDir, `source-${token}${extension}`);
  await writeFile(inputPath, Buffer.from(await file.arrayBuffer()));

  // 可选的多段素材（视频或图片）
  const clipFiles = (form.getAll("clip") || []).filter((f): f is File => f instanceof File && f.size > 0);
  const clipPaths: string[] = [];
  for (let i = 0; i < clipFiles.length; i++) {
    const cf = clipFiles[i];
    const ce = extname(cf.name).toLowerCase();
    if (!allowedExtensions.has(ce)) continue;
    const cp = join(uploadsDir, `clip-${token}-${i}${ce}`);
    await writeFile(cp, Buffer.from(await cf.arrayBuffer()));
    clipPaths.push(cp);
  }

  const outputName = `montage-${token}.mp4`;
  const outputPath = join(videosDir, outputName);
  const speechDir = join(uploadsDir, `speech-${token}`);

  const task = await prisma.openClawTask.create({
    data: { userId: user.id, type: "video-montage", prompt: file.name, status: "RUNNING" },
  });
  const progress = ["已接收视频，正在准备智能剪辑任务…"];
  const progressMessage = await prisma.message.create({
    data: { conversationId: conversation.id, role: "ASSISTANT", content: formatProgressMessage(progress) },
  });
  let progressWrite = Promise.resolve();
  const stream = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        controller.enqueue(sseEncode({ type: "ping", at: Date.now() }));
      }, HEARTBEAT_MS);

      const sendProgress = (text: string) => {
        if (!text.trim()) return;
        progress.push(text);
        progressWrite = progressWrite.then(() =>
          prisma.message.update({ where: { id: progressMessage.id }, data: { content: formatProgressMessage(progress) } }).then(() => undefined),
        );
        controller.enqueue(sseEncode({ type: "delta", text: `${text}\n` }));
      };
      try {
        // ---- 1. 语音识别：口播文本既用于烧字幕，也用于让 DeepSeek 决定剪辑点 ----
        sendProgress("视频上传完成，正在识别语音并生成字幕...");
        const asr = await transcribeVideoToSrt(inputPath, speechDir, sendProgress);
        const captions = asr.ok ? parseSrtCues(asr.srtPath) : [];
        if (asr.ok) {
          sendProgress(`已生成 ${asr.cueCount} 条语音字幕，正在规划剪辑节奏...`);
        } else {
          sendProgress(`语音字幕未生成：${asr.reason}（将输出无字幕版本）`);
        }

        // ---- 2. Remotion 竖版成片（DeepSeek 决定片段顺序 / 裁切点 / 转场） ----
        const sourceDuration = await probeDuration(inputPath);
        const result = await runVideoPipeline({
          mode: "montage",
          token,
          materials: [inputPath, ...clipPaths],
          requirement: String(form.get("requirement") ?? "").trim() || "把这段口播剪成节奏干脆的竖版短视频",
          theme: String(form.get("theme") ?? "").trim() || undefined,
          targetSeconds: Math.max(6, Math.round(sourceDuration || 30)),
          captions,
          bgmPath: pickBgm(),
          onProgress: sendProgress,
        });

        let videoUrl = result.videoUrl;
        if (!result.ok || !videoUrl) {
          // ---- 3. 兜底：Remotion 渲染失败时退回原来的纯 ffmpeg 拼接 ----
          sendProgress(`智能剪辑失败（${result.error ?? "未知原因"}），已切换到保底拼接模式...`);
          const mainClip = inputPath;
          const stitched = await concatVideoClips([mainClip, ...clipPaths], outputPath, { onProgress: sendProgress });
          if (!stitched.ok) throw new Error(stitched.reason);
          videoUrl = `/videos/${outputName}`;
        }

        await progressWrite;
        const assistantMessage = await prisma.message.update({
          where: { id: progressMessage.id },
          data: { content: formatProgressMessage(progress, videoUrl) },
        });
        const saved = await prisma.contentItem.create({
          data: { userId: user.id, title: `一键剪辑-${file.name}`, body: "", category: "视频", videoUrl, sourceConversationId: conversation.id },
        });
        await prisma.openClawTask.update({
          where: { id: task.id },
          data: {
            status: "SUCCEEDED",
            resultJson: JSON.stringify({
              videoUrl,
              messageId: assistantMessage.id,
              contentId: saved.id,
              engine: result.engineUsed,
              captionCount: captions.length,
            }),
          },
        });
        controller.enqueue(sseEncode({ type: "final", videoUrl, contentSaved: { id: saved.id, title: saved.title, category: saved.category, videoUrl } }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "视频剪辑失败。";
        await progressWrite.catch(() => undefined);
        await prisma.message.update({
          where: { id: progressMessage.id },
          data: { content: formatProgressMessage(progress, undefined, message) },
        }).catch(() => undefined);
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
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
