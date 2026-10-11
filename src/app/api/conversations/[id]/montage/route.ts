import { jsonError } from "@/lib/http";
import { transcribeVideoToSrt } from "@/lib/asr";
import { burnSubtitles, concatVideoClips, normalizeToVertical } from "@/lib/video-stitch";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const maxUploadBytes = 500 * 1024 * 1024;
const allowedExtensions = new Set([".mp4", ".mov", ".m4v", ".webm", ".jpg", ".jpeg", ".png", ".webp"]);

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
    data: { userId: user.id, type: "openmontage-edit", prompt: file.name, status: "RUNNING" },
  });
  const progress = ["已接收视频，正在准备智能剪辑任务…"];
  const progressMessage = await prisma.message.create({
    data: { conversationId: conversation.id, role: "ASSISTANT", content: formatProgressMessage(progress) },
  });
  let progressWrite = Promise.resolve();
  const stream = new ReadableStream({
    async start(controller) {
      const sendProgress = (text: string) => {
        progress.push(text);
        progressWrite = progressWrite.then(() =>
          prisma.message.update({ where: { id: progressMessage.id }, data: { content: formatProgressMessage(progress) } }).then(() => undefined),
        );
        controller.enqueue(sseEncode({ type: "delta", text: `${text}\n` }));
      };
      try {
        sendProgress("视频上传完成，正在识别语音并生成字幕...");
        const asr = await transcribeVideoToSrt(inputPath, speechDir, sendProgress);
        let mainClip = inputPath;
        if (asr.ok) {
          sendProgress(`已生成 ${asr.cueCount} 条语音字幕，开始烧录并剪辑成片...`);
          const normalized = join(uploadsDir, `norm-${token}.mp4`);
          const n = await normalizeToVertical(inputPath, normalized, sendProgress);
          if (n.ok) {
            const burned = join(uploadsDir, `captioned-${token}.mp4`);
            const b = await burnSubtitles(normalized, asr.srtPath, burned, sendProgress);
            if (b.ok) mainClip = burned;
          }
        } else {
          sendProgress(`语音字幕未生成：${asr.reason}（将输出无字幕版本）`);
          const normalized = join(uploadsDir, `norm-${token}.mp4`);
          const n = await normalizeToVertical(inputPath, normalized, sendProgress);
          if (n.ok) mainClip = normalized;
        }

        const allClips = [mainClip, ...clipPaths];
        const stitched = await concatVideoClips(allClips, outputPath, { onProgress: sendProgress });
        if (!stitched.ok) throw new Error(stitched.reason);

        const videoUrl = `/videos/${outputName}`;
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
          data: { status: "SUCCEEDED", resultJson: JSON.stringify({ videoUrl, messageId: assistantMessage.id, contentId: saved.id }) },
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
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
