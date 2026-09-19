import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { publishContentToHgwx, HGWX_CHANNEL } from "@/lib/hgwx-publish";

/**
 * POST /api/publish/pending —— 定时任务批量发布。
 *
 * 供 OpenClaw 定时任务在内容入库后把当天内容自动推到官网好物推荐。
 * 鉴权同入库接口：Bearer CONTENT_INGEST_TOKEN（不使用登录态）。
 *
 * 请求体：
 * {
 *   "phone": "13800138000",                       // 可选，缺省取 CONTENT_INGEST_PHONE
 *   "items": [ { "contentId": "…", "hgwxCategory": "产品热点" } ]
 * }
 *
 * 发布是幂等的：同一条内容同标题已成功发布过会跳过，重复调用安全。
 */
export const dynamic = "force-dynamic";

type PublishItem = { contentId?: string; hgwxCategory?: string };

function extractToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return (request.headers.get("x-ingest-token") || "").trim();
}

export async function POST(request: Request) {
  const expected = process.env.CONTENT_INGEST_TOKEN?.trim();
  if (!expected) {
    return jsonError("服务端未配置 CONTENT_INGEST_TOKEN，发布接口未启用。", 503);
  }
  if (extractToken(request) !== expected) {
    return jsonError("发布令牌无效。", 401);
  }

  const payload = await readJson<{ phone?: string; items?: PublishItem[] }>(request);
  const items = payload.items || [];
  if (items.length === 0) {
    return jsonError("请求体缺少 items（非空数组）。");
  }

  const phone = payload.phone || process.env.CONTENT_INGEST_PHONE || "";
  const user = phone
    ? await prisma.user.findUnique({ where: { phone } })
    : await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!user) {
    return jsonError(`找不到发布归属账号（${phone || "未配置"}）。`, 404);
  }

  const results: Array<Record<string, unknown>> = [];
  for (const item of items) {
    if (!item?.contentId) {
      results.push({ ok: false, error: "缺少 contentId" });
      continue;
    }
    try {
      const result = await publishContentToHgwx(item.contentId, user.phone, {
        hgwxCategory: item.hgwxCategory
      });
      results.push({ ok: true, ...result });
    } catch (error) {
      results.push({
        ok: false,
        contentId: item.contentId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  return jsonOk({
    channel: HGWX_CHANNEL,
    publisher: user.phone,
    received: items.length,
    successCount,
    results
  });
}
