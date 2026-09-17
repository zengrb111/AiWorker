import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API_BASE_URL = "https://gen.pollinations.ai";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`未配置 ${name}，无法生成 AI 视频。请在 .env.local 中填写该配置后重试。`);
  return value;
}

function getDuration(): number {
  const value = Number(process.env.TEXT_TO_VIDEO_DURATION ?? 5);
  return Number.isFinite(value) ? Math.max(2, Math.min(10, Math.round(value))) : 5;
}

export async function generateVideoFromText(prompt: string, outputDirectory: string): Promise<string> {
  const apiKey = requiredEnv("POLLINATIONS_API_KEY");
  const model = process.env.TEXT_TO_VIDEO_MODEL?.trim() || "wan-fast";
  const aspectRatio = process.env.TEXT_TO_VIDEO_ASPECT_RATIO?.trim() || "16:9";
  const videoPrompt = [prompt.trim(), "Create a coherent, cinematic moving video. Natural motion, stable subjects, no text overlays, no subtitles, no still-image slideshow."].join("\n\n");
  const params = new URLSearchParams({ model, duration: String(getDuration()), aspectRatio, audio: "false", seed: "-1" });
  const response = await fetch(`${API_BASE_URL}/video/${encodeURIComponent(videoPrompt)}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 240);
    throw new Error(`文字生视频服务请求失败（${response.status}）：${detail || response.statusText}`);
  }
  if (!(response.headers.get("content-type") || "").includes("video")) throw new Error("文字生视频服务没有返回视频文件，请检查模型配置和账户额度。");
  const video = Buffer.from(await response.arrayBuffer());
  if (video.length < 10000) throw new Error("文字生视频服务返回的视频文件无效，请稍后重试。");
  if (!existsSync(outputDirectory)) mkdirSync(outputDirectory, { recursive: true });
  const fileName = `video-${Date.now()}.mp4`;
  writeFileSync(join(outputDirectory, fileName), video);
  return `/videos/${fileName}`;
}