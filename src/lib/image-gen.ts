/**
 * Image generation utility —— 全免费方案（不再依赖任何收费生图接口）。
 *
 * 封面（主图）两步走，保证「图上的文字永远正确」：
 *   1. 背景：pollinations.ai 免费生图（无需任何 Key），简约风格、纯图像不含文字；
 *      生成失败时退化为程序绘制的极简渐变背景（完全离线，必定成功）。
 *   2. 文字：用 @napi-rs/canvas + 随仓库内置的中文字体（assets/fonts/NotoSansSC-VF.ttf）
 *      把正确的标题绘制到图上。AI 模型只画背景不画字，文字由程序渲染，
 *      因此不存在 AI 画错字的问题。
 *
 * 输出一律是本地 PNG（/uploads/covers/*.png），hgwx / healing 发布链路
 * 「封面必须本地图」的约束不受影响。
 *
 * 内联配图（非主图）：pollinations 直接出图（无文字叠加），失败退化为程序化极简背景。
 */

import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from "@napi-rs/canvas";

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
// 平台与尺寸
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

// ---------------------------------------------------------------------------
// pollinations.ai 免费生图（无需 API Key）
// ---------------------------------------------------------------------------

function buildPollinationsUrl(prompt: string, width: number, height: number, seed: number): string {
  const encoded = encodeURIComponent(prompt);
  return `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&seed=${seed}&nologo=true&model=flux`;
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

/**
 * 封面背景 prompt：只要「简约风的纯图像」，严禁出现任何文字
 * （文字由程序绘制，模型画字必有错字）。
 */
function buildMinimalistCoverPrompt(title: string, body: string): string {
  const subject = sanitizePrompt(title).slice(0, 40) || "AI digital worker";
  const keyLine = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !isReasoningNoise(l));
  const hint = keyLine ? sanitizePrompt(keyLine).slice(0, 40) : "";
  return [
    `minimalist flat illustration, subject: ${subject}${hint ? `, ${hint}` : ""}`,
    "clean simple composition, soft pastel colors, large negative space",
    "subtle geometric shapes, gentle gradient background",
    "absolutely no text, no letters, no words, no numbers, no watermark, no logo"
  ].join(", ");
}

export type GeneratedImages = {
  coverImageUrl: string;
};

/** Legacy sync helper — pollinations URL only (used as remote placeholder). */
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

/** Legacy sync helper — pollinations URL only. */
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
    // 封面背景与首次生成保持一致：简约、纯图像、无文字。
    return buildMinimalistCoverPrompt(title, body);
  }
  const paragraphs = body.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !isReasoningNoise(l));
  const paraIdx = Math.min(imageIndex, paragraphs.length - 1);
  const para = paragraphs[paraIdx] || title;
  return sanitizePrompt(para).slice(0, 120);
}

// ---------------------------------------------------------------------------
// 免费下载：pollinations 背景（简约、无文字）
// ---------------------------------------------------------------------------

