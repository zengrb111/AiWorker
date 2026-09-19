/**
 * Image generation utility.
 *
 * Primary: Zhipu CogView-4 (https://open.bigmodel.cn) — the generated image is
 * downloaded and stored locally under public/uploads/covers/, so the DB only
 * ever keeps a stable local path (no dependency on expiring remote URLs).
 *
 * Fallback: pollinations.ai free URL API (kept for resilience when the Zhipu
 * call fails — returns a remote URL that is generated on demand).
 */

import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY ?? "";
const ZHIPU_IMAGE_MODEL = process.env.ZHIPU_IMAGE_MODEL ?? "cogview-4-250304";
const ZHIPU_IMAGE_API = "https://open.bigmodel.cn/api/paas/v4/images/generations";

/** Local storage directory for generated covers / inline images. */
export const LOCAL_IMAGES_DIR = path.join(process.cwd(), "public", "uploads", "covers");

/**
 * Clean text for use as an image prompt:
 * - remove markdown symbols
 * - remove quotes/apostrophes
 * - collapse whitespace
 */
function sanitizePrompt(text: string): string {
  return text
    .replace(/[''""]/g, "")
    .replace(/[*#`>_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect agent tool-call / reasoning narration that leaked into the message
 * content (e.g. "I'll write a post... Let me grab some grounding first.").
 * These lines are meaningless as image prompts and often break the API.
 */
function isReasoningNoise(line: string): boolean {
  return /(i'll|i will|let me|let's|ok,|sure,|bing|google|搜索结果|返回的结果|跑偏|抓到|先看|再试|grounding|actually|hmm|wait[,．.])/i.test(line);
}

// ---------------------------------------------------------------------------
// 平台调性：小红书封面要「爆款笔记」的钩子感，公众号封面要「专业文章」的质感
// ---------------------------------------------------------------------------

export type CoverPlatform = "xhs" | "wechat";

/** 从内容分类标签推断封面所属平台。 */
export function coverPlatformOf(category?: string | null): CoverPlatform {
  return /小红书|小红薯|种草|xhs/i.test(category ?? "") ? "xhs" : "wechat";
}

/**
 * 封面尺寸：小红书按平台标准出 3:4 竖版（下载即可直接发布），
 * 公众号出 16:10 横版（与内容库卡片展示比例一致）。
 */
export function coverSizeOf(platform: CoverPlatform): { width: number; height: number } {
  return platform === "xhs" ? { width: 1152, height: 1536 } : { width: 1280, height: 800 };
}

type PlatformVisual = {
  /** 构图语言 */
  layout: string;
  /** 配色倾向 */
  palette: string;
  /** 氛围与设计手法 */
  mood: string;
  /** 明确要规避的方向 */
  avoid: string;
};

const PLATFORM_VISUAL: Record<CoverPlatform, PlatformVisual> = {
  xhs: {
    layout:
      "竖版满幅构图，视觉主体超大特写并居中，画面上方或下方保留大面积干净的净空区域（纯色或虚化背景）",
    palette:
      "高饱和撞色（如玫红×明黄、克莱因蓝×橙、荧光绿×黑），明快通透、亮度高、对比强烈",
    mood:
      "爆款笔记主视觉的钩子感：夸张、有戏剧性、情绪外放，一眼就想点开；可加入几何色块、撞色描边、贴纸式元素强化设计感",
    avoid: "避免暗沉色调、性冷淡风、商务感、灰蒙蒙的滤镜，以及平淡无奇的中景构图"
  },
  wechat: {
    layout:
      "横版构图，主体明确、或居中或偏置，四周讲究留白与呼吸感，画面一侧保留干净的净空区域",
    palette:
      "高级质感配色（深蓝×金、墨绿×米白、暗红×暖灰），层次丰富、明暗对比讲究、色彩克制",
    mood:
      "专业级的视觉隐喻：克制但有张力，像高端商业品牌的视觉大片，有观点感和权威感",
    avoid: "避免廉价素材感、花哨堆砌、过度卡通化、元素杂乱无主次"
  }
};


/**
 * 从正文里提炼 2~3 个核心观点，供标题图 prompt 使用。
 * 优先取小标题 / 加粗短语（作者提炼过、信息密度高），不够再退回正文关键句。
 */
function extractKeyPoints(body: string, maxPoints = 3): string[] {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const points: string[] = [];

  const pushPoint = (raw: string) => {
    if (points.length >= maxPoints) return;
    const clean = sanitizePrompt(raw)
      .replace(/^[\d一二三四五六七八九十]+[.、．)）]\s*/, "")
      .replace(/[：:。，,；;！!]$/, "")
      .trim();
    if (clean.length >= 6 && clean.length <= 48 && !points.includes(clean)) {
      points.push(clean);
    }
  };

  // 1) 小标题 / 加粗小标题
  for (const line of lines) {
    if (points.length >= maxPoints) break;
    const heading = line.match(/^#{2,4}\s+(.+)$/);
    if (heading) {
      pushPoint(heading[1]);
      continue;
    }
    const bold = line.match(/^\*\*(.+?)\*\*/);
    if (bold) pushPoint(bold[1]);
  }

  // 2) 兜底：正文每行的首个句子
  if (points.length < maxPoints) {
    for (const line of lines) {
      if (points.length >= maxPoints) break;
      if (line.startsWith("#") || isReasoningNoise(line)) continue;
      pushPoint(line.split(/[。！？!?]/)[0]);
    }
  }

  return points.slice(0, maxPoints);
}

/**
 * 标题图（封面）prompt，按平台调性区分。
 *
 * 三个要点：
 * 1. 不能只用标题 —— 必须把文章**核心观点**一起给模型，否则画面与内容脱节；
 * 2. 构图 / 配色 / 氛围要按平台给足指令，否则小红书和公众号会长得一模一样；
 * 3. 智谱 CogView-4 是中文模型，中文 prompt 的语义对齐明显好于英文。
 */
function buildCoverPrompt(title: string, body: string, platform: CoverPlatform): string {
  const keyPoints = extractKeyPoints(body);
  const headline = sanitizePrompt(title).slice(0, 60) || keyPoints[0] || "AI 数字员工";
  const style = PLATFORM_VISUAL[platform];
  // 用「主视觉图」而不是「封面/海报」：后两者会触发模型的排版模式，
  // 让它自作主张画标题文字，而 AI 生成的中文字基本必有错字。
  const label = platform === "xhs" ? "小红书竖版主视觉图" : "微信公众号横版主视觉图";

  return [
    `为下面这篇文章生成一张高冲击力的${label}。`,
    "画面必须是纯图像，绝对不能出现任何文字、字母、数字、标语、字幕或水印（如需体现标题感，只用抽象的色块或线条暗示）。",
    `文章标题：${headline}。`,
    keyPoints.length ? `文章核心观点：${keyPoints.join("；")}。` : "",
    "画面内容：把标题与核心观点转译成一个强有力的视觉主体，第一眼就抓住注意力。",
    `构图：${style.layout}。`,
    `配色：${style.palette}。`,
    `氛围与手法：${style.mood}。`,
    `${style.avoid}。`,
    "整体要求：商业大片级质感、电影级光影、层次分明、主体清晰锐利。",
    "再次强调：画面中不得出现任何可识别的字符。"
  ]
    .filter(Boolean)
    .join("");
}

function buildPromptFromContent(title: string, body: string): string {
  // Prefer the article title — it is extracted from markdown headings and is
  // clean and descriptive. Body first line is only a fallback.
  let base = sanitizePrompt(title).slice(0, 120);
  if (base.length < 8) {
    const firstLine = body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#") && !isReasoningNoise(l));
    if (firstLine) base = sanitizePrompt(firstLine).slice(0, 120);
  }
  return `${base}, digital art, professional illustration, high quality, vibrant colors`;
}

function buildPollinationsUrl(prompt: string, width: number, height: number, seed: number): string {
  const encoded = encodeURIComponent(prompt);
  return `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&seed=${seed}&nologo=true&model=flux`;
}

export type GeneratedImages = {
  coverImageUrl: string;
};

/** Legacy sync helper — pollinations URL only (used as fallback). */
export function generateImageUrls(
  title: string,
  body: string,
  existingCount = 0,
  platform: CoverPlatform = "wechat"
): GeneratedImages {
  const coverPrompt = buildPromptFromContent(title, body);
  // pollinations rejects very large seeds (e.g. Date.now() ~ 1.7e12) with 500.
  const coverSeed = (Math.floor(Math.random() * 900000) + existingCount) % 1000000;
  const { width, height } = coverSizeOf(platform);
  const coverImageUrl = buildPollinationsUrl(coverPrompt, width, height, coverSeed);
  return { coverImageUrl };
}

/** Legacy sync helper — pollinations URL only (used as fallback). */
export function regenerateImage(prompt: string, width: number, height: number): string {
  const cleanPrompt = sanitizePrompt(prompt).slice(0, 120);
  const seed = Math.floor(Math.random() * 1000000);
  return buildPollinationsUrl(`${cleanPrompt}, digital art, professional illustration`, width, height, seed);
}

/** Extract a prompt from article content for a specific image index. */
export function extractImagePrompt(
  title: string,
  body: string,
  imageIndex: number,
  platform: CoverPlatform = "wechat"
): string {
  if (imageIndex === 0) {
    // 封面图和首次生成保持一致：同样带核心观点与平台调性要求。
    return buildCoverPrompt(title, body, platform);
  }
  const paragraphs = body.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !isReasoningNoise(l));
  const paraIdx = Math.min(imageIndex, paragraphs.length - 1);
  const para = paragraphs[paraIdx] || title;
  return sanitizePrompt(para).slice(0, 120);
}

// ---------------------------------------------------------------------------
// Zhipu CogView-4 — primary generator (image downloaded and stored locally)
// ---------------------------------------------------------------------------

/** CogView size constraint: width/height in [512, 2048] and multiples of 16. */
function normalizeSize(width: number, height: number): { w: number; h: number } {
  const clamp16 = (n: number) => Math.min(2048, Math.max(512, Math.round(n / 16) * 16));
  return { w: clamp16(width), h: clamp16(height) };
}

/** Call Zhipu CogView and download the resulting image as a Buffer. */
async function zhipuGenerateImage(prompt: string, width: number, height: number): Promise<Buffer> {
  if (!ZHIPU_API_KEY) {
    throw new Error("ZHIPU_API_KEY 未配置。");
  }
  const { w, h } = normalizeSize(width, height);

  const res = await fetch(ZHIPU_IMAGE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ZHIPU_API_KEY}`,
    },
    body: JSON.stringify({
      model: ZHIPU_IMAGE_MODEL,
      prompt: prompt.slice(0, 1000),
      size: `${w}x${h}`,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`智谱生图失败 ${res.status}：${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: Array<{ url?: string }> };
  const url = json.data?.[0]?.url;
  if (!url) {
    throw new Error("智谱生图未返回图片链接。");
  }

  // The returned URL is temporary (30 days) — download and store locally.
  const imgRes = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!imgRes.ok) {
    throw new Error(`下载智谱生成图片失败 ${imgRes.status}。`);
  }
  return Buffer.from(await imgRes.arrayBuffer());
}

/** Save an image buffer into public/uploads/covers/ and return the web path. */
async function saveLocalImage(buf: Buffer): Promise<string> {
  await mkdir(LOCAL_IMAGES_DIR, { recursive: true });
  // Zhipu may return JPEG even when a .png was expected — sniff the magic
  // number so the file extension matches the actual encoding.
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const filename = `${randomUUID()}.${isPng ? "png" : "jpg"}`;
  await writeFile(path.join(LOCAL_IMAGES_DIR, filename), buf);
  return `/uploads/covers/${filename}`;
}

/** Delete a previously stored local image (no-op for remote URLs). */
export function deleteLocalImage(url: string | null | undefined): void {
  if (!url || !url.startsWith("/uploads/covers/")) return;
  const filename = path.basename(url);
  // Defense: only delete plain image filenames inside our covers directory.
  if (!/^[\w-]+\.(png|jpg|jpeg)$/.test(filename)) return;
  void unlink(path.join(LOCAL_IMAGES_DIR, filename)).catch(() => {});
}

/** Generate the cover image via Zhipu and store it locally. */
export async function generateCoverImage(
  title: string,
  body: string,
  platform: CoverPlatform = "wechat"
): Promise<string> {
  // 用带「核心观点 + 平台调性」的完整 prompt，而不是只喂标题。
  const prompt = buildCoverPrompt(title, body, platform);
  const { width, height } = coverSizeOf(platform);
  const buf = await zhipuGenerateImage(prompt, width, height);
  return saveLocalImage(buf);
}

/** Regenerate an image via Zhipu with an explicit prompt, stored locally. */
export async function regenerateImageLocal(prompt: string, width: number, height: number): Promise<string> {
  const cleaned = sanitizePrompt(prompt).slice(0, 1000);
  // 封面图给的是完整中文画面描述，此时不要再拼英文风格词
  // （CogView-4 是中文模型，混入英文反而削弱语义对齐）。
  const isChineseDirection = /画面要求|画面中不要出现|构图|视觉主体/.test(cleaned);
  const finalPrompt = isChineseDirection
    ? cleaned
    : `${cleaned}, digital art, professional illustration, high quality, vibrant colors`;
  const buf = await zhipuGenerateImage(finalPrompt, width, height);
  return saveLocalImage(buf);
}

/**
 * Race a promise against a hard timeout. On timeout the original promise keeps
 * running in the background (useful for late-success cover upgrades), but the
 * caller gets `null` immediately — content saving must never block on image
 * generation.
 */
function withHardTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/**
 * Zhipu-first with pollinations fallback. The caller is expected to use this
 * in a fire-and-forget manner (save content first, upgrade cover later) so an
 * image outage can never block content saving.
 */
export async function generateCoverImageWithFallback(
  title: string,
  body: string,
  platform: CoverPlatform = "wechat"
): Promise<string> {
  try {
    return await generateCoverImage(title, body, platform);
  } catch (error) {
    console.error("[image-gen] 智谱生图失败，回退 pollinations：", error);
    return generateImageUrls(title, body, 0, platform).coverImageUrl;
  }
}

/** Zhipu-first with pollinations fallback for the regenerate endpoint (30s hard cap). */
export async function regenerateImageWithFallback(prompt: string, width: number, height: number): Promise<string> {
  const zhipuPromise = regenerateImageLocal(prompt, width, height);
  const url = await withHardTimeout(zhipuPromise, 30_000);
  if (url) {
    return url;
  }
  console.error("[image-gen] 智谱重绘超时/失败，回退 pollinations。");
  return regenerateImage(prompt, width, height);
}
