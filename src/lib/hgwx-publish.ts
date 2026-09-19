import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";

/**
 * 官网「好物推荐」发布链路（hgwx.aimemory.cafe）。
 *
 * 接入文档：BOP接入指南（WorkBuddy 资料库）。
 * 流程：读取内容库条目 → 封面/图集转 dataUrl → POST /api/upload 拿站内 URL
 *       → 组装条目 → POST /api/recommends → 落一条 PublishRecord。
 * 幂等：同一条内容（同标题）已有 SUCCESS 记录时直接返回旧记录，不重复推送。
 */

const API = (process.env.HGWX_PUBLISH_API || "https://hgwx.aimemory.cafe").replace(/\/+$/, "");
const TOKEN = process.env.HGWX_PUBLISH_TOKEN || "";

export const HGWX_CHANNEL = "官网好物推荐";

/** 内容库分类 → hgwx 一级分类 / 二级 type / 来源平台。 */
function categoryMapping(category?: string | null): {
  hgwxCategory: string;
  type: string;
  platform: string;
} {
  const value = (category || "").trim();
  if (value.includes("小红书")) {
    return { hgwxCategory: "产品热点", type: "product", platform: "小红书" };
  }
  if (value.includes("公众号")) {
    return { hgwxCategory: "全网热点", type: "web", platform: "公众号" };
  }
  if (value.includes("视频")) {
    return { hgwxCategory: "全网热点", type: "web", platform: "视频号" };
  }
  return { hgwxCategory: "产品热点", type: "product", platform: "小红书" };
}

/** Markdown 正文 → 纯文本摘要（去标题行/语法符，取前 N 字）。 */
export function buildSummary(body: string, maxLen = 120): string {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^[#>|`\-*[]/.test(line));
  const text = lines
    .join(" ")
    .replace(/[*_`#]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxLen);
}

type CoverData = { dataUrl: string; ext: string };

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};

/** 把内容库里的图片地址（本地 /uploads/... 或远程 URL）读成 dataUrl。 */
async function loadImageAsDataUrl(imageUrl: string): Promise<CoverData> {
  if (imageUrl.startsWith("/uploads/")) {
    const filePath = path.join(process.cwd(), "public", imageUrl);
    const ext = path.extname(filePath).replace(".", "").toLowerCase() || "jpg";
    const buffer = await fs.promises.readFile(filePath);
    const mime = ext === "jpg" ? "jpeg" : ext;
    return { dataUrl: `data:image/${mime};base64,${buffer.toString("base64")}`, ext };
  }

  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`拉取图片失败 ${res.status}：${imageUrl}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  const ext = EXT_BY_MIME[mime] || "jpg";
  return { dataUrl: `data:image/${mime === "jpg" ? "jpeg" : mime};base64,${buffer.toString("base64")}`, ext };
}

/** POST /api/upload —— 把一张图传到官网，返回站内 URL（/uploads/xxx）。 */
async function uploadImage(cover: CoverData, filename: string): Promise<string> {
  const res = await fetch(`${API}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      filename: filename.replace(/\.(png|jpe?g|webp|gif)$/i, ""),
      dataUrl: cover.dataUrl
    }),
    signal: AbortSignal.timeout(30_000)
  });
  const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
  if (!res.ok || !payload.ok || !payload.url) {
    throw new Error(`图片上传失败 ${res.status} ${payload.error || ""}`);
  }
  return payload.url;
}

export type HgwxPublishOptions = {
  /** 覆盖 hgwx 一级分类（产品热点/全网热点），默认按内容库分类映射 */
  hgwxCategory?: string;
  /** 角标，如「今日必看」 */
  badge?: string;
  /** 排序权重，越大越靠前 */
  sort?: number;
  /** 强制重新发布（忽略幂等记录） */
  force?: boolean;
};

export type HgwxPublishResult = {
  recordId: string;
  remoteId: string | null;
  remoteUrl: string | null;
  title: string;
  skipped?: boolean;
  message?: string;
};

/**
 * 发布一条内容库条目到官网好物推荐。返回写入的 PublishRecord id。
 * 失败时也会落一条 FAILED 记录（便于「发布管理」里看到失败原因），
 * 然后把异常继续抛给调用方。
 */
export async function publishContentToHgwx(
  contentItemId: string,
  publisher: string,
  options: HgwxPublishOptions = {}
): Promise<HgwxPublishResult> {
  const item = await prisma.contentItem.findUnique({ where: { id: contentItemId } });
  if (!item) throw new Error("内容不存在。");

  // 幂等：同一条内容同标题已成功发布过 → 直接跳过。
  if (!options.force) {
    const existed = await prisma.publishRecord.findFirst({
      where: { contentItemId: item.id, channel: HGWX_CHANNEL, status: "SUCCESS", title: item.title },
      orderBy: { publishedAt: "desc" }
    });
    if (existed) {
      return {
        recordId: existed.id,
        remoteId: existed.remoteId,
        remoteUrl: existed.remoteUrl,
        title: existed.title,
        skipped: true,
        message: "该内容已发布过，跳过重复发布。"
      };
    }
  }

  try {
    if (!TOKEN) throw new Error("服务端未配置 HGWX_PUBLISH_TOKEN，发布接口未启用。");

    const { hgwxCategory: mappedCategory, type, platform } = categoryMapping(item.category);
    const hgwxCategory = options.hgwxCategory?.trim() || mappedCategory;

    // 1. 封面 + 图集（前 3 张内联图）先传官网拿站内 URL
    let coverUrl: string | undefined;
    const gallery: string[] = [];
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

    if (item.coverImageUrl) {
      const data = await loadImageAsDataUrl(item.coverImageUrl);
      coverUrl = await uploadImage(data, `cover-${stamp}`);
    }

    let inlineImages: string[] = [];
    try {
      const parsed = JSON.parse(item.inlineImagesJson || "[]");
      if (Array.isArray(parsed)) {
        inlineImages = parsed.filter((u): u is string => typeof u === "string" && !!u);
      }
    } catch {
      inlineImages = [];
    }
    for (const [idx, image] of inlineImages.slice(0, 3).entries()) {
      try {
        const data = await loadImageAsDataUrl(image);
        gallery.push(await uploadImage(data, `gallery-${stamp}-${idx + 1}`));
      } catch (error) {
        console.error("[hgwx-publish] 图集上传失败（跳过该图）：", error);
      }
    }
    // 2. 推送条目
    const remoteItem: Record<string, unknown> = {
      title: item.title,
      summary: buildSummary(item.body),
      cover: coverUrl,
      gallery,
      tags: [platform, "AI好物", "数字员工"],
      category: hgwxCategory,
      type,
      platform,
      source: "AiWorker",
      status: "published",
      publishedAt: new Date().toISOString()
    };
    if (options.badge) remoteItem.badge = options.badge;
    if (typeof options.sort === "number") remoteItem.sort = options.sort;

    const res = await fetch(`${API}/api/recommends`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ items: [remoteItem] }),
      signal: AbortSignal.timeout(30_000)
    });
    const payload = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      items?: Array<{ id?: string }>;
      error?: string;
    };
    if (!res.ok || !payload.ok) {
      throw new Error(`官网发布失败 ${res.status} ${payload.error || ""}`);
    }
    const remoteId = payload.items?.[0]?.id || null;

    // 3. 落发布记录
    const record = await prisma.publishRecord.create({
      data: {
        contentItemId: item.id,
        channel: HGWX_CHANNEL,
        remoteId,
        remoteUrl: `${API}/`,
        title: item.title,
        publisher,
        status: "SUCCESS",
        publishedAt: new Date()
      }
    });

    return {
      recordId: record.id,
      remoteId,
      remoteUrl: record.remoteUrl,
      title: item.title
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.publishRecord.create({
      data: {
        contentItemId: item.id,
        channel: HGWX_CHANNEL,
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

/**
 * 定时任务批量发布：把当天入库的内容自动推到官网。
 * 返回每条的发布结果（成功/跳过/失败都归一成结果，不中断批次）。
 */
export async function publishRecentContentToHgwx(
  userId: string,
  publisher: string,
  since: Date
): Promise<HgwxPublishResult[]> {
  const items = await prisma.contentItem.findMany({
    where: { userId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });
  const results: HgwxPublishResult[] = [];
  for (const { id } of items) {
    try {
      results.push(await publishContentToHgwx(id, publisher));
    } catch (error) {
      results.push({
        recordId: "",
        remoteId: null,
        remoteUrl: null,
        title: "",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}
