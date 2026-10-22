import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { getIngestToken, isValidAgentToken } from "@/lib/platform-config";
import { HEALING_CHANNEL, deleteContentFromHealing } from "@/lib/healing-publish";
import { FRONTIER_CHANNEL, deleteContentFromFrontier } from "@/lib/frontier-publish";
import { PUBLISH_CHANNEL_LABEL, type PublishChannelKey } from "@/lib/platform-auth-context";
import { resolvePublishTargets } from "@/lib/publish-targets";

/**
 * POST /api/publish/delete —— 从线上渠道撤回（删除）已发布的内容。
 *
 * 供会话里的助手 / 定时任务调用：例如「把心灵驿站上那篇 XX 删掉」。
 * **令牌由服务端读取，调用方不需要提供。**
 *
 * 鉴权：Bearer CONTENT_INGEST_TOKEN（不使用登录态）。
 *
 * 请求体：
 * {
 *   "channels": ["healing"],            // 可选，默认 ["healing"]；目前仅心灵驿站支持删除
 *   "resolveOnly": true,                // 可选：只解析目标不删除（dry-run）
 *   "items": [
 *     { "contentId": "c…" },            // 二选一
 *     { "title": "标题关键词" }          // 按关键词找最新一条匹配内容
 *   ]
 * }
 *
 * 返回逐条结果 { ok, channel, remoteId, title, message }。
 */
export const dynamic = "force-dynamic";

const KNOWN_CHANNELS = new Set<string>(["healing", HEALING_CHANNEL, "xinling", "hgwx", "官网好物推荐", "aiworker", FRONTIER_CHANNEL]);
const DELETABLE: PublishChannelKey[] = ["healing", "aiworker"];

function normalizeChannel(input: string): PublishChannelKey | null {
  const channel = input.trim();
  if (channel === "hgwx" || channel === "官网好物推荐") return "hgwx";
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
    return jsonError("服务端未配置平台 Agent 令牌（系统配置 → 平台 Agent 令牌），删除接口未启用。", 503);
  }
  if (!isValidAgentToken(extractToken(request))) {
    return jsonError("删除令牌无效。", 401);
  }

  const payload = await readJson<{
    phone?: string;
    channels?: string[];
    items?: Array<{ contentId?: string; title?: string }>;
    resolveOnly?: boolean;
  }>(request);
  const items = payload.items || [];
  if (items.length === 0) {
    return jsonError("请求体缺少 items（非空数组）。");
  }

  const unknown = (payload.channels || []).filter((c) => !KNOWN_CHANNELS.has(String(c).trim()));
  if (unknown.length > 0) {
    return jsonError(`暂不支持的渠道：${unknown.join("、")}。`);
  }
  const requestedKeys = (payload.channels?.length ? payload.channels : DELETABLE)
    .map((c) => normalizeChannel(String(c)))
    .filter((c): c is PublishChannelKey => Boolean(c));
  const channels = requestedKeys.filter((c) => DELETABLE.includes(c));
  const unsupported = requestedKeys.filter((c) => !DELETABLE.includes(c));

  const fallbackPhone = payload.phone || process.env.CONTENT_INGEST_PHONE || "";
  const fallbackUser = fallbackPhone
    ? await prisma.user.findUnique({ where: { phone: fallbackPhone }, select: { id: true, phone: true } })
    : null;

  const targets = await resolvePublishTargets(items, fallbackUser);

  if (payload.resolveOnly) {
    return jsonOk({
      resolveOnly: true,
      deletableChannels: channels.map((c) => PUBLISH_CHANNEL_LABEL[c]),
      unsupportedChannels: unsupported.map((c) => PUBLISH_CHANNEL_LABEL[c]),
      resolved: targets.map((t) => ({
        ok: Boolean(t.contentId),
        contentId: t.contentId,
        title: t.title,
        phone: t.phone,
        error: t.error
      }))
    });
  }

  const results: Array<Record<string, unknown>> = [];
  if (channels.length === 0) {
    return jsonOk({
      usedChannels: [],
      unsupportedChannels: unsupported.map((c) => PUBLISH_CHANNEL_LABEL[c]),
      successCount: 0,
      results,
      message: `暂不支持删除这些渠道：${unsupported.map((c) => PUBLISH_CHANNEL_LABEL[c]).join("、")}（目前仅支持删除「官网-AI回忆录（心灵驿站）」与「官网-AI员工（AI最前沿）」的内容）。`
    });
  }

  for (const target of targets) {
    if (!target.contentId || !target.userId) {
      results.push({ ok: false, error: target.error || "无法定位内容", title: target.title });
      continue;
    }
    for (const channel of channels) {
      try {
        const result =
          channel === "aiworker"
            ? await deleteContentFromFrontier(target.contentId, target.userId)
            : await deleteContentFromHealing(target.contentId, target.userId);
        results.push({
          ok: result.ok,
          channel,
          channelLabel: PUBLISH_CHANNEL_LABEL[channel],
          contentId: target.contentId,
          title: result.title,
          phone: target.phone,
          remoteId: result.remoteId,
          alreadyGone: result.alreadyGone ?? false,
          message: result.message
        });
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

  const successCount = results.filter((r) => r.ok).length;
  const messages = results
    .map((r) => (typeof r.message === "string" ? r.message : typeof r.error === "string" ? r.error : ""))
    .filter(Boolean);

  return jsonOk({
    usedChannels: channels.map((c) => PUBLISH_CHANNEL_LABEL[c]),
    unsupportedChannels: unsupported.map((c) => PUBLISH_CHANNEL_LABEL[c]),
    successCount,
    results,
    ...(successCount === 0 && messages.length > 0 ? { message: messages.join("；") } : {})
  });
}
