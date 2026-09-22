import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { generateCoverImage, coverPlatformOf } from "@/lib/image-gen";
import { loadHealingCredential } from "@/lib/platform-sync";
import { buildSummary, mdToPlainText } from "@/lib/hgwx-publish";

/**
 * AI回忆录官网「心灵驿站」频道推送链路（aimemory.cafe）。
 *
 * 官网开放接口（详见 https://aimemory.cafe/healing.html）：
 * - 写入：POST {domain}/api/healing/sync   头 Authorization: Bearer <TOKEN>
 *         体 { mode: "upsert" | "replace_source", source, posts: PostIn[] }
 * - 单篇：POST {domain}/api/healing/posts （本模块用批量 sync，便于一次推多篇）
 * - 上传：POST {domain}/api/healing/upload（multipart，file 字段）→ { ok, url }
 * - 公开：GET  {domain}/api/healing/posts | /meta | /feed.json
 *
 * 凭据来自「平台授权管理」里当前登录用户配置的官网授权（kind = healing），
 * 因此推送能力按用户隔离；幂等：同标题已成功推送过则跳过。
 */

export const HEALING_CHANNEL = "心灵驿站";
const SOURCE = "AiWorker";

/** 频道页地址（作为发布记录的 remoteUrl） */
function channelUrl(domain: string): string {
  return `${domain.replace(/\/+$/, "")}/healing.html`;
}

/**
 * 生成稳定的条目 id（hp_ + sha1(source|内容条目id)[:14]）。
 * 用内容条目 id 而不是标题/时间：即使发布记录丢失，重新推送也只会「更新同一篇」，
 * 不会因为时间戳变化而在频道里留下重复内容。
 */
function healingPostId(contentItemId: string): string {
  const raw = `${SOURCE}|${contentItemId}`;
  return "hp_" + crypto.createHash("sha1").update(raw, "utf8").digest("hex").slice(0, 14);
}

/** 内容库分类 → 心灵驿站频道分类（频道现有分类：亲情手记/疗愈短文/陪伴日常/时光信箱/声音记忆） */
function healingCategory(category?: string | null, override?: string): string {
  const custom = (override || "").trim();
  if (custom) return custom;
  const value = (category || "").trim();
  if (value.includes("小红书")) return "陪伴日常";
  if (value.includes("公众号")) return "时光信箱";
  if (value.includes("头条") || value.includes("微头条")) return "疗愈短文";
  return "亲情手记";
}

type UploadTarget = { domain: string; token: string };

/** 本地 /uploads/... 或远程 URL → 二进制 */
async function readImage(imageUrl: string): Promise<{ buffer: Buffer; mime: string }> {
  if (imageUrl.startsWith("/uploads/")) {
    const filePath = path.join(process.cwd(), "public", imageUrl);
    const ext = path.extname(filePath).replace(".", "").toLowerCase() || "jpg";
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, mime: ext === "jpg" ? "image/jpeg" : `image/${ext}` };
  }
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`拉取图片失败 ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  return { buffer, mime };
}

/** POST /api/healing/upload —— 上传一张图，返回站内 URL */
async function uploadImage(target: UploadTarget, imageUrl: string, prefix: string): Promise<string> {
  const { buffer, mime } = await readImage(imageUrl);
  const ext = mime.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mime }), `${prefix}-${Date.now()}.${ext}`);
  const res = await fetch(`${target.domain}/api/healing/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${target.token}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; detail?: string };
  if (!res.ok || !payload.ok || !payload.url) {
    throw new Error(`配图上传失败 ${res.status} ${payload.detail || ""}`.trim());
  }
  return payload.url;
}

export type HealingPublishOptions = {
  /** 覆盖频道分类（默认按内容库分类映射） */
  category?: string;
  /** 强制重新推送（忽略幂等记录） */
  force?: boolean;
  /** 公开时间（不传则用当前时间） */
  publishedAt?: string;
};

export type HealingPublishResult = {
  recordId: string;
  remoteId: string | null;
  remoteUrl: string | null;
  title: string;
  skipped?: boolean;
  message?: string;
};

/**
 * 把一条内容库条目推送到 AI回忆录官网「心灵驿站」频道。
 * 使用当前登录用户在「平台授权管理」配置的官网授权（kind = healing）。
 */
