import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
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
  // 视频条目（内容库分类「视频」或 huashu 成片）默认归到「陪伴日常」
  if (value.includes("视频")) return "陪伴日常";
  if (value.includes("小红书")) return "陪伴日常";
  if (value.includes("公众号")) return "时光信箱";
  if (value.includes("头条") || value.includes("微头条")) return "疗愈短文";
  return "亲情手记";
}

type UploadTarget = { domain: string; token: string };

type Asset = { buffer: Buffer; mime: string; ext: string };

/** 本地 /videos、/uploads 或远程 URL → 二进制。视频与图片共用。 */
async function readAsset(assetUrl: string): Promise<Asset> {
  if (assetUrl.startsWith("/uploads/") || assetUrl.startsWith("/videos/")) {
    const filePath = path.join(process.cwd(), "public", assetUrl);
    const ext = path.extname(filePath).replace(".", "").toLowerCase() || "bin";
    const buffer = await fs.promises.readFile(filePath);
    const mime =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "mp4"
          ? "video/mp4"
          : ext === "webm"
            ? "video/webm"
            : ext === "mov"
              ? "video/quicktime"
              : `image/${ext}`;
    return { buffer, mime, ext };
  }
  const res = await fetch(assetUrl, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`拉取素材失败 ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
  const ext = (mime.split("/")[1] || "bin").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
  return { buffer, mime, ext };
}

/** POST /api/healing/upload —— 上传任意素材（图片 / 视频），返回站内 URL */
async function uploadAsset(target: UploadTarget, asset: Asset, prefix: string): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(asset.buffer)], { type: asset.mime }),
    `${prefix}-${Date.now()}.${asset.ext}`
  );
  const res = await fetch(`${target.domain}/api/healing/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${target.token}` },
    body: form,
    signal: AbortSignal.timeout(180000),
  });
  const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; detail?: string };
  if (!res.ok || !payload.ok || !payload.url) {
    throw new Error(`素材上传失败 ${res.status} ${payload.detail || ""}`.trim());
  }
  return payload.url;
}

/** 本地 /uploads/... 或远程 URL → 二进制（图片） */
async function readImage(imageUrl: string): Promise<{ buffer: Buffer; mime: string }> {
  const asset = await readAsset(imageUrl);
  return { buffer: asset.buffer, mime: asset.mime };
}

/** POST /api/healing/upload —— 上传一张图，返回站内 URL */
async function uploadImage(target: UploadTarget, imageUrl: string, prefix: string): Promise<string> {
  const asset = await readAsset(imageUrl);
  return uploadAsset(target, asset, prefix);
}

/** ffmpeg/ffprobe 是否可用（不可用时视频仍可推送，只是没有时长与封面帧）。 */
function hasFfmpeg(): boolean {
  try {
    const probe = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
    return spawnSync(probe, ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** 用 ffprobe 取时长（秒），失败返回 null。 */
async function probeMediaDuration(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const value = Number.parseFloat(out.trim());
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    });
  });
}

/**
 * 从视频里抽一帧当竖版封面（poster）。
 *
 * 频道列表优先用 video.poster 当缩略图；没有 poster 时会用 `<video preload=metadata>`
 * 做封面，首帧常常是白/黑，不好看。所以能抽就抽一张。
 */
async function extractPosterFrame(videoPath: string, atSeconds = 0.6): Promise<Asset | null> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "healing-poster-"));
  const target = path.join(dir, "poster.jpg");
  try {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-ss",
        String(atSeconds),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=720:-1",
        target,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    if (!ok) return null;
    const buffer = await fs.promises.readFile(target);
    return { buffer, mime: "image/jpeg", ext: "jpg" };
  } catch {
    return null;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
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

  // 幂等：同一篇内容（同标题）已成功推送过 → 直接跳过。
  // 视频例外：Studio 改完会出 vN，再推一次就是要用新成片覆盖同一条，
  // 所以视频条目不做跳过（sync 的 id 稳定，upsert 只会更新不会重复）。
  if (!options.force && !item.videoUrl) {
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
    // 视频条目走视频链路：上传 mp4 + 抽帧当封面帧，写入 post.video
    // （频道详情页用 full.video.url 渲染播放器，列表优先用 video.poster 当缩略图）。
    const isVideo = Boolean(item.videoUrl);
    let videoPayload: { url: string; duration: number | null; poster: string } | null = null;
    let cover = "";

    if (isVideo) {
      const localPath = item.videoUrl!.startsWith("/videos/") || item.videoUrl!.startsWith("/uploads/")
        ? path.join(process.cwd(), "public", item.videoUrl!)
        : null;
      const asset = await readAsset(item.videoUrl!);
      const sizeMb = asset.buffer.byteLength / 1024 / 1024;
      if (sizeMb > 80) {
        throw new Error(`视频 ${sizeMb.toFixed(1)}MB 偏大，频道上传上限按 80MB 保守限制，请先压缩。`);
      }

      const remoteVideo = await uploadAsset(target, asset, "video");

      // 封面帧优先级：内容库已有本地封面 → 视频抽帧 → 无（频道会用视频首帧兜底）
      let poster = "";
      if (item.coverImageUrl && item.coverImageUrl.startsWith("/uploads/")) {
        poster = await uploadImage(target, item.coverImageUrl, "poster").catch(() => "");
      }
      if (!poster && localPath && hasFfmpeg()) {
        const frame = await extractPosterFrame(localPath);
        if (frame) poster = await uploadAsset(target, frame, "poster").catch(() => "");
      }

      const duration = localPath ? await probeMediaDuration(localPath) : null;
      videoPayload = { url: remoteVideo, duration, poster };
      cover = poster;
    } else {
      // 封面闸门：与好物推荐一致，必须先有本地封面图（占位图先触发免费生图）
      if (!item.coverImageUrl || !item.coverImageUrl.startsWith("/uploads/")) {
        const localCover = await generateCoverImage(
          item.title,
          item.body || "",
          coverPlatformOf(item.category)
        ).catch(() => null);
        if (!localCover) throw new Error("封面尚未生成（免费生图失败），暂缓推送，待封面就绪后重试。");
        await prisma.contentItem.update({ where: { id: item.id }, data: { coverImageUrl: localCover } });
        item.coverImageUrl = localCover;
      }
      cover = await uploadImage(target, item.coverImageUrl, "cover");
    }

    // 图集（前 3 张内联图）：视频条目通常没有内联图，循环自然为空
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
      // 视频条目通常没有正文：给一句能站得住的说明，频道卡片/详情不至于空白
      summary: isVideo
        ? buildSummary(item.body || "", 140) || "AI 回忆录 · 竖版短片"
        : buildSummary(item.body || "", 140),
      content: mdToPlainText(item.body || ""),
      cover,
      images,
      category: healingCategory(item.category, options.category),
      tags,
      author: publisher,
      source: SOURCE,
      source_url: "",
      // 频道详情页用 video.url 渲染播放器；poster 缺省时退回 cover
      video: videoPayload,
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

export type HealingDeleteResult = {
  ok: boolean;
  /** 线上频道侧的条目 id */
  remoteId: string | null;
  title: string | null;
  /** 已经不在线上（可能是被手动删过） */
  alreadyGone?: boolean;
  message: string;
};

/**
 * 从 AI回忆录官网「心灵驿站」频道删除一条已发布的图文。
 *
 * 删除依据是本地的发布记录（PublishRecord）：取这条内容在该频道最近一次
 * 发布成功的 remoteId，调官网 `DELETE /api/healing/posts/{id}`。
 * 成功/已不存在都会把记录状态标记为 DELETED，这样之后再点发布不会被幂等规则拦住。
 */
export async function deleteContentFromHealing(
  contentItemId: string,
  userId: string,
  options: { remoteId?: string } = {}
): Promise<HealingDeleteResult> {
  const item = await prisma.contentItem.findFirst({
    where: { id: contentItemId, userId },
    select: { id: true, title: true },
  });
  if (!item) throw new Error("内容不存在。");

  const loaded = await loadHealingCredential(userId);
  if (!loaded) {
    throw new Error(
      "尚未配置心灵驿站授权。请到「平台授权管理」给「官网-AI回忆录」填写 https://aimemory.cafe 与令牌（或把官网卡片配置为 aimemory.cafe）。"
    );
  }

  const record = await prisma.publishRecord.findFirst({
    where: {
      contentItemId: item.id,
      channel: HEALING_CHANNEL,
      status: "SUCCESS",
      ...(options.remoteId ? { remoteId: options.remoteId } : {}),
    },
    orderBy: { publishedAt: "desc" },
  });

  const remoteId = options.remoteId || record?.remoteId || null;
  if (!remoteId) {
    return {
      ok: false,
      remoteId: null,
      title: item.title,
      message: "本地没有该内容的推送成功记录，无法确定线上条目；请到心灵驿站后台确认。",
    };
  }

  const base = loaded.credential.domain.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/healing/posts/${encodeURIComponent(remoteId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${loaded.credential.token}` },
    signal: AbortSignal.timeout(20_000),
  });

  if (res.ok) {
    if (record) {
      await prisma.publishRecord.update({ where: { id: record.id }, data: { status: "DELETED" } });
    }
    return { ok: true, remoteId, title: item.title, message: `已从心灵驿站删除（${remoteId}）` };
  }

  if (res.status === 404) {
    if (record) {
      await prisma.publishRecord.update({ where: { id: record.id }, data: { status: "DELETED" } });
    }
    return {
      ok: true,
      remoteId,
      title: item.title,
      alreadyGone: true,
      message: `线上已不存在该条目（${remoteId}），本地记录已标记为已删除`,
    };
  }

  const text = await res.text().catch(() => "");
  throw new Error(`心灵驿站删除失败 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ""}`);
}
