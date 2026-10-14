/**
 * 内容 → 竖版短视频生成（可复用核心）。
 *
 * 从「对话内一键生成视频」链路抽取而来：旁白文案 → TTS 女声配音 →
 * OpenClaw(Remotion) 渲染画面 → 配音/背景乐合成 → 字幕烧录 → 片头标题 → 截封面。
 *
 * 定时任务产出的「视频」类内容条目直接调本模块，拿到真实 MP4（而不是只留一段文案脚本）。
 * 参考图通常就是内容条目的封面图；需要先把图片复制到 OpenClaw agent 的工作区，
 * 否则渲染时会报 "Local media path is not under an allowed directory"。
 */
import { openClawClient } from "@/lib/openclaw";
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
import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import os from "node:os";

/** 片头标题展示时长（秒） */
const TITLE_SECONDS = 3;

export type GenerateContentVideoInput = {
  /** 归属用户（决定 OpenClaw 会话路由） */
  userId: string;
  /** 内容标题 */
  title: string;
  /** 内容正文（用作创作要求的主体） */
  body: string;
  /** 参考图绝对路径（通常为条目封面；至少一张） */
  imagePaths: string[];
  /** 目标成片时长（秒）；缺省由旁白长度自然决定 */
  targetSeconds?: number;
  /** 进度回调（可选，用于写日志/推送状态） */
  onProgress?: (text: string) => void;
};

export type GenerateContentVideoResult = {
  ok: boolean;
  /** 成片地址（/videos/xxx.mp4） */
  videoUrl?: string;
  /** 视频封面地址（/uploads/covers/xxx.jpg） */
  coverUrl?: string;
  /** 视频标题（LLM 生成） */
  videoTitle?: string;
  /** 旁白全文 */
  narration?: string;
  /** 失败原因 */
  reason?: string;
};

/** 从 OpenClaw 返回文本里提取成片 URL */
function extractVideoUrl(text: string, fallbackUrl: string): string | undefined {
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
  return text.includes(fallbackUrl) ? fallbackUrl : undefined;
}

/** 从 public/audio/bgm 选一首温暖治愈风格的背景音乐 */
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

/**
 * 生成一条短视频。全程不抛异常：任何环节失败都返回 { ok:false, reason }，
 * 让调用方（入库链路）自行决定如何处理（保持内容条目不受影响）。
 */