export async function publishContentToHealing(
  contentItemId: string,
  userId: string,
  publisher: string,
  options: HealingPublishOptions = {}
): Promise<HealingPublishResult> {
  const item = await prisma.contentItem.findFirst({ where: { id: contentItemId, userId } });
  if (!item) throw new Error("内容不存在。");

  const loaded = await loadHealingCredential(userId);
  if (!loaded) {
    throw new Error(
      "尚未配置心灵驿站授权。请到「平台授权管理」给「官网-AI回忆录」填写 https://aimemory.cafe 与令牌（或把官网卡片配置为 aimemory.cafe）。"
    );
  }
  const target: UploadTarget = { domain: loaded.credential.domain, token: loaded.credential.token };

  // 幂等：同一篇内容（同标题）已成功推送过 → 直接跳过
  if (!options.force) {
    const existed = await prisma.publishRecord.findFirst({
      where: { contentItemId: item.id, channel: HEALING_CHANNEL, status: "SUCCESS", title: item.title },
      orderBy: { publishedAt: "desc" },
    });
    if (existed) {
      return {
        recordId: existed.id,
        remoteId: existed.remoteId,
        remoteUrl: existed.remoteUrl,
        title: existed.title,
        skipped: true,
        message: "该内容已推送到心灵驿站，跳过重复推送。",
      };
    }
  }

  try {
    // 封面闸门：与好物推荐一致，必须先有本地封面图（占位图先触发智谱生图）
    if (!item.coverImageUrl || !item.coverImageUrl.startsWith("/uploads/")) {
      const localCover = await generateCoverImage(
        item.title,
        item.body || "",
        coverPlatformOf(item.category)
      ).catch(() => null);
      if (!localCover) throw new Error("封面尚未生成（智谱生图失败），暂缓推送，待封面就绪后重试。");
      await prisma.contentItem.update({ where: { id: item.id }, data: { coverImageUrl: localCover } });
      item.coverImageUrl = localCover;
    }

    const cover = await uploadImage(target, item.coverImageUrl, "cover");

    // 图集（前 3 张内联图）
    let inlineImages: string[] = [];
    try {
      const parsed = JSON.parse(item.inlineImagesJson || "[]");
      if (Array.isArray(parsed)) inlineImages = parsed.filter((u): u is string => typeof u === "string" && !!u);
    } catch {
      inlineImages = [];
    }
    const images: string[] = [];
    for (const [idx, image] of inlineImages.slice(0, 3).entries()) {
      try {
        images.push(await uploadImage(target, image, `g${idx + 1}`));
      } catch (error) {
        console.error("[healing-publish] 配图上传失败（跳过该图）：", error);
      }
    }

    const publishedAt = options.publishedAt || new Date().toISOString();
    const title = item.title;
    const postId = healingPostId(item.id);
    const publishPlatform = (item.category || "").trim();
    // 频道 tags：来源平台 + 正文里的 #话题（内容库不单独存话题字段）
    const bodyTopics = (item.body || "").match(/#[^\s#，。！？、]{1,20}/g) || [];
    const tags = [publishPlatform || "治愈", ...bodyTopics.map((t) => t.replace(/^#/, ""))]
      .filter((t, i, arr) => t && arr.indexOf(t) === i)
      .slice(0, 8);

    const post = {
      id: postId,
      title,
      summary: buildSummary(item.body || "", 140),
      content: mdToPlainText(item.body || ""),
      cover,
      images,
      category: healingCategory(item.category, options.category),
      tags,
      author: publisher,
      source: SOURCE,
      source_url: "",
      published_at: publishedAt,
    };

    const res = await fetch(`${target.domain}/api/healing/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify({ mode: "upsert", source: SOURCE, posts: [post] }),
      signal: AbortSignal.timeout(30000),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      inserted?: number;
      updated?: number;
      total?: number;
      detail?: string;
    };
    if (!res.ok || !payload.ok) {
      throw new Error(`心灵驿站推送失败 ${res.status} ${payload.detail || ""}`.trim());
    }

    const record = await prisma.publishRecord.create({
      data: {
        contentItemId: item.id,
        channel: HEALING_CHANNEL,
        remoteId: postId,
        remoteUrl: channelUrl(target.domain),
        title,
        publisher,
        status: "SUCCESS",
        publishedAt: new Date(),
      },
    });

    return {
      recordId: record.id,
      remoteId: postId,
      remoteUrl: record.remoteUrl,
      title,
      message: `已推送到心灵驿站（${payload.inserted ? "新增" : "更新"}，频道现有 ${payload.total ?? "-"} 篇）`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.publishRecord.create({
      data: {
        contentItemId: item.id,
        channel: HEALING_CHANNEL,
        title: item.title,
        publisher,
        status: "FAILED",
        error: message.slice(0, 500),
        publishedAt: new Date(),
      },
    });
    throw error;
  }
}
