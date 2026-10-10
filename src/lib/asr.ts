import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FFMPEG, probeDuration, runTool } from "./ffmpeg";

/** 语音识别模型，默认智谱 glm-asr-2512；可用 ASR_MODEL 覆盖。 */
const MODEL = (process.env.ASR_MODEL || "glm-asr-2512").trim();
/** 单段时长（秒）：长视频先切片再逐段转写，避免单次请求过长。 */
const SEGMENT_SECONDS = 26;
/** 竖版成片目标规格。 */
export const TARGET_W = 1080;
export const TARGET_H = 1920;
export const TARGET_FPS = 30;

export type SrtResult = { ok: true; srtPath: string; cueCount: number } | { ok: false; reason: string };

interface Cue { start: number; end: number; text: string; }

/**
 * 把视频转写成 SRT 字幕：
 * 1. ffmpeg 按 SEGMENT_SECONDS 切片并抽取 16k 单声道 wav；
 * 2. 逐段调用智谱 GLM-ASR（glm-asr-2512）识别；
 * 3. 按时间轴合并为 SRT 写到 speechDir/captions.srt。
 * 任意一段失败都会跳过，整段无结果时返回 ok:false（调用方据此降级为无字幕版本）。
 */
export async function transcribeVideoToSrt(
  inputPath: string,
  speechDir: string,
  sendProgress?: (text: string) => void,
): Promise<SrtResult> {
  if (!existsSync(inputPath)) return { ok: false, reason: "输入视频不存在" };
  mkdirSync(speechDir, { recursive: true });

  const duration = await probeDurationSafe(inputPath);
  const segCount = Math.max(1, Math.ceil(duration / SEGMENT_SECONDS));

  const segs: { path: string; start: number; end: number }[] = [];
  for (let i = 0; i < segCount; i++) {
    const start = i * SEGMENT_SECONDS;
    const end = Math.min((i + 1) * SEGMENT_SECONDS, duration || (i + 1) * SEGMENT_SECONDS);
    const audioPath = join(speechDir, `seg-${i}.wav`);
    const r = await runTool(FFMPEG, [
      "-y", "-ss", String(start), "-t", String(SEGMENT_SECONDS),
      "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", audioPath,
    ]);
    if (!r.ok || !existsSync(audioPath)) {
      sendProgress?.(`第 ${i + 1} 段音频提取失败，跳过`);
      continue;
    }
    segs.push({ path: audioPath, start, end });
  }
  if (segs.length === 0) return { ok: false, reason: "无法从视频提取音频" };

  const key = process.env.ZHIPU_API_KEY;
  if (!key) {
    return { ok: false, reason: "未配置 ZHIPU_API_KEY，无法调用语音识别" };
  }

  const cues: Cue[] = [];
  for (let i = 0; i < segs.length; i++) {
    sendProgress?.(`正在识别第 ${i + 1}/${segs.length} 段语音...`);
    const text = await recognizeWithZhipu(segs[i].path, key);
    if (text && text.trim()) cues.push({ start: segs[i].start, end: segs[i].end, text: text.trim() });
  }
  if (cues.length === 0) return { ok: false, reason: "智谱 ASR 未返回识别结果（请检查 ZHIPU_API_KEY 与接口可用性）" };

  const srtPath = join(speechDir, "captions.srt");
  writeSrt(srtPath, cues);
  return { ok: true, srtPath, cueCount: cues.length };
}

async function probeDurationSafe(path: string): Promise<number> {
  return probeDuration(path);
}

/**
 * 调用智谱 GLM-ASR：上传音频文件 → 轮询查询结果。
 * 接口路径以智谱官方文档为准；此处为通用实现，失败返回 null 由上层降级。
 */
async function recognizeWithZhipu(audioPath: string, apiKey: string): Promise<string | null> {
  try {
    const base = "https://open.bigmodel.cn/api/paas/v4/files";
    const body = readFileSync(audioPath);
    const form = new FormData();
    form.append("file", new Blob([body], { type: "audio/wav" }), "seg.wav");
    form.append("purpose", "file-extract");

    const up = await fetch(base, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form });
    if (!up.ok) return null;
    const upJson = (await up.json().catch(() => null)) as { id?: string } | null;
    const fileId = upJson?.id;
    if (!fileId) return null;

    // 轮询转写结果（GLM-ASR 为异步任务）
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      const q = await fetch(`${base}/${encodeURIComponent(fileId)}/content`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!q.ok) {
        // 某些版本用 POST /query
        const q2 = await fetch(`${base}/${encodeURIComponent(fileId)}/query`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: MODEL }),
        });
        if (!q2.ok) continue;
        const j2 = (await q2.json().catch(() => null)) as any;
        const text = extractText(j2);
        if (text) return text;
        continue;
      }
      const j = (await q.json().catch(() => null)) as any;
      const text = extractText(j);
      if (text) return text;
    }
    return null;
  } catch {
    return null;
  }
}

/** 从智谱文件查询响应里尽量取出转写文本。 */
function extractText(j: any): string | null {
  if (!j) return null;
  if (typeof j === "string") return j;
  if (typeof j.content === "string" && j.content) return j.content;
  if (typeof j.text === "string" && j.text) return j.text;
  if (Array.isArray(j.choices) && j.choices[0]?.message?.content) return String(j.choices[0].message.content);
  if (typeof j.data?.content === "string") return j.data.content;
  return null;
}

function fmtSrtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}

function writeSrt(srtPath: string, cues: Cue[]): void {
  const blocks = cues.map((c, i) => {
    const text = c.text.replace(/\r?\n/g, " ");
    return `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${text}\n`;
  });
  writeFileSync(srtPath, blocks.join("\n"), "utf-8");
}