export async function generateContentVideo(
  input: GenerateContentVideoInput
): Promise<GenerateContentVideoResult> {
  const report = (text: string) => {
    try {
      input.onProgress?.(text);
    } catch {
      /* 进度回调失败不影响主流程 */
    }
  };
  const imagePaths = input.imagePaths.filter((p) => p && existsSync(p));
  if (!imagePaths.length) {
    return { ok: false, reason: "没有可用的参考图（封面未就绪）" };
  }

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const videosDir = join(process.cwd(), "public", "videos");
  const workDir = join(process.cwd(), "public", "uploads", "gen-video", token);
  const coverDir = join(process.cwd(), "public", "uploads", "covers");
  await Promise.all([
    mkdir(videosDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
    mkdir(coverDir, { recursive: true }),
  ]);

  // 参考图复制一份到 OpenClaw agent 工作区（其媒体读取白名单目录）
  let agentImagePaths = imagePaths;
  try {
    const wsDir = join(os.homedir(), ".openclaw", "workspace", "remotion-refs", token);
    await mkdir(wsDir, { recursive: true });
    const copied: string[] = [];
    for (let i = 0; i < imagePaths.length; i++) {
      const dest = join(wsDir, `ref-${i}${imagePaths[i].slice(imagePaths[i].lastIndexOf("."))}`);
      await copyFile(imagePaths[i], dest);
      copied.push(dest);
    }
    if (copied.length === imagePaths.length) agentImagePaths = copied;
  } catch {
    // 复制失败则回退到原路径（可能在白名单外，由渲染端决定成败）
  }

  const outputName = `content-video-${token}.mp4`;
  const outputAbs = join(videosDir, outputName);
  const outputUrl = `/videos/${outputName}`;
  const bgmPath = pickBgm();

  const requirement = [
    input.title,
    input.body,
    input.targetSeconds ? `（本条视频目标时长约 ${input.targetSeconds} 秒，旁白文案请控制在这个长度）` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4000);

  try {
    // ---- 1. 旁白文案 + 标题 ----
    report("正在生成标题与旁白文案…");
    const script = await generateNarrationScript(requirement, agentImagePaths.length);
    const narrationText = script?.fullText ?? "";
    const videoTitle = script?.title ?? input.title.slice(0, 30);

    // ---- 2. 女声配音 ----
    let audio: {
      audioPath: string;
      durationSeconds: number;
      captions: { word: string; startMs: number; endMs: number }[];
    } | null = null;
    if (narrationText) {
      try {
        const tts = await synthesizeNarration(narrationText, workDir);
        audio = { audioPath: tts.audioPath, durationSeconds: tts.durationSeconds, captions: tts.captions };
        report(`配音合成完成（约 ${tts.durationSeconds.toFixed(1)} 秒）`);
      } catch (error) {
        report(`配音合成失败，将生成无配音版本：${error instanceof Error ? error.message : "未知错误"}`);
      }
    }

    // ---- 3. 调用 OpenClaw(Remotion) 渲染画面 ----
    const targetDur = audio ? Math.round(audio.durationSeconds) : 0;
    const imageList = agentImagePaths.map((p, i) => `${i + 1}. ${p}`).join("\n");
    const prompt =
      "请使用 Remotion 视频技能，根据下列参考图与整体创作要求生成一条竖版短视频。\n\n" +
      "参考图（本地绝对路径，按序号顺序使用）：\n" + imageList + "\n\n" +
      "整体创作要求：\n" + requirement + "\n\n" +
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

    report("正在调用 OpenClaw Remotion 技能渲染画面…");
    const result = await openClawClient.sendTaskStream(
      { message: prompt, prompt, userId: input.userId },
      () => {}
    );
    const rawUrl = extractVideoUrl(result.content, outputUrl);

    if (!existsSync(outputAbs)) {
      return {
        ok: false,
        reason: rawUrl ? "渲染进程未在本地生成成片文件" : "未收到成片地址（Remotion 渲染可能失败）",
      };
    }

    // ---- 4. 后处理：配音+背景乐 → 字幕 → 片头标题 → 封面 ----
    let currentAbs = outputAbs;
    if (audio) {
      const muxedAbs = join(videosDir, `content-video-${token}-voice.mp4`);
      const mux = await muxNarration(currentAbs, audio.audioPath, muxedAbs, { bgmPath, onProgress: report });
      if (mux.ok) {
        currentAbs = muxedAbs;
        report(bgmPath ? "配音与背景音乐已合成" : "配音已合成");
      } else {
        report(`配音合入失败，保留原声版：${mux.reason}`);
      }
    }

    if (audio && audio.captions.length) {
      const srtPath = join(workDir, "captions.srt");
      const srt = buildSrtFromCaptions(audio.captions, srtPath);
      if (srt.ok) {
        const subAbs = join(videosDir, `content-video-${token}-sub.mp4`);
        const burn = await burnSubtitles(currentAbs, srtPath, subAbs, report);
        if (burn.ok) {
          currentAbs = subAbs;
          report(`字幕已烧录（${srt.cueCount} 句）`);
        } else {
          report(`字幕烧录失败：${burn.reason}`);
        }
      }
    }

    const titleText = (videoTitle || input.title).slice(0, 20);
    if (titleText) {
      const titleAbs = join(videosDir, `content-video-${token}-title.mp4`);
      const t = await addTitleOverlay(currentAbs, titleText, titleAbs, {
        durationSec: TITLE_SECONDS,
        onProgress: report,
      });
      if (t.ok) {
        currentAbs = titleAbs;
        report(`已添加片头标题`);
      } else {
        report(`片头标题添加失败：${t.reason}`);
      }
    }

    const finalUrl = `/videos/${basename(currentAbs)}`;
    let coverUrl: string | undefined;
    const dur = await probeDuration(currentAbs);
    const at = Math.max(1, Math.min(4, dur * 0.35));
    const coverAbs = join(coverDir, `content-video-${token}.jpg`);
    const cov = await extractCoverFrame(currentAbs, coverAbs, at);
    if (cov.ok) coverUrl = `/uploads/covers/content-video-${token}.jpg`;

    return { ok: true, videoUrl: finalUrl, coverUrl, videoTitle, narration: narrationText };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "视频生成失败" };
  }
}
