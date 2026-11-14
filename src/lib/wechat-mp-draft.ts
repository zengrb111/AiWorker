import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { prisma } from "@/lib/prisma";
import { decryptCredential } from "@/lib/platform-creds";
import { generateCoverImageWithFallback, coverPlatformOf } from "@/lib/image-gen";
import {
  buildArticleDigest,
  extractArticleImages,
  fitWechatTitle,
  renderArticleHtml,
  replaceArticleImages
} from "@/lib/article/wechat-style";

/**
 * 微信公众号开放平台「草稿箱」推送链路。
 *
 * 官方接口（服务端调用，不能从浏览器直连）：
 *   GET  /cgi-bin/token?grant_type=client_credential&appid=&secret=  → access_token（2h，需缓存）
 *   POST /cgi-bin/media/uploadimg    → 正文内图片 URL（≤1MB，jpg/png，不占素材库）
 *   POST /cgi-bin/material/add_material?type=image → 封面永久素材 media_id
 *   POST /cgi-bin/draft/add          → 存进公众号草稿箱
 *
 * 🔴 两个必须记住的坑：
 *  1. content 里的外链图片会被微信直接过滤，只有 uploadimg 返回的 mmbiz.qpic.cn URL 才有效。
 *  2. thumb_media_id 必填且必须是「永久素材」media_id，不能用正文图的 URL 或临时素材。
 *
 * 凭据优先级：平台授权管理里当前用户的「公众号开放平台」AppID/AppSecret
 * → 环境变量 WECHAT_MP_APP_ID / WECHAT_MP_APP_SECRET（服务器全局兜底）。
 */

const API = "https://api.weixin.qq.com/cgi-bin";
export const WECHAT_DRAFT_CHANNEL = "公众号草稿箱";

const MP_HOME = "https://mp.weixin.qq.com/";

type MpCredential = { appId: string; appSecret: string };

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** 微信错误码 → 人话。避免把 errcode 裸给用户。 */
export function wechatErrorMessage(errcode: number, errmsg?: string): string {
  const known: Record<number, string> = {
    40001: "AppSecret 不正确，或服务器 IP 没加入公众号 IP 白名单（公众号后台 → 开发与安全 → 基本配置）",
    40013: "AppID 无效，请检查是否填成了公众号原始 ID",
    40125: "AppSecret 无效",
    40164: "调用方 IP 不在白名单，请把平台服务器 IP 加到公众号后台的 IP 白名单",
    48001: "该公众号没有草稿箱接口权限（未认证的订阅号不支持，需已认证订阅号/服务号）",
    45009: "接口调用超过当日限额，请稍后再试",
    40007: "素材 media_id 无效，封面上传可能失败了",
    41001: "缺少 access_token",
    42001: "access_token 已过期",
    45002: "正文内容超过长度限制",
    53404: "账号已被限制发布，请到公众号后台查看",
    [-1]: "微信服务暂时不可用，请稍后重试"
  };
  return known[errcode] || `微信接口返回错误 ${errcode}${errmsg ? `：${errmsg}` : ""}`;
}

type WxReply = { errcode?: number; errmsg?: string; [k: string]: unknown };

function assertWxOk(payload: WxReply): void {
  if (payload.errcode && payload.errcode !== 0) {
    throw new Error(wechatErrorMessage(payload.errcode, payload.errmsg));
  }
}

/** 读取凭据：用户级配置优先，环境变量兜底。 */
export async function loadWechatMpCredential(userId: string): Promise<MpCredential | null> {
  try {
    const account = await prisma.platformAccount.findUnique({
      where: { userId_platform: { userId, platform: "wechat-mp" } },
      select: { credentialEnc: true, status: true }
    });
    if (account?.credentialEnc) {
      const parsed = JSON.parse(decryptCredential(account.credentialEnc)) as Partial<MpCredential>;
      if (parsed.appId && parsed.appSecret) {
        return { appId: String(parsed.appId), appSecret: String(parsed.appSecret) };
      }
    }
  } catch (error) {
    console.error("[wechat-mp] 读取用户级凭据失败：", error);
  }
  const appId = (process.env.WECHAT_MP_APP_ID || "").trim();
  const appSecret = (process.env.WECHAT_MP_APP_SECRET || "").trim();
  return appId && appSecret ? { appId, appSecret } : null;
}

/** 保存配置前的真实校验：能换到 access_token 才算填对。 */
export async function verifyWechatMpCredential(
  appId: string,
  appSecret: string
): Promise<{ ok: boolean; message: string }> {
  try {
    await fetchAccessToken({ appId, appSecret }, true);
    return { ok: true, message: "AppID / AppSecret 校验通过" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "校验失败" };
  }
}

/** 剪贴板场景取 token：没配凭据 / 取 token 失败都把原因带回去，前端要如实提示。 */
export async function getWechatClipboardToken(
  userId: string
): Promise<{ token: string | null; error?: string }> {
  try {
    const credential = await loadWechatMpCredential(userId);
    if (!credential) return { token: null, error: "未配置公众号开放平台 AppID / AppSecret" };
    return { token: await fetchAccessToken(credential) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[wechat-mp] 剪贴板取 access_token 失败：", message);
    return { token: null, error: message };
  }
}

async function fetchAccessToken(c: MpCredential, force = false): Promise<string> {
  if (!force) {
    const cached = tokenCache.get(c.appId);
    // 提前 5 分钟刷新，避免边界过期
    if (cached && cached.expiresAt > Date.now() + 300_000) return cached.token;
  }
  const url =
    `${API}/token?grant_type=client_credential` +
    `&appid=${encodeURIComponent(c.appId)}&secret=${encodeURIComponent(c.appSecret)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const payload = (await res.json().catch(() => ({}))) as WxReply & {
    access_token?: string;
    expires_in?: number;
  };
  assertWxOk(payload);
  if (!payload.access_token) throw new Error("微信未返回 access_token，请检查 AppID / AppSecret");
  tokenCache.set(c.appId, {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in || 7200) * 1000
  });
  return payload.access_token;
}

// ---------------------------------------------------------------------------
// 图片：读取 / 压缩 / 上传
// ---------------------------------------------------------------------------

type ImageData = { buffer: Buffer; filename: string; mime: string };

/** 只允许读 public 目录下的本地图，防目录穿越。 */
export async function loadImageData(url: string): Promise<ImageData | null> {
  try {
    if (url.startsWith("/uploads/")) {
      const publicRoot = path.join(process.cwd(), "public");
      const filePath = path.resolve(publicRoot, "." + url);
      if (!filePath.startsWith(publicRoot + path.sep)) return null;
      const buffer = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase().replace(".", "") || "png";
      return { buffer, filename: path.basename(filePath), mime: ext === "jpg" ? "image/jpeg" : `image/${ext}` };
    }
    if (/^https?:\/\//i.test(url)) {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
      const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
      return { buffer, filename: `remote-${Date.now()}.${ext}`, mime };
    }
  } catch (error) {
    console.error("[wechat-mp] 读取图片失败：", error);
  }
  return null;
}

/**
 * 统一转成 JPEG：微信 uploadimg 只吃 jpg/png 且 ≤1MB，
 * 本地 PNG 常超 1MB，转 JPEG 既能压体积也规避格式问题。
 */
export async function toJpeg(data: ImageData, maxBytes = 950_000): Promise<Buffer> {
  const image = await loadImage(data.buffer);
  const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
  const canvas = createCanvas(
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale))
  );
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  let quality = 82;
  let out = canvas.toBuffer("image/jpeg", quality);
  while (out.length > maxBytes && quality > 35) {
    quality -= 12;
    out = canvas.toBuffer("image/jpeg", quality);
  }
  return out;
}

function multipart(buffer: Buffer, filename: string): FormData {
  const form = new FormData();
  form.append("media", new Blob([new Uint8Array(buffer)], { type: "image/jpeg" }), filename.replace(/\.[^.]+$/, "") + ".jpg");
  return form;
}

/** 正文图 → 微信图床 URL（media/uploadimg，不占素材库配额）。 */
export async function uploadContentImage(token: string, url: string): Promise<string | null> {
  const data = await loadImageData(url);
  if (!data) return null;
  const jpeg = await toJpeg(data);
  const res = await fetch(`${API}/media/uploadimg?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    body: multipart(jpeg, data.filename),
    signal: AbortSignal.timeout(30_000)
  });
  const payload = (await res.json().catch(() => ({}))) as WxReply & { url?: string };
  assertWxOk(payload);
  return payload.url || null;
}

