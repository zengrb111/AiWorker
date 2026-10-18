/**
 * 文章正文统一提取 —— 「文章转视频」的第一道工序。
 *
 * 三种来源（URL / 上传文档 / 粘贴正文）在这里被归一化成同一个 {@link ArticleSource}，
 * 下游的文章理解、图表规划就只面对一种数据结构，不必再关心用户从哪来。
 *
 * 两条硬约束：
 *  1. **不 import prisma**。本文件及其下游必须能被 scripts/aiworker-video.mts
 *     （OpenClaw spawn 的独立 CLI，无数据库写权限）安全 import。
 *  2. **正文必须归一化**。溯源校验（article/analyze.ts 的 verifyChartSpecs）靠
 *     `normalized.includes(sourceQuote)` 判定模型给的原文片段是否真实存在，
 *     所以这里把全角转半角、去空白、统一引号，否则模型微调一个标点就会被误判为编造。
 */
import { extractDocumentText, kindOf } from "./kb-extract";
import { fetchWebPage } from "./fetch-web-page";

/** 正文进入 prompt 的上限，超出截断，避免把上下文撑爆。 */
export const ARTICLE_TEXT_LIMIT = 12_000;

/** 支持上传的文档扩展名（与知识库解析器的能力对齐，不含图片与 zip 批量）。 */
export const ARTICLE_DOCUMENT_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".docx",
  ".pdf",
  ".csv",
  ".tsv",
  ".json",
  ".html",
  ".htm",
];

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export type ArticleOrigin = "url" | "document" | "paste";

export type ArticleSource = {
  origin: ArticleOrigin;
  /** 展示用标题：优先原文标题，其次文件名/域名，最后用首句。 */
  title: string;
  /** 已归一化的正文（去空白、全角转半角），长度不超过 ARTICLE_TEXT_LIMIT。 */
  text: string;
  /** 展示用来源标签，如 example.com / 财报.pdf / 手动粘贴 */
  originLabel: string;
  sourceUrl?: string;
  /** 原文里抓到的图片直链，作为补充画面素材（图表之外的底图）。 */
  rawImages: string[];
};

export class ArticleSourceError extends Error {}

/**
 * 溯源校验专用的归一化：全角标点/数字 → 半角、去所有空白、统一引号。
 * 模型在引用原文时经常把「，」写成「,」或中间多一个空格，这一层把这些差异抹平。
 */
export function normalizeForVerification(input: string): string {
  return input
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, "")
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/[【]/g, "[")
    .replace(/[】]/g, "]")
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, "");
}

/** 正文可用性闸门：太短的文本做不出脚本与图表，直接拦在源头。 */
function assertUsable(text: string, originLabel: string): void {
  if (!text.trim()) {
    throw new ArticleSourceError(
      originLabel ? `「${originLabel}」没有提取到任何正文内容。` : "没有提取到任何正文内容。"
    );
  }
  if (text.length < 80) {
    throw new ArticleSourceError(
      `「${originLabel}」正文太短（仅 ${text.length} 字），至少需要 80 字才能规划脚本。请换一篇更完整的文章。`
    );
  }
}

/** 标题兜底：没有标题就取首行短句，别让标题空着进方案面板。 */
function fallbackTitle(text: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine || "未命名文章";
}

/** 截断到上限，并在截断处留一个可见标记（模型不会误以为文章到此结束）。 */
function clampText(text: string): string {
  if (text.length <= ARTICLE_TEXT_LIMIT) return text;
  return `${text.slice(0, ARTICLE_TEXT_LIMIT)}\n（正文过长，已截取前 ${ARTICLE_TEXT_LIMIT} 字）`;
}

/** 来源一：粘贴正文。 */
export function articleFromText(raw: string): ArticleSource {
  const text = clampText((raw || "").trim());
  assertUsable(text, "粘贴的正文");
  return {
    origin: "paste",
    title: fallbackTitle(text),
    text,
    originLabel: "手动粘贴",
    rawImages: [],
  };
}

/** 来源二：上传文档。docx / pdf / txt / md 等，直接委托既有解析器，不重复实现。 */
export async function articleFromUpload(buffer: Buffer, filename: string): Promise<ArticleSource> {
  const name = (filename || "").trim() || "未命名文档";
  if (buffer.byteLength > MAX_DOCUMENT_BYTES) {
    throw new ArticleSourceError(`文档过大（超过 ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB）。`);
  }
  if (kindOf(name) === "image") {
    throw new ArticleSourceError("不支持图片文件，请上传 docx / pdf / txt / md 文档。");
  }
  const result = await extractDocumentText(buffer, name);
  if (result.status === "FAILED") {
    throw new ArticleSourceError(`文档解析失败：${result.note}`);
  }
  const text = clampText(result.text.trim());
  assertUsable(text, name);
  const label = name.length > 40 ? `${name.slice(0, 40)}…` : name;
  return {
    origin: "document",
    title: result.text.trim() ? fallbackTitle(text) : label,
    text,
    originLabel: label,
    rawImages: [],
  };
}

/** 来源三：URL 抓取。抓取与正文提取共用 fetchWebPage（校验逻辑只写一份）。 */
export async function articleFromUrl(rawUrl: string): Promise<ArticleSource> {
  const page = await fetchWebPage(rawUrl, { imageLimit: 4 });
  const text = clampText(page.text.trim());
  assertUsable(text, page.hostname);
  return {
    origin: "url",
    title: page.title || fallbackTitle(text),
    text,
    originLabel: page.hostname,
    sourceUrl: page.url,
    rawImages: page.images,
  };
}