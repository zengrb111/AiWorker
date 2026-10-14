import { NextRequest } from "next/server";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { ingestContentItems, type IngestItem } from "@/lib/content-ingest";

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
  const expected = process.env.CONTENT_INGEST_TOKEN?.trim();
  if (!expected) {
    return jsonError("服务端未配置 CONTENT_INGEST_TOKEN，入库接口未启用。", 503);
  }
  if (extractToken(request) !== expected) {
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

  // ── 归属账号解析 ────────────────────────────────────────────────
  // 内容库按账号隔离，写错账号在界面上就是「完全看不到内容」。
  // 优先级：显式 userId > sessionKey 里的 user-<id> > 显式 phone > 环境变量默认 > 最早创建的账号。
  //
  // 关键约束：**显式指定了归属却查不到账号时直接报错**，绝不静默退回默认账号。
  // 否则内容会悄悄写进别人的库（2026-10-13「13800138003 任务产出跑到 13800138001」就是这么发生的）。
  const sessionUserId =
    /(?:^|[:\s])user-([A-Za-z0-9_-]+)/.exec((body.sessionKey || "").trim())?.[1] || "";
  const wantedUserId = ((body.userId || "").trim() || sessionUserId).trim();
  const wantedPhone = wantedUserId
    ? ""
    : ((body.phone || "").trim() || (process.env.CONTENT_INGEST_PHONE || "").trim());

  const user = wantedUserId
    ? await prisma.user.findUnique({ where: { id: wantedUserId } })
    : wantedPhone
      ? await prisma.user.findUnique({ where: { phone: wantedPhone } })
      : await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });

  if (!user) {
    if (wantedUserId) {
      return jsonError(
        `找不到 id 为 ${wantedUserId} 的账号（请检查传入的 sessionKey / userId 是否正确）。`,
        404
      );
    }
    if (wantedPhone) {
      return jsonError(`找不到手机号为 ${wantedPhone} 的账号。`, 404);
    }
    return jsonError("库里还没有任何账号，无法确定入库归属。", 404);
  }

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