/** 封面 → 永久素材 media_id（draft/add 的 thumb_media_id 必填）。 */
async function uploadThumbMedia(token: string, url: string): Promise<string> {
  const data = await loadImageData(url);
  if (!data) throw new Error("封面图读取失败，请先在内容库重新生成封面");
  const jpeg = await toJpeg(data, 9_000_000);
  const res = await fetch(
    `${API}/material/add_material?access_token=${encodeURIComponent(token)}&type=image`,
    { method: "POST", body: multipart(jpeg, data.filename), signal: AbortSignal.timeout(45_000) }
  );
  const payload = (await res.json().catch(() => ({}))) as WxReply & { media_id?: string };
  assertWxOk(payload);
  if (!payload.media_id) throw new Error("封面上传成功但未拿到 media_id");
  return payload.media_id;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export type WechatDraftOptions = {
  /** 覆盖作者（≤16 字） */
  author?: string;
  /** 覆盖摘要（≤120 字） */
  digest?: string;
  /** 原文链接 */
  sourceUrl?: string;
  /** 强制再推一次（忽略幂等） */
  force?: boolean;
};

export type WechatDraftResult = {
  recordId: string;
  remoteId: string | null;
  remoteUrl: string | null;
  title: string;
  imageCount: number;
  skipped?: boolean;
  message?: string;
};

/** 把一条内容库图文保存进公众号草稿箱。 */
export async function publishContentToWechatDraft(
  contentItemId: string,
  userId: string,
  publisher: string,
  options: WechatDraftOptions = {}
): Promise<WechatDraftResult> {
  const item = await prisma.contentItem.findFirst({ where: { id: contentItemId, userId } });
  if (!item) throw new Error("内容不存在。");

  const credential = await loadWechatMpCredential(userId);
  if (!credential) {
    throw new Error(
      "尚未配置公众号开放平台授权。请到「平台授权管理 → 公众号开放平台」填写 AppID 与 AppSecret（并把服务器 IP 加入公众号后台白名单）。"
    );
  }

  if (!options.force) {
    const existed = await prisma.publishRecord.findFirst({
      where: {
        contentItemId: item.id,
        channel: WECHAT_DRAFT_CHANNEL,
        status: "SUCCESS",
        title: item.title
      },
      orderBy: { publishedAt: "desc" }
    });
    if (existed) {
      return {
        recordId: existed.id,
        remoteId: existed.remoteId,
        remoteUrl: existed.remoteUrl,
        title: existed.title,
        imageCount: 0,
        skipped: true,
        message: "这篇内容已存进草稿箱，跳过重复提交；如需再存一份请点「强制重推」。"
      };
    }
  }

  try {
    const token = await fetchAccessToken(credential);
    const md = item.body || "";

    // 1) 正文配图逐个上传微信图床；失败的图从正文移除（外链会被微信过滤，留着也是空白）。
    const images = extractArticleImages(md);
    const replacements = new Map<string, string>();
    let imageCount = 0;
    for (const url of Array.from(new Set(images))) {
      try {
        const wxUrl = await uploadContentImage(token, url);
        replacements.set(url, wxUrl || "");
        if (wxUrl) imageCount += 1;
      } catch (error) {
        console.error("[wechat-mp] 正文图上传失败，已跳过：", error);
        replacements.set(url, "");
      }
    }
    const bodyForWechat = replaceArticleImages(md, replacements);

    // 2) 封面（draft/add 强制要求 thumb_media_id）
    let coverUrl = item.coverImageUrl || "";
    if (!coverUrl) {
      coverUrl = await generateCoverImageWithFallback(item.title, md, coverPlatformOf(item.category));
    }
    const thumbMediaId = await uploadThumbMedia(token, coverUrl);

    // 3) 统一排版 HTML（标题竖线 + 蓝色加粗 + 自动重点加粗 + 内联样式）
    const content = renderArticleHtml(bodyForWechat);
    if (!content.trim()) throw new Error("正文为空，无法保存草稿。");

    const article = {
      title: fitWechatTitle(item.title, 32),
      author: (options.author || "").trim().slice(0, 16),
      digest: (options.digest || buildArticleDigest(md, 110)).trim().slice(0, 120),
      content,
      content_source_url: options.sourceUrl || "",
      thumb_media_id: thumbMediaId,
      need_open_comment: 0,
      only_fans_can_comment: 0
    };

    const res = await fetch(`${API}/draft/add?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articles: [article] }),
      signal: AbortSignal.timeout(45_000)
    });
    const payload = (await res.json().catch(() => ({}))) as WxReply & { media_id?: string };
    assertWxOk(payload);
    if (!payload.media_id) throw new Error("微信未返回草稿 media_id");

    const record = await prisma.publishRecord.create({
      data: {
        contentItemId: item.id,
        channel: WECHAT_DRAFT_CHANNEL,
        remoteId: payload.media_id,
        remoteUrl: MP_HOME,
        title: item.title,
        publisher,
        status: "SUCCESS",
        publishedAt: new Date()
      }
    });
    return {
      recordId: record.id,
      remoteId: payload.media_id,
      remoteUrl: MP_HOME,
      title: item.title,
      imageCount,
      message: `已存进公众号草稿箱（${imageCount} 张配图），到公众号后台草稿箱即可预览发表。`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.publishRecord.create({
      data: {
        contentItemId: item.id,
        channel: WECHAT_DRAFT_CHANNEL,
        title: item.title,
        publisher,
        status: "FAILED",
        error: message.slice(0, 500),
        publishedAt: new Date()
      }
    });
    throw error;
  }
}
