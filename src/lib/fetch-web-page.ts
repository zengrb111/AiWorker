/**
 * 网页抓取（纯函数，不碰数据库）。
 *
 * 为什么要抽出来：知识库的「抓取链接入库」（api/knowledge/[id]/fetch-url）与
 * 「文章转视频」的「URL 取正文」需要**完全相同**的一套校验 —— 协议白名单、超时、
 * 伪装 UA、content-type 校验、体积上限、正文提取。原先这套逻辑内嵌在路由里，
 * 新功能若照抄一份，改一处漏一处。这里把逻辑搬成纯函数，两边共用。
 *
 * 与原路由的差异只有一处，且是刻意收紧：默认拒绝私网/环回地址（SSRF）。
 * 知识库路由历史上就允许抓内网（allowPrivateHosts=true 保持原行为），
 * 文章转视频是用户自由输入的链接，不传该开关即受保护。
 */
import { extractHtmlMainText } from "./kb-extract";

export const MAX_PAGE_BYTES = 30 * 1024 * 1024;
export const PAGE_FETCH_TIMEOUT_MS = 20_000;

/** 抓取失败一律抛这个，message 是可直接展示给用户的中文。 */
export class FetchPageError extends Error {}

export type FetchedPage = {
  url: string;
  hostname: string;
  title: string;
  text: string;
  images: string[];
};

function decodeBasicEntities(input: string): string {
  return input
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** 常见内网/环回地址：文章转视频的链接由用户自由填写，不该允许打到内网。 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (/\.(localhost|local|internal|lan)$/.test(host)) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** 顺手抽原文配图：og:image 优先，再按出现顺序取 <img src>，只留 http(s) 直链。 */
function collectImages(html: string, baseUrl: string, limit: number): string[] {
  const found: string[] = [];
  const push = (raw?: string | null) => {
    if (!raw || found.length >= limit) return;
    let absolute: string;
    try {
      absolute = new URL(decodeBasicEntities(raw.trim()), baseUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:/i.test(absolute)) return;
    if (!found.includes(absolute)) found.push(absolute);
  };

  const og =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  push(og?.[1]);

  const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRe.exec(html)) && found.length < limit) push(match[1]);

  return found.slice(0, limit);
}

/**
 * 抓取网页并抽出标题与正文。
 * @param allowPrivateHosts 是否允许内网/环回地址（知识库历史行为为 true）
 */
export async function fetchWebPage(
  rawUrl: string,
  options: { allowPrivateHosts?: boolean; imageLimit?: number } = {}
): Promise<FetchedPage> {
  const raw = (rawUrl || "").trim();
  if (!raw) throw new FetchPageError("请填写网页链接。");

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new FetchPageError("链接格式不正确，请填写完整的 http(s) 链接。");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new FetchPageError("仅支持 http / https 链接。");
  }
  if (!options.allowPrivateHosts && isPrivateHost(target.hostname)) {
    throw new FetchPageError("出于安全考虑，不能抓取本机或内网地址。");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
  let html = "";
  try {
    const res = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    if (!res.ok) throw new FetchPageError(`网页返回 HTTP ${res.status}，无法获取。`);
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("html") && !contentType.includes("xml")) {
      throw new FetchPageError("该链接不是网页内容（需 text/html），请改用文件上传。");
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_PAGE_BYTES) {
      throw new FetchPageError("网页内容过大（超过 30MB），请改用文件上传。");
    }
    html = buffer.toString("utf8");
  } catch (error) {
    if (error instanceof FetchPageError) throw error;
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new FetchPageError(
      aborted
        ? "获取网页超时（20 秒），可以改用「上传文档」或「粘贴正文」。"
        : `获取网页失败：${error instanceof Error ? error.message : "网络错误"}`
    );
  } finally {
    clearTimeout(timer);
  }

  const reading = extractHtmlMainText(html, target.hostname);
  return {
    url: target.toString(),
    hostname: target.hostname,
    title: reading.title || target.hostname,
    text: reading.text,
    images: collectImages(html, target.toString(), options.imageLimit ?? 4),
  };
}