import { jsonError } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { generateNarrationScript } from "@/lib/narration";
import { synthesizeNarration } from "@/lib/tts";
import {
  addTitleOverlay,
  buildSrtFromCaptions,
  burnSubtitles,
  extractCoverFrame,
  muxNarration,
} from "@/lib/video-stitch";
import { probeDuration } from "@/lib/ffmpeg";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import os from "node:os";

const maxUploadBytes = 30 * 1024 * 1024;
const allowedImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
/** 片头标题展示时长（秒）。 */
const TITLE_SECONDS = 3;

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

/** 从龙虾返回的创作结果文本里尽力提取成片 URL。 */
function extractVideoUrl(text: string): string | undefined {
  const matchers: RegExp[] = [
    /\/videos\/[A-Za-z0-9._-]+\.mp4/g,
    /public[\\/]videos[\\/]([A-Za-z0-9._-]+\.mp4)/g,
    /https?:\/\/\S+?\.mp4/g,
  ];
  for (const re of matchers) {
    const match = re.exec(text);
    if (!match) continue;
    const raw = match[0];
    if (raw.startsWith("/videos/")) return raw;
    if (raw.startsWith("http")) return raw;
    return `/videos/${match[1]}`;
  }
  return undefined;
}

/** 从 public/audio/bgm 选一首温暖治愈风格的背景音乐。 */
function pickBgm(): string | undefined {
  const dir = join(process.cwd(), "public", "audio", "bgm");
  try {
    const files = readdirSync(dir).filter((f) => /\.(mp3|m4a|wav|aac)$/i.test(f));
    if (!files.length) return undefined;
    const preferred = files.filter((f) => /dreamy|peaceful|warm|calm|piano|gentle/i.test(f));
    const pool = preferred.length ? preferred : files;
    return join(dir, pool[Math.floor(Math.random() * pool.length)]);
  } catch {
    return undefined;
  }
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

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const uploadsRoot = join(process.cwd(), "public", "uploads", "remotion-refs", token);
  const videosDir = join(process.cwd(), "public", "videos");
  const workDir = join(process.cwd(), "public", "uploads", "gen-video", token);
  const coverDir = join(process.cwd(), "public", "uploads", "covers");
  await Promise.all([
    mkdir(uploadsRoot, { recursive: true }),
    mkdir(videosDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
    mkdir(coverDir, { recursive: true }),
  ]);

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

  // 把参考图复制一份到 OpenClaw agent 工作区（其媒体读取白名单目录），
  // 避免 openclaw 直接读取 public/... 时报 "Local media path is not under an allowed directory"。
  let agentImagePaths = savedImagePaths;
  try {
    const wsDir = join(os.homedir(), ".openclaw", "workspace", "remotion-refs", token);
    await mkdir(wsDir, { recursive: true });
    const copied: string[] = [];
    for (const abs of savedImagePaths) {
      const dest = join(wsDir, basename(abs));
      await copyFile(abs, dest);
      copied.push(dest);
    }
    if (copied.length === savedImagePaths.length) agentImagePaths = copied;
  } catch {
    // 复制失败则回退到原始 public 路径，不影响生成。
  }

  const outputName = `gen-video-${token}.mp4`;
  const outputAbs = join(videosDir, outputName);
  const outputUrl = `/videos/${outputName}`;
  const bgmPath = pickBgm();

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
      const sendProgress = (text: string) => {
        progress.push(text);
        progressWrite = progressWrite.then(() =>
          prisma.message
            .update({ where: { id: progressMessage.id }, data: { content: formatProgressMessage(progress) } })
            .then(() => undefined)
        );
        controller.enqueue(sseEncode({ type: "delta", text: `${text}\n` }));
      };
      try {
        // ---- 1. 自动配文 + 标题 ----
        sendProgress("正在根据创作要求生成标题与旁白文案…");
        const script = await generateNarrationScript(requirement, savedImagePaths.length);
        const narrationText = script?.fullText ?? "";
        const videoTitle = script?.title ?? "";

        // ---- 2. 女声配音 ----
        let audio: {
          audioPath: string;
          durationSeconds: number;
          captions: { word: string; startMs: number; endMs: number }[];
        } | null = null;
        if (narrationText) {
          sendProgress(`已生成标题「${videoTitle}」与旁白（${script!.segments.length} 句），正在合成女声配音…`);
          try {
            const tts = await synthesizeNarration(narrationText, workDir);
            audio = { audioPath: tts.audioPath, durationSeconds: tts.durationSeconds, captions: tts.captions };
            sendProgress(`女声配音合成完成（约 ${tts.durationSeconds.toFixed(1)} 秒）`);
          } catch (error) {
            sendProgress(`配音合成失败，将生成无配音版本：${error instanceof Error ? error.message : "未知错误"}`);
          }
        } else {
          sendProgress("未生成旁白文案，直接进入画面渲染…");
        }

        // ---- 3. 调用龙虾 Remotion 渲染画面 ----
        const targetDur = audio ? Math.round(audio.durationSeconds) : 0;
        const imageList = agentImagePaths.map((path, index) => `${index + 1}. ${path}`).join("\n");
        const prompt =
          "请使用 Remotion 视频技能，根据下列参考图与整体创作要求生成一条竖版短视频。\n\n" +
          "参考图（本地绝对路径，按序号顺序使用）：\n" + imageList + "\n\n" +
          "整体创作要求：\n" + (requirement || "（未提供，按通用品牌风格生成）") + "\n\n" +
          "【重要】画面中不要出现任何文字、标题、字幕、水印或标语（所有文案由后期统一以字幕形式叠加）；" +
          "画面只做纯视觉呈现：照片、图形、色块、渐变与动效，留足画面下方约 1/4 的净空区域给字幕。\n\n" +
          (narrationText
            ? "本视频的旁白文案（画面内容需呼应旁白，节奏与句子对应）：\n" + narrationText + "\n\n"
            : "") +
          (targetDur
            ? `旁白配音时长约 ${targetDur} 秒，请将视频总时长控制在 ${targetDur} 秒左右（±10%），并让每个场景的切换对应旁白句子。\n\n`
            : "") +
          `请将最终渲染成片保存到：${outputAbs}\n` +
          `渲染完成后，请在本条回复的末尾仅以一行格式给出最终视频地址：VIDEO_URL=${outputUrl}`;

        sendProgress(`已上传 ${savedImagePaths.length} 张参考图，正在调用龙虾(OpenClaw) Remotion 技能规划脚本…`);
        const result = await openClawClient.sendTaskStream(prompt, (delta) => {
          controller.enqueue(sseEncode({ type: "delta", text: delta }));
        }, Number(process.env.OPENCLAW_VIDEO_TIMEOUT_MS ?? 1_800_000));

        const rawUrl =
          extractVideoUrl(result.content) ?? (result.content.includes(outputUrl) ? outputUrl : undefined);

        // ---- 4. 后处理：配音+背景音乐 → 字幕 → 片头标题 → 封面 ----
        let finalUrl = rawUrl;
        let coverUrl: string | undefined;
        if (existsSync(outputAbs)) {
          let currentAbs = outputAbs;

          if (audio) {
            const muxedAbs = join(videosDir, `gen-video-${token}-voice.mp4`);
            const mux = await muxNarration(currentAbs, audio.audioPath, muxedAbs, { bgmPath, onProgress: sendProgress });
            if (mux.ok) {
              currentAbs = muxedAbs;
              sendProgress(bgmPath ? "配音与背景音乐已合成进视频" : "配音已合成进视频");
            } else {
              sendProgress(`配音合入失败，保留原声版：${mux.reason}`);
            }
          }

          if (audio && audio.captions.length) {
            const srtPath = join(workDir, "captions.srt");
            const srt = buildSrtFromCaptions(audio.captions, srtPath);
            if (srt.ok) {
              const subAbs = join(videosDir, `gen-video-${token}-sub.mp4`);
              const burn = await burnSubtitles(currentAbs, srtPath, subAbs, sendProgress);
              if (burn.ok) {
                currentAbs = subAbs;
                sendProgress(`字幕已烧录（${srt.cueCount} 句）`);
              } else {
                sendProgress(`字幕烧录失败，保留无字幕版：${burn.reason}`);
              }
            }
          }

          const titleText = videoTitle || narrationText.slice(0, 14);
          if (titleText) {
            const titleAbs = join(videosDir, `gen-video-${token}-title.mp4`);
            const t = await addTitleOverlay(currentAbs, titleText, titleAbs, {
              durationSec: TITLE_SECONDS,
              onProgress: sendProgress,
            });
            if (t.ok) {
              currentAbs = titleAbs;
              sendProgress(`已添加片头标题（前 ${TITLE_SECONDS} 秒展示）`);
            } else {
              sendProgress(`片头标题添加失败：${t.reason}`);
            }
          }

          finalUrl = `/videos/${basename(currentAbs)}`;

          const dur = await probeDuration(currentAbs);
          const at = Math.max(1, Math.min(4, dur * 0.35));
          const coverAbs = join(coverDir, `gen-video-${token}.jpg`);
          const cov = await extractCoverFrame(currentAbs, coverAbs, at);
          if (cov.ok) {
            coverUrl = `/uploads/covers/gen-video-${token}.jpg`;
            sendProgress("已截取视频封面");
          }
        } else if (rawUrl) {
          sendProgress("未定位到本地成片文件，跳过配音/字幕/封面后处理");
        }

        // ---- 5. 落库 ----
        await progressWrite;
        const finalMessage = await prisma.message.update({
          where: { id: progressMessage.id },
          data: {
            content: formatProgressMessage(progress, finalUrl, undefined, narrationText || undefined, videoTitle || undefined),
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
              coverImageUrl: coverUrl ?? null,
              sourceConversationId: conversation.id,
            },
          });
          saved = {
            id: item.id,
            title: item.title,
            category: item.category,
            videoUrl: finalUrl,
            coverImageUrl: coverUrl,
          };
        }
        await prisma.openClawTask.update({
          where: { id: task.id },
          data: {
            status: "SUCCEEDED",
            resultJson: JSON.stringify({
              videoUrl: finalUrl ?? null,
              title: videoTitle || null,
              coverUrl: coverUrl ?? null,
              narration: narrationText || null,
              messageId: finalMessage.id,
              contentId: saved?.id ?? null,
            }),
          },
        });
        controller.enqueue(
          sseEncode({
            type: "final",
            videoUrl: finalUrl ?? null,
            title: videoTitle || null,
            coverUrl: coverUrl ?? null,
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
