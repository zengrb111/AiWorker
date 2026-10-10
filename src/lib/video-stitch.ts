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

/** 把 SRT 字幕烧录进视频（中文字体回退到微软雅黑）。 */
export async function burnSubtitles(
  inputPath: string,
  srtPath: string,
  outputPath: string,
  onProgress?: (t: string) => void,
): Promise<StitchResult> {
  if (!existsSync(inputPath)) return { ok: false, reason: `输入不存在：${inputPath}` };
  if (!existsSync(srtPath)) return { ok: false, reason: `字幕文件不存在：${srtPath}` };
  // Windows 路径转义：反斜杠→正斜杠，冒号→\:
  const escaped = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const fontfile = existsSync("C:/Windows/Fonts/msyh.ttc")
    ? "fontfile=C\\:/Windows/Fonts/msyh.ttc"
    : "fontfile=C\\:/Windows/Fonts/arial.ttf";
  const filter = `subtitles='${escaped}':charenc=UTF-8:force_style='${fontfile},FontSize=20,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=2,Alignment=2,MarginV=64'`;
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

/** 用 TTS 返回的句级时间戳生成 SRT 字幕文件。 */
export function buildSrtFromCaptions(
  captions: { word: string; startMs: number; endMs: number }[],
  srtPath: string
): { ok: boolean; cueCount: number } {
  const cues = captions.filter((c) => c.word && c.word.trim() && c.endMs > c.startMs);
  if (!cues.length) return { ok: false, cueCount: 0 };
  const blocks = cues.map((c, i) => {
    const text = c.word.replace(/\r?\n/g, " ").trim();
    return `${i + 1}\n${fmtSrtTime(c.startMs / 1000)} --> ${fmtSrtTime(c.endMs / 1000)}\n${text}\n`;
  });
  writeFileSync(srtPath, blocks.join("\n"), "utf-8");
  return { ok: true, cueCount: cues.length };
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
  onProgress?: (t: string) => void
): Promise<StitchResult> {
  if (!existsSync(videoPath)) return { ok: false, reason: `视频不存在：${videoPath}` };
  if (!existsSync(audioPath)) return { ok: false, reason: `配音不存在：${audioPath}` };
  const vDur = await probeDuration(videoPath);
  const aDur = await probeDuration(audioPath);
  onProgress?.(`正在合成配音（画面 ${vDur.toFixed(1)}s / 配音 ${aDur.toFixed(1)}s）...`);

  let args: string[];
  if (aDur > vDur + 0.2) {
    const extra = (aDur - vDur + 0.3).toFixed(2);
    args = [
      "-y", "-i", videoPath, "-i", audioPath,
      "-filter_complex", `[0:v]tpad=stop_mode=clone:stop_duration=${extra}[v]`,
      "-map", "[v]", "-map", "1:a",
      "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-shortest", outputPath,
    ];
  } else {
    args = [
      "-y", "-i", videoPath, "-i", audioPath,
      "-filter_complex", "[1:a]apad[a]",
      "-map", "0:v", "-map", "[a]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", outputPath,
    ];
  }
  const r = await runTool(FFMPEG, args, { timeoutMs: 300_000 });
  if (!r.ok || !existsSync(outputPath)) return { ok: false, reason: `配音合成失败：${r.stderr.slice(0, 200)}` };
  return { ok: true, outputPath };
}
