import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { getIngestToken, isValidAgentToken } from "@/lib/platform-config";
import { publishContentToHgwx, HGWX_CHANNEL } from "@/lib/hgwx-publish";
import { publishContentToHealing, HEALING_CHANNEL } from "@/lib/healing-publish";
import { publishContentToFrontier, FRONTIER_CHANNEL } from "@/lib/frontier-publish";
import {
  PUBLISH_CHANNEL_LABEL,
  loadUserPlatformAuth,
  resolvePublishChannels,
  type PublishChannelKey
} from "@/lib/platform-auth-context";
import { resolvePublishTargets } from "@/lib/publish-targets";

/**
 * POST /api/publish/pending —— 批量发布（按「内容归属账号」的授权渠道）。
 *
 * 供 OpenClaw 定时任务 / 会话里的助手调用：把内容库条目自动推到该内容所属用户在
 * 「平台授权管理」里已授权的渠道：
 * - 授权了官网（好物推荐）→ 发官网好物推荐
 * - 授权了官网-AI回忆录（心灵驿站）→ 推送心灵驿站
 * 未授权的渠道一律不发；一个都没授权时跳过并说明。**令牌由服务端读取，调用方不需要提供。**
 *
 * 鉴权：Bearer CONTENT_INGEST_TOKEN（不使用登录态）。
 *
 * 请求体：
 * {
 *   "phone": "13800138000",          // 可选：显式指定账号；不传时按内容归属自动判定
 *   "channels": ["healing"],         // 可选：收窄渠道；缺省用该内容归属账号的全部已授权渠道
 *   "resolveOnly": true,             // 可选：只解析目标不发布（dry-run）
 *   "items": [
 *     { "contentId": "c…" },                                  // 二选一
 *     { "title": "标题关键词", "hgwxCategory": "产品热点" }    // 按关键词找最新一条匹配内容
 *   ]
 * }
 *
 * 发布是幂等的：同一条内容同标题已成功发布过会跳过，重复调用安全。
 */
export const dynamic = "force-dynamic";

type PublishItem = {
  contentId?: string;
  /** 没有 contentId 时可按标题关键词定位内容 */
  title?: string;
  hgwxCategory?: string;
  category?: string;
};

const KNOWN_CHANNELS = new Set<string>(["hgwx", HGWX_CHANNEL, "healing", HEALING_CHANNEL, "xinling", "aiworker", FRONTIER_CHANNEL]);

function normalizeChannel(input: string): PublishChannelKey | null {
  const channel = input.trim();
  if (channel === "hgwx" || channel === HGWX_CHANNEL) return "hgwx";
  if (channel === "healing" || channel === HEALING_CHANNEL || channel === "xinling") return "healing";
  if (channel === "aiworker" || channel === FRONTIER_CHANNEL) return "aiworker";
  return null;
}

function extractToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return (request.headers.get("x-ingest-token") || "").trim();
}

