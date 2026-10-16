import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCapabilityConfig, type ResolvedModelConfig } from "./model-credentials";

const API_BASE_URL = "https://gen.pollinations.ai";

function getDuration(): number {
  const value = Number(process.env.TEXT_TO_VIDEO_DURATION ?? 5);
  return Number.isFinite(value) ? Math.max(2, Math.min(10, Math.round(value))) : 5;
}

export type TextToVideoOptions = {
  /** 归属用户：密钥与模型从该用户的「文生视频」能力分配里取。 */
  userId?: string;
  /** 长任务可传入 snapshotUserConfig 的一次性快照。 */
  config?: ResolvedModelConfig | null;
};

export async function generateVideoFromText(
  prompt: string,
  outputDirectory: string,
  options: TextToVideoOptions = {}
): Promise<string> {
  const config =
    options.config !== undefined
      ? options.config
      : options.userId
        ? await resolveCapabilityConfig(options.userId, "video")
        : null;

  if (!config) {
    throw new Error(
      "尚未指定「文生视频」使用哪个模型服务，请前往「系统配置 → 默认模型分配」选择并填写 API Key。"
    );
  }
  if (!config.apiKey) {
    throw new Error(`「${config.label}」没有可用的 API Key，请在「系统配置」中重新填写。`);
  }

  const apiBase = (config.baseUrl.trim() || API_BASE_URL).replace(/\/+$/, "");
  const model = config.model || process.env.TEXT_TO_VIDEO_MODEL?.trim() || "wan-fast";
  const aspectRatio = process.env.TEXT_TO_VIDEO_ASPECT_RATIO?.trim() || "16:9";
  const videoPrompt = [prompt.trim(), "Create a coherent, cinematic moving video. Natural motion, stable subjects, no text overlays, no subtitles, no still-image slideshow."].join("\n\n");
  const params = new URLSearchParams({ model, duration: String(getDuration()), aspectRatio, audio: "false", seed: "-1", key: config.apiKey });
  const response = await fetch(`${apiBase}/video/${encodeURIComponent(videoPrompt)}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 240);
    if (response.status === 401 || response.status === 403) {
      throw new Error(`「${config.label}」拒绝了该密钥，请在「系统配置」中检查文生视频模型的 API Key。`);
    }
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