async function fetchPollinationsImage(prompt: string, width: number, height: number, timeoutMs = 45_000): Promise<Buffer | null> {
  try {
    const seed = Math.floor(Math.random() * 1000000);
    const url = buildPollinationsUrl(prompt, width, height, seed);
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // 太小的响应基本是错误页/占位图，当作失败处理。
    if (buf.length < 2000) return null;
    return buf;
  } catch (error) {
    console.error("[image-gen] pollinations 出图失败：", error instanceof Error ? error.message : error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 内置中文字体 + canvas 绘制（文字由程序渲染，永远正确）
// ---------------------------------------------------------------------------

const COVER_FONT_FAMILY = "AiWorkerCover";

/**
 * 封面字体候选：**只允许免费可商用字体**。
 *
 * 历史坑：早先候选里是 `simhei.ttf`（黑体，中易授权）与 `msyh.ttc`（微软雅黑，方正授权），
 * 两者都**不是免费可商用**。现改为 Noto Sans SC（SIL OFL 1.1），并优先用仓库内那一份。
 */
const COVER_FONT_CANDIDATES = [
  path.join(process.cwd(), "assets", "fonts", "NotoSansSC-VF.ttf"),
  "C:\\Windows\\Fonts\\NotoSansSC-VF.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"
];

let coverFontReady = false;
function ensureCoverFont(): boolean {
  if (coverFontReady) return true;
  for (const candidate of COVER_FONT_CANDIDATES) {
    try {
      if (GlobalFonts.registerFromPath(candidate, COVER_FONT_FAMILY)) {
        coverFontReady = true;
        return true;
      }
    } catch {
      // 换下一个候选
    }
  }
  console.error("[image-gen] 封面中文字体注册失败，标题可能显示为方块。请确认 assets/fonts/NotoSansSC-VF.ttf 存在。");
  return false;
}

/** 极简配色（按标题哈希挑选，同一篇稳定、不同篇有变化）。 */
const COVER_PALETTES: Array<{ bg: [string, string]; accent: string }> = [
  { bg: ["#eef4ff", "#dfe9ff"], accent: "#3b82f6" }, // 蓝
  { bg: ["#fdf2f8", "#fce7f3"], accent: "#ec4899" }, // 粉
  { bg: ["#ecfdf5", "#d1fae5"], accent: "#10b981" }, // 绿
  { bg: ["#fff7ed", "#ffedd5"], accent: "#f97316" }, // 橙
  { bg: ["#f5f3ff", "#ede9fe"], accent: "#8b5cf6" }, // 紫
  { bg: ["#f1f5f9", "#e2e8f0"], accent: "#334155" }  // 灰
];

function paletteOf(seed: string): { bg: [string, string]; accent: string } {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return COVER_PALETTES[hash % COVER_PALETTES.length];
}

/** 极简背景：柔和渐变 + 大圆/圆环/圆点，留白充足，不含任何文字。 */
function drawMinimalistBackground(
  ctx: SKRSContext2D,
  width: number,
  height: number,
  palette: { bg: [string, string]; accent: string }
): void {
  const grad = ctx.createLinearGradient(0, 0, width * 0.4, height);
  grad.addColorStop(0, palette.bg[0]);
  grad.addColorStop(1, palette.bg[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  const unit = Math.min(width, height);
  // 右上大圆（半透明）
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = palette.accent;
  ctx.beginPath();
  ctx.arc(width * 0.86, height * 0.16, unit * 0.42, 0, Math.PI * 2);
  ctx.fill();
  // 左下圆环
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = Math.max(3, Math.round(unit * 0.006));
  ctx.strokeStyle = palette.accent;
  ctx.beginPath();
  ctx.arc(width * 0.12, height * 0.82, unit * 0.18, 0, Math.PI * 2);
  ctx.stroke();
  // 小圆点点缀
  ctx.globalAlpha = 0.22;
  ctx.beginPath();
  ctx.arc(width * 0.78, height * 0.7, unit * 0.035, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function roundRectPath(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** 中文标题按像素宽度折行（逐字测量），超出 maxLines 末行加省略号。 */
function layoutTitle(ctx: SKRSContext2D, title: string, maxWidth: number, maxLines: number): string[] {
  const clean = title.replace(/\s+/g, " ").trim() || "未命名内容";
  const lines: string[] = [];
  let current = "";
  let truncated = false;
  for (const ch of clean) {
    const candidate = current + ch;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = ch;
      if (lines.length === maxLines) {
        truncated = true;
        break;
      }
    } else {
      current = candidate;
    }
  }
  if (!truncated && current) lines.push(current);
  if (truncated && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last.length > 0 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = `${last}…`;
  }
  return lines.slice(0, maxLines);
}

type CoverRenderOptions = {
  title: string;
  /** 免费生成的背景图（可空 → 程序化极简背景） */
  background: Buffer | null;
  width: number;
  height: number;
  seed: string;
};

/** 渲染一张「简约背景 + 正确标题文字」的封面，返回 PNG Buffer。 */
async function renderCoverBuffer(opts: CoverRenderOptions): Promise<Buffer> {
  const { title, background, width, height, seed } = opts;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const palette = paletteOf(seed || title);

  let usedFetched = false;
  if (background) {
    try {
      const img = await loadImage(background);
      ctx.drawImage(img, 0, 0, width, height);
      usedFetched = true;
    } catch (error) {
      console.error("[image-gen] 背景图解码失败，改用程序化背景：", error instanceof Error ? error.message : error);
    }
  }
  if (!usedFetched) {
    drawMinimalistBackground(ctx, width, height, palette);
  } else {
    // 底部白纱渐变，保证深色标题在任何背景图上都可读。
    const scrim = ctx.createLinearGradient(0, height * 0.35, 0, height);
    scrim.addColorStop(0, "rgba(255,255,255,0)");
    scrim.addColorStop(1, "rgba(255,255,255,0.92)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, Math.round(height * 0.35), width, Math.round(height * 0.65));
    // pollinations 免费接口会在右下角打一个小水印（nologo 参数不总生效），
    // 用与底部白纱同色的圆角块轻轻盖住，视觉上融进背景、不露痕迹。
    const stampW = Math.round(width * 0.16);
    const stampH = Math.max(18, Math.round(height * 0.038));
    const stampX = width - stampW - Math.round(width * 0.02);
    const stampY = height - stampH - Math.round(height * 0.015);
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    roundRectPath(ctx, stampX, stampY, stampW, stampH, Math.round(stampH / 2));
    ctx.fill();
  }

  const portrait = height > width;
  const padding = Math.round(width * (portrait ? 0.075 : 0.065));
  const fontSize = Math.round(width * (portrait ? 0.066 : 0.052));
  const maxLines = portrait ? 4 : 3;
  const maxWidth = width - padding * 2;

  ensureCoverFont();
  ctx.font = `bold ${fontSize}px "${COVER_FONT_FAMILY}", sans-serif`;
  ctx.textBaseline = "alphabetic";

  const lines = layoutTitle(ctx, title, maxWidth, maxLines);
  const lineHeight = Math.round(fontSize * 1.42);
  const blockHeight = lines.length * lineHeight;

  // 标题上方的强调色条
  const barWidth = Math.round(fontSize * 1.7);
  const barHeight = Math.max(6, Math.round(fontSize * 0.13));
  const barY = height - padding - blockHeight - Math.round(fontSize * 0.55) - barHeight;
  ctx.fillStyle = palette.accent;
  roundRectPath(ctx, padding, barY, barWidth, barHeight, barHeight / 2);
  ctx.fill();

  // 标题（逐行绘制）
  ctx.fillStyle = "#1f2937";
  let baseline = barY + barHeight + Math.round(fontSize * 0.55) + fontSize;
  for (const line of lines) {
    ctx.fillText(line, padding, baseline);
    baseline += lineHeight;
  }

  return canvas.toBuffer("image/png");
}

/** 程序化极简配图（无文字），作为 pollinations 失败时的兜底。 */
async function renderMinimalistImageBuffer(width: number, height: number, seed: string): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  drawMinimalistBackground(ctx, width, height, paletteOf(seed));
  return canvas.toBuffer("image/png");
}

// ---------------------------------------------------------------------------
// 本地存储
// ---------------------------------------------------------------------------

/** Save an image buffer into public/uploads/covers/ and return the web path. */
async function saveLocalImage(buf: Buffer): Promise<string> {
  await mkdir(LOCAL_IMAGES_DIR, { recursive: true });
  // Sniff the magic number so the file extension matches the actual encoding.
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

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 生成封面（主图）：免费背景 + 程序绘制的正确标题，输出本地 PNG。
 * pollinations 失败时自动退化为程序化极简背景，几乎不会失败。
 */
export async function generateCoverImage(
  title: string,
  body: string,
  platform: CoverPlatform = "wechat"
): Promise<string> {
  const { width, height } = coverSizeOf(platform);
  const background = await fetchPollinationsImage(buildMinimalistCoverPrompt(title, body), width, height);
  const buf = await renderCoverBuffer({ title, background, width, height, seed: title });
  return saveLocalImage(buf);
}

/**
 * 同 generateCoverImage，但任何意外都不抛出：
 * 最后兜底是「程序化极简背景 + 正确标题」，保证内容保存/发布永不被生图阻塞。
 */
export async function generateCoverImageWithFallback(
  title: string,
  body: string,
  platform: CoverPlatform = "wechat"
): Promise<string> {
  try {
    return await generateCoverImage(title, body, platform);
  } catch (error) {
    console.error("[image-gen] 免费封面生成失败，退化为程序化极简封面：", error);
    const { width, height } = coverSizeOf(platform);
    const buf = await renderCoverBuffer({ title, background: null, width, height, seed: title });
    return saveLocalImage(buf);
  }
}

/**
 * 重绘一张配图（非主图或指定 prompt）：免费 pollinations 出图落本地，
 * 失败退化为程序化极简背景。
 */
export async function regenerateImageWithFallback(prompt: string, width: number, height: number): Promise<string> {
  const buf = await fetchPollinationsImage(buildPromptFromContent(prompt, ""), width, height);
  if (buf) {
    return saveLocalImage(buf);
  }
  console.error("[image-gen] pollinations 重绘失败，退化为程序化极简背景。");
  const fallback = await renderMinimalistImageBuffer(width, height, prompt);
  return saveLocalImage(fallback);
}