export async function POST(request: Request) {
  const expected = getIngestToken();
  if (!expected) {
    return jsonError("服务端未配置平台 Agent 令牌（系统配置 → 平台 Agent 令牌），发布接口未启用。", 503);
  }
  if (!isValidAgentToken(extractToken(request))) {
    return jsonError("发布令牌无效。", 401);
  }

  const payload = await readJson<{
    phone?: string;
    channels?: string[];
    items?: PublishItem[];
    resolveOnly?: boolean;
  }>(request);
  const items = payload.items || [];
  if (items.length === 0) {
    return jsonError("请求体缺少 items（非空数组）。");
  }

  const requestedChannels = payload.channels || [];
  const unknown = requestedChannels.filter((c) => !KNOWN_CHANNELS.has(String(c).trim()));
  if (unknown.length > 0) {
    return jsonError(`暂不支持的发布渠道：${unknown.join("、")}（支持 ${[...KNOWN_CHANNELS].join(" / ")}）。`);
  }
  const requestedKeys = requestedChannels
    .map((c) => normalizeChannel(String(c)))
    .filter((c): c is PublishChannelKey => Boolean(c));

  // 默认账号（仅在内容定位不到归属时使用）
  const fallbackPhone = payload.phone || process.env.CONTENT_INGEST_PHONE || "";
  const fallbackUser = fallbackPhone
    ? await prisma.user.findUnique({
        where: { phone: fallbackPhone },
        select: { id: true, phone: true }
      })
    : await prisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, phone: true } });

  // ---- 目标解析：contentId 优先；否则按标题关键词找最新一条匹配内容（与删除接口共用）----
  const targets = await resolvePublishTargets(items, fallbackUser);

  // ---- 授权渠道：按每条内容的归属账号取（缓存，避免重复查库）----
  const authCache = new Map<string, PublishChannelKey[]>();
  async function authorizedChannelsFor(userId: string | null): Promise<PublishChannelKey[]> {
    const target = userId ?? fallbackUser?.id;
    if (!target) return [];
    const cached = authCache.get(target);
    if (cached) return cached;
    const channels = resolvePublishChannels(await loadUserPlatformAuth(target));
    authCache.set(target, channels);
    return channels;
  }

  const ownersPhones = [...new Set(targets.map((t) => t.phone ?? fallbackUser?.phone ?? null))].filter(
    (p): p is string => Boolean(p)
  );

  if (payload.resolveOnly) {
    const resolved = [];
    for (const t of targets) {
      resolved.push({
        ok: Boolean(t.contentId),
        contentId: t.contentId,
        title: t.title,
        phone: t.phone ?? fallbackUser?.phone ?? null,
        authorizedChannels: (await authorizedChannelsFor(t.userId)).map((c) => PUBLISH_CHANNEL_LABEL[c]),
        error: t.error
      });
    }
    return jsonOk({ resolveOnly: true, publisher: ownersPhones.join(" / "), resolved });
  }

  // ---- 逐条按该条内容归属账号的授权渠道发布 ----
  const results: Array<Record<string, unknown>> = [];
  const skippedUnauthorized: string[] = [];
  const usedChannels = new Set<string>();

  for (const target of targets) {
    if (!target.contentId || !target.userId) {
      results.push({ ok: false, error: target.error || "缺少可发布的内容", title: target.title });
      continue;
    }
    const authorized = await authorizedChannelsFor(target.userId);
    if (requestedKeys.length > 0) {
      for (const key of requestedKeys) {
        if (!authorized.includes(key)) skippedUnauthorized.push(PUBLISH_CHANNEL_LABEL[key]);
      }
    }
    const channels = requestedKeys.length > 0
      ? requestedKeys.filter((c) => authorized.includes(c))
      : authorized;

    if (channels.length === 0) {
      results.push({
        ok: true,
        skipped: true,
        contentId: target.contentId,
        title: target.title,
        phone: target.phone,
        message:
          requestedKeys.length > 0
            ? `该内容归属账号（${target.phone ?? "未知"}）未授权 ${requestedKeys.map((c) => PUBLISH_CHANNEL_LABEL[c]).join("、")}`
            : `该内容归属账号（${target.phone ?? "未知"}）在「平台授权管理」里还没有可自动发布的渠道`
      });
      continue;
    }

    for (const channel of channels) {
      usedChannels.add(PUBLISH_CHANNEL_LABEL[channel]);
      try {
        if (channel === "healing") {
          const result = await publishContentToHealing(target.contentId, target.userId, target.phone || "", {
            category: target.category
          });
          results.push({
            ok: true,
            channel,
            channelLabel: PUBLISH_CHANNEL_LABEL[channel],
            phone: target.phone,
            ...result
          });
        } else if (channel === "aiworker") {
          const result = await publishContentToFrontier(target.contentId, target.userId, target.phone || "", {
            tag: target.category
          });
          results.push({
            ok: true,
            channel,
            channelLabel: PUBLISH_CHANNEL_LABEL[channel],
            phone: target.phone,
            ...result
          });
        } else {
          const result = await publishContentToHgwx(target.contentId, target.phone || "", {
            hgwxCategory: target.hgwxCategory
          });
          results.push({
            ok: true,
            channel,
            channelLabel: PUBLISH_CHANNEL_LABEL[channel],
            phone: target.phone,
            ...result
          });
        }
      } catch (error) {
        results.push({
          ok: false,
          channel,
          channelLabel: PUBLISH_CHANNEL_LABEL[channel],
          contentId: target.contentId,
          title: target.title,
          phone: target.phone,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const successCount = results.filter((r) => r.ok && !r.skipped).length;
  const skipMessages = results
    .map((r) => (typeof r.message === "string" ? r.message : typeof r.error === "string" ? r.error : ""))
    .filter(Boolean);
  return jsonOk({
    publisher: ownersPhones.join(" / "),
    usedChannels: [...usedChannels],
    skippedUnauthorized: [...new Set(skippedUnauthorized)],
    received: items.length,
    successCount,
    results,
    ...(successCount === 0 && skipMessages.length > 0
      ? { message: `未发布任何内容：${skipMessages.join("；")}` }
      : {})
  });
}
