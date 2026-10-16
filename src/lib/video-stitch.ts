import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FFMPEG, probeDuration, runTool } from "./ffmpeg";

export const TARGET_W = 1080;
export const TARGET_H = 1920;
export const TARGET_FPS = 30;

export type StitchResult = { ok: true; outputPath: string } | { ok: false; reason: string };

/** 把任意视频/图片归一化为竖版 1080x1920 / 30fps 的 mp4。 */
export async function normalizeToVertical(
  inputPath: string,
  outputPath: string,
  onProgress?: (t: string) => void,
): Promise<StitchResult> {
  if (!existsSync(inputPath)) return { ok: false, reason: `素材不存在：${inputPath}` };
  const isImage = /\.(jpg|jpeg|png|webp)$/i.test(inputPath);
  const vf = `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
  const args = isImage
    ? ["-y", "-loop", "1", "-i", inputPath, "-t", "3", "-vf", vf, "-r", String(TARGET_FPS), "-c:v", "libx264", "-pix_fmt", "yuv420p", outputPath]
    : ["-y", "-i", inputPath, "-vf", vf, "-r", String(TARGET_FPS), "-c:v", "libx264", "-c:a", "aac", outputPath];
  onProgress?.(`正在归一化竖版画面：${inputPath}`);
  const r = await runTool(FFMPEG, args, { timeoutMs: 180000 });
  if (!r.ok || !existsSync(outputPath)) return { ok: false, reason: `竖版归一化失败：${r.stderr.slice(0, 200)}` };
  return { ok: true, outputPath };
}

/**
 * 免费可商用的中文字体（SIL OFL 1.1）。
 *
 * 历史坑：早先用 `C:/Windows/Fonts/msyh.ttc`（微软雅黑），它是**方正授权**字体，
 * 不是免费可商用；回退项 `arial.ttf` 又根本不含中文字形（中文会变成豆腐块）。
 * 现统一改为 Noto Sans SC，且**优先用仓库内的那一份**，
 * 不依赖目标机器装了什么字体 —— 换机器或上服务器都不会静默 fallback。
 */
const FONT_CANDIDATES = [
  join(process.cwd(), "assets", "fonts", "NotoSansSC-VF.ttf"),
  "C:\\Windows\\Fonts\\NotoSansSC-VF.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
];

/** 找到第一个存在的免费字体；全都缺失时返回 null。 */
function resolveFreeFont(): string | null {
  for (const candidate of FONT_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 把 SRT 字幕烧录进视频（Noto Sans SC，SIL OFL 1.1 免费可商用）。 */
export async function burnSubtitles(
  inputPath: string,
  srtPath: string,
  outputPath: string,
  onProgress?: (t: string) => void,
): Promise<StitchResult> {
  if (!existsSync(inputPath)) return { ok: false, reason: `输入不存在：${inputPath}` };
  if (!existsSync(srtPath)) return { ok: false, reason: `字幕文件不存在：${srtPath}` };
  // 字体缺失时不静默 fallback 到版权字体：宁可明确失败，也不要产出有侵权风险的成片
  const resolvedFont = resolveFreeFont();
  if (!resolvedFont) {
    return {
      ok: false,
      reason:
        "未找到免费可商用的中文字体（Noto Sans SC）。请确认 assets/fonts/NotoSansSC-VF.ttf 存在，或安装 Noto Sans SC。",
    };
  }
  // Windows 路径转义：反斜杠→正斜杠，冒号→\:
  const escaped = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const escapedFont = resolvedFont.replace(/\\/g, "/").replace(/:/g, "\\:");
  const fontfile = `fontfile=${escapedFont}`;
  // SRT 样式：56 号常规白字 + 3px 黑描边 + 轻微阴影，底部居中（竖版安全区）。
  const filter = `subtitles='${escaped}':charenc=UTF-8:force_style='${fontfile},PlayResX=1080,PlayResY=1920,FontSize=56,Bold=0,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginL=60,MarginR=60,MarginV=340'`;
  onProgress?.("正在烧录字幕...");
  const r = await runTool(FFMPEG, [
    "-y", "-i", inputPath, "-vf", filter,
    "-c:v", "libx264", "-preset", "medium", "-c:a", "copy", outputPath,
  ], { timeoutMs: 240000 });
  if (!r.ok || !existsSync(outputPath)) return { ok: false, reason: `字幕烧录失败：${r.stderr.slice(0, 200)}` };
  return { ok: true, outputPath };
}

/**
 * 多段拼接：把所有片段归一化为竖版后按 concat demuxer 合并。
 * clips 为原始素材路径（视频或图片均可），单段时直接转码为竖版。
 */
export async function concatVideoClips(
  clips: string[],
  outputPath: string,
  opts: { onProgress?: (t: string) => void } = {},
): Promise<StitchResult> {
  const valid = clips.filter((c) => existsSync(c));
  if (valid.length === 0) return { ok: false, reason: "没有可拼接的视频片段" };
  const dir = dirname(outputPath);

  if (valid.length === 1) {
    return normalizeToVertical(valid[0], outputPath, opts.onProgress);
  }

  const parts: string[] = [];
  for (let i = 0; i < valid.length; i++) {
    const part = join(dir, `part-${i}.mp4`);
    const r = await normalizeToVertical(valid[i], part, opts.onProgress);
    if (r.ok) parts.push(part);
  }
  if (parts.length === 0) return { ok: false, reason: "所有片段归一化失败" };

  const listPath = join(dir, `concat-list-${Date.now()}.txt`);
  writeFileSync(listPath, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"), "utf-8");
  opts.onProgress?.(`正在拼接 ${parts.length} 段素材...`);
  const r = await runTool(FFMPEG, [
    "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath,
  ], { timeoutMs: 300000 });
  if (!r.ok || !existsSync(outputPath)) return { ok: false, reason: `拼接失败：${r.stderr.slice(0, 200)}` };
  return { ok: true, outputPath };
}

function fmtSrtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}

/** 1080 宽、56 号字、左右边距 60 时，单行 14 字不溢出画面。 */
const MAX_CHARS_PER_LINE = 14;

/** 把一句话按字数折成多行（SRT 用 \n 换行），避免长句超出竖版画面。 */
function wrapSubtitleText(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, ""));
  if (chars.length <= MAX_CHARS_PER_LINE) return chars.join("");
  const lines: string[] = [];
  for (let i = 0; i < chars.length; i += MAX_CHARS_PER_LINE) {
    lines.push(chars.slice(i, i + MAX_CHARS_PER_LINE).join(""));
  }
  return lines.join("\n");
}

/** 用 TTS 返回的句级时间戳生成 SRT 字幕文件（标准整句样式）。 */
export function buildSrtFromCaptions(
  captions: { word: string; startMs: number; endMs: number }[],
  srtPath: string
): { ok: boolean; cueCount: number } {
  const cues = captions.filter((c) => c.word && c.word.trim() && c.endMs > c.startMs);
  if (!cues.length) return { ok: false, cueCount: 0 };
  const blocks = cues.map((c, i) => {
    const text = wrapSubtitleText(c.word.trim());
    return `${i + 1}\n${fmtSrtTime(c.startMs / 1000)} --> ${fmtSrtTime(c.endMs / 1000)}\n${text}\n`;
  });
  writeFileSync(srtPath, blocks.join("\n"), "utf-8");
  return { ok: true, cueCount: cues.length };
}

/**
 * 用最后一帧把视频延长 extraSeconds 秒（tpad stop_mode=clone）。
 * 用于画面短于旁白时补齐，避免出现"画面结束但口播还在播"的空档。
 */
export async function padVideoToDuration(
  inputPath: string,
  outputPath: string,
  extraSeconds: number,
  onProgress?: (t: string) => void,
): Promise<StitchResult> {
  if (!existsSync(inputPath)) return { ok: false, reason: `输入不存在：${inputPath}` };
  if (!(extraSeconds > 0)) return { ok: false, reason: "无需延长" };
  onProgress?.(`正在延长画面 ${extraSeconds.toFixed(1)} 秒以对齐口播...`);
  const r = await runTool(FFMPEG, [
    "-y", "-i", inputPath,
    "-vf", `tpad=stop_mode=clone:stop_duration=${extraSeconds.toFixed(2)}`,
    "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-c:a", "copy", outputPath,
  ], { timeoutMs: 300000 });
  if (!r.ok || !existsSync(outputPath)) {
    return { ok: false, reason: `画面延长失败：${r.stderr.slice(0, 160)}` };
  }
  return { ok: true, outputPath };
}

/**
 * 把旁白配音混入视频：
 * - 配音比视频长 → 视频最后一帧定格延长到配音长度（保证旁白完整）；
 * - 配音比视频短 → 音频补静音到视频长度。
 */
export async function muxNarration(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  opts: { bgmPath?: string; bgmVolume?: number; onProgress?: (t: string) => void } = {}
): Promise<StitchResult> {
  const { bgmPath, bgmVolume = 0.16, onProgress } = opts;
  if (!existsSync(videoPath)) return { ok: false, reason: `视频不存在：${videoPath}` };
  if (!existsSync(audioPath)) return { ok: false, reason: `配音不存在：${audioPath}` };
  const vDur = await probeDuration(videoPath);
  const aDur = await probeDuration(audioPath);
  const bgmOk = !!bgmPath && existsSync(bgmPath);
  onProgress?.(
    `正在合成配音${bgmOk ? " + 背景音乐" : ""}（画面 ${vDur.toFixed(1)}s / 配音 ${aDur.toFixed(1)}s）...`
  );

  const extend = aDur > vDur + 0.2;
  const inputs = ["-i", videoPath, "-i", audioPath];
  if (bgmOk) inputs.push("-stream_loop", "-1", "-i", bgmPath as string);

  const filters: string[] = [];
  if (extend) {
    const extra = (aDur - vDur + 0.3).toFixed(2);
    filters.push(`[0:v]tpad=stop_mode=clone:stop_duration=${extra}[v]`);
  }
  if (bgmOk) {
    // 配音补静音 + 背景音乐循环降音量，两者混合；时长以视频（-shortest）为准。
    filters.push(
      "[1:a]apad[v1]",
      `[2:a]volume=${bgmVolume}[b1]`,
      "[v1][b1]amix=inputs=2:duration=longest:dropout_transition=0[a]"
    );
  } else {
    filters.push("[1:a]apad[a]");
  }

  const args = [
    "-y", ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", extend ? "[v]" : "0:v", "-map", "[a]",
    ...(extend ? ["-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p"] : ["-c:v", "copy"]),
    "-c:a", "aac", "-b:a", "192k", "-shortest", outputPath,
  ];
  const r = await runTool(FFMPEG, args, { timeoutMs: 300_000 });
  if (!r.ok || !existsSync(outputPath)) return { ok: false, reason: `配音合成失败：${r.stderr.slice(0, 200)}` };
  return { ok: true, outputPath };
}

/**
 * 在视频前 N 秒叠加标题（片头标题卡）：半透明底 + 白色大标题，居中偏上。
 * 通过 drawtext 的 textfile 读取标题，避免中文/标点转义问题。
 */
export async function addTitleOverlay(
  inputPath: string,
  title: string,
  outputPath: string,
  opts: { durationSec?: number; onProgress?: (t: string) => void } = {}
): Promise<StitchResult> {
  if (!existsSync(inputPath)) return { ok: false, reason: `输入不存在：${inputPath}` };
  const clean = title.replace(/\r?\n/g, " ").trim();
  if (!clean) return { ok: true, outputPath: inputPath };
  const dur = opts.durationSec ?? 3;

  const titleFile = join(dirname(outputPath), `title-${Date.now()}.txt`);
  writeFileSync(titleFile, clean, "utf-8");
  const escTxt = titleFile.replace(/\\/g, "/").replace(/:/g, "\\:");
  // 与 burnSubtitles 同一套免费字体（Noto Sans SC，SIL OFL 1.1）
  const resolvedFont = resolveFreeFont();
  if (!resolvedFont) {
    return {
      ok: false,
      reason:
        "未找到免费可商用的中文字体（Noto Sans SC）。请确认 assets/fonts/NotoSansSC-VF.ttf 存在，或安装 Noto Sans SC。",
    };
  }
  const fontfile = resolvedFont.replace(/\\/g, "/").replace(/:/g, "\\:");

  const filter =
    `drawtext=fontfile='${fontfile}':textfile='${escTxt}':` +
    `fontsize=76:fontcolor=white:borderw=6:bordercolor=black@0.85:` +
    `box=1:boxcolor=black@0.35:boxborderw=34:` +
    `x=(w-text_w)/2:y=h*0.26:enable='lt(t\\,${dur})'`;

  opts.onProgress?.(`正在添加片头标题（前 ${dur}s）...`);
  const r = await runTool(
    FFMPEG,
    ["-y", "-i", inputPath, "-vf", filter, "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "copy", outputPath],
    { timeoutMs: 300_000 }
  );
  if (!r.ok || !existsSync(outputPath)) return { ok: false, reason: `片头标题叠加失败：${r.stderr.slice(0, 200)}` };
  return { ok: true, outputPath };
}

/** 从视频某一时间点截取一帧作为封面（JPEG）。 */
export async function extractCoverFrame(
  inputPath: string,
  outputPath: string,
  atSec: number
): Promise<StitchResult> {
  if (!existsSync(inputPath)) return { ok: false, reason: `输入不存在：${inputPath}` };
  const r = await runTool(
    FFMPEG,
    ["-y", "-ss", atSec.toFixed(2), "-i", inputPath, "-frames:v", "1", "-q:v", "2", outputPath],
    { timeoutMs: 60_000 }
  );
  if (!r.ok || !existsSync(outputPath)) return { ok: false, reason: `封面截图失败：${r.stderr.slice(0, 150)}` };
  return { ok: true, outputPath };
}
