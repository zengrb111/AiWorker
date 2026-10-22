import { NextRequest } from "next/server";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { ingestContentItems, type IngestItem } from "@/lib/content-ingest";
import { resolveOwnerFromBody } from "@/lib/ingest-owner";
import { getIngestToken, isValidAgentToken } from "@/lib/platform-config";

/**
 * POST /api/content/ingest —— 外部（OpenClaw 定时任务）批量写入内容库。
 *
 * 鉴权走 Bearer 令牌（`CONTENT_INGEST_TOKEN`），不使用登录态 —— 定时任务
 * 跑在 OpenClaw 侧，没有 Web 会话。
 *
 * 请求体（两种都支持）：
 *   { "items": [{ "title": "...", "body": "# ...", "category": "小红书" }], "sessionKey": "..." }
 *   [{ "title": "...", "body": "...", "category": "公众号" }]
 *
 * 归属账号（内容库按账号隔离，写错就看不到内容），可任选其一：
 *   --userId   / body.userId     直接给账号 id（最精确）
 *   --sessionKey / body.sessionKey  形如 agent:main:user-<userId>，服务端自动解析
 *   body.phone                   手机号
 *   都不给 → 落到 CONTENT_INGEST_PHONE 或库里最早的账号（仅作兜底）
 *
 * 返回 { saved: [...], skipped: [...] }，skipped 里带原因，方便任务自查。
 */

export const dynamic = "force-dynamic";

/** 单次最多接收的条目数，防止误传大包。 */
const MAX_ITEMS = 20;

function extractToken(request: NextRequest): string {
  const header = request.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return (request.headers.get("x-ingest-token") || "").trim();
}

export async function POST(request: NextRequest) {
  const expected = getIngestToken();
  if (!expected) {
    return jsonError("服务端未配置平台 Agent 令牌（系统配置 → 平台 Agent 令牌），入库接口未启用。", 503);
  }
  if (!isValidAgentToken(extractToken(request))) {
    return jsonError("入库令牌无效。", 401);
  }

  const payload = await readJson<
    { items?: IngestItem[]; phone?: string; userId?: string; sessionKey?: string } | IngestItem[]
  >(request);
  const isArray = Array.isArray(payload);
  const body = (isArray ? {} : payload) as {
    items?: IngestItem[];
    phone?: string;
    userId?: string;
    sessionKey?: string;
  };
  const items = (isArray ? payload : body.items) || [];
  if (!Array.isArray(items) || items.length === 0) {
    return jsonError("请求体缺少 items（非空数组）。");
  }
  if (items.length > MAX_ITEMS) {
    return jsonError(`单次最多 ${MAX_ITEMS} 条，本次收到 ${items.length} 条。`);
  }

  // ── 归属账号解析（与 /api/knowledge/context 共用同一套规则）──
  // 关键约束：显式指定了归属却查不到账号时直接报错，绝不静默退回默认账号。
  const owner = await resolveOwnerFromBody(body);
  if (!owner.ok) {
    return jsonError(owner.error, owner.status);
  }
  const user = owner.user;

  const result = await ingestContentItems(user.id, items);
  return jsonOk({
    account: user.phone,
    received: items.length,
    savedCount: result.saved.length,
    skippedCount: result.skipped.length,
    saved: result.saved,
    skipped: result.skipped
  });
}
