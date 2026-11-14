/**
 * 「复制到公众号」用的富文本构建（服务端）。
 *
 * 🔴 2026-11-13 修复：以前把正文里的 /uploads/xxx 相对路径硬拼成
 * https://aiemployee.aimemory.cafe/uploads/xxx，本机开发时图片只存在本机磁盘，
 * 线上根本没有这个文件（实测本机 200 / 线上 404），微信编辑器抓取外链失败
 * → 粘贴后图片不显示并报「路径不对」。
 *
 * 微信正文 <img> 只认自己的图床 mmbiz.qpic.cn：base64 和外链都不可靠
 * （draft/add 会直接过滤掉，编辑器粘贴外链也常抓不到）。所以正确解法只有一条：
 *  配了公众号 AppID/AppSecret → media/uploadimg 上传微信图床，src 换成 mmbiz 地址。
 *  没配凭据 / 上传失败 → 仍把图片读成 data URI 内嵌（本地预览、Word 等能用），
 *  但必须如实告诉用户「微信不会显示这些图，去配置授权」，不能假装已修好。
 *
 * 只生成剪贴板 HTML，不写回数据库，正文 Markdown 里的相对路径保持不变。
 */
import {
  getWechatClipboardToken,
  loadImageData,
  toJpeg,
  uploadContentImage
} from "@/lib/wechat-mp-draft";
import { extractArticleImages, renderArticleHtml } from "./wechat-style";

/** 平台自身 / 本机的图片才算「需要搬运」；第三方外链不动。 */
function isPlatformImage(url: string): boolean {
  if (url.startsWith("/")) return true;
  if (/^data:|^blob:/i.test(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "aiemployee.aimemory.cafe" ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)
    );
  } catch {
    return false;
  }
}

/** 绝对地址里截出 /uploads/... 部分，好从本机 public 目录读文件。 */
function localizeImageUrl(url: string): string {
  if (url.startsWith("/")) return url;
  if (/^https?:\/\//i.test(url)) {
    const match = url.match(/\/uploads\/[^"'\s?]+/);
    if (match) return match[0];
  }
  return url;
}

/** 本地/平台图 → JPEG data URI；解码失败时退回原始字节的 data URI。 */
async function inlineImage(url: string): Promise<string | null> {
  const data = await loadImageData(localizeImageUrl(url));
  if (!data) return null;
  try {
    const jpeg = await toJpeg(data, 700_000);
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch {
    return `data:${data.mime};base64,${data.buffer.toString("base64")}`;
  }
}

function stripDuplicateTitle(body: string, title: string): string {
  const lines = (body || "").split("\n");
  const first = lines[0] || "";
  const duplicated =
    /^#{1,6}\s+/.test(first) && first.replace(/^#{1,6}\s+/, "").trim() === (title || "").trim();
  return duplicated ? lines.slice(1).join("\n").replace(/^\s*\n/, "") : body || "";
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export type WechatClipboardPayload = {
  html: string;
  imageMode: "wechat" | "inline" | "none" | "failed";
  imageCount: number;
  notice: string;
  /** 图片没进微信图床时的可操作指引，前端要显著提示。 */
  warning: string | null;
};

const CREDENTIAL_HINT =
  "到「平台授权管理 → 公众号开放平台」填 AppID / AppSecret，并把服务器公网 IP 加进公众号后台白名单；配好后复制会自动上传微信图床。也可直接用「推送到草稿箱」。";

export async function buildWechatClipboardHtml(input: {
  body: string;
  title: string;
  coverImageUrl?: string | null;
  userId: string;
}): Promise<WechatClipboardPayload> {
  const md = stripDuplicateTitle(input.body || "", input.title || "");
  let sourceMd = md;
  // 正文一张图都没有时，把封面放开头（与旧版行为一致）。
  if (!extractArticleImages(md).length && input.coverImageUrl) {
    sourceMd = `![封面](${input.coverImageUrl})\n\n${md}`;
  }

  let html = renderArticleHtml(sourceMd);
  const srcs = Array.from(
    new Set(Array.from(html.matchAll(/\bsrc="([^"]+)"/g), (m) => m[1].replace(/&amp;/g, "&")))
  );
  const own = srcs.filter(isPlatformImage);
  if (!own.length) {
    return {
      html,
      imageMode: "none",
      imageCount: 0,
      notice: "已复制，粘贴到公众号编辑器可保留标题和加粗（文章标题请单独填）",
      warning: null
    };
  }

  const { token, error: tokenError } = await getWechatClipboardToken(input.userId);
  const replacements = new Map<string, string>();
  let uploaded = 0;
  let inlined = 0;
  let failed = 0;

  for (const src of own) {
    let resolved: string | null = null;
    if (token) {
      try {
        resolved = await uploadContentImage(token, localizeImageUrl(src));
      } catch (error) {
        console.warn("[wechat-clipboard] 上传微信图床失败，改内嵌：", error);
      }
    }
    if (resolved) {
      uploaded += 1;
      replacements.set(src, resolved);
      continue;
    }
    resolved = await inlineImage(src);
    if (resolved) {
      inlined += 1;
      replacements.set(src, resolved);
    } else {
      failed += 1;
    }
  }

  html = html.replace(/\bsrc="([^"]+)"/g, (all, raw: string) => {
    const value = replacements.get(raw.replace(/&amp;/g, "&"));
    return value ? `src="${escapeAttr(value)}"` : all;
  });

  const notice = uploaded
    ? `已复制：${uploaded} 张图已上传微信图床，粘贴到公众号可直接显示（文章标题请单独填）`
    : `已复制排版；${own.length - uploaded} 张图没进微信图床，公众号不会显示（文章标题请单独填）`;

  // 只要有图没进微信图床就给警告：不把「路径修好了」当成「图片能显示了」。
  const warning =
    uploaded && !inlined && !failed
      ? null
      : tokenError
        ? `微信图床不可用（${tokenError}）。${CREDENTIAL_HINT}`
        : `${own.length - uploaded} 张图没进微信图床，公众号里不会显示。${CREDENTIAL_HINT}`;

  return {
    html,
    imageMode: uploaded ? "wechat" : inlined ? "inline" : "failed",
    imageCount: uploaded + inlined,
    notice,
    warning
  };
}
