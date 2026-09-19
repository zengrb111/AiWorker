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
 *   { "items": [{ "title": "...", "body": "# ...", "category": "小红书" }] }
 *   [{ "title": "...", "body": "...", "category": "公众号" }]
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

  const payload = await readJson<{ items?: IngestItem[]; phone?: string } | IngestItem[]>(request);
  const isArray = Array.isArray(payload);
  const items = (isArray ? payload : payload.items) || [];
  if (!Array.isArray(items) || items.length === 0) {
    return jsonError("请求体缺少 items（非空数组）。");
  }
  if (items.length > MAX_ITEMS) {
    return jsonError(`单次最多 ${MAX_ITEMS} 条，本次收到 ${items.length} 条。`);
  }

  const phone = (isArray ? "" : payload.phone) || process.env.CONTENT_INGEST_PHONE || "";
  const user = phone
    ? await prisma.user.findUnique({ where: { phone } })
    : await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!user) {
    return jsonError(
      phone ? `找不到手机号为 ${phone} 的账号。` : "库里还没有任何账号，无法确定入库归属。",
      404
    );
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
