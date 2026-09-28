import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/content/recent —— 列出最近的内容库条目及其发布情况（供会话/定时任务自查）。
 *
 * 鉴权：Bearer CONTENT_INGEST_TOKEN（不用登录态）。
 *
 * 查询参数：
 *   days=1            最近几天（默认 1，即今天起）
 *   phone=13800138001 只看某个归属账号（可选）
 *   limit=50          最多返回多少条（默认 50）
 *
 * 返回：{ items: [{ id, title, category, createdAt, phone, publishes: [{ channel, status, remoteId, publishedAt }] }] }
 * 用途：清理重复内容、确认某篇有没有发出去、查线上条目 id。
 */
export const dynamic = "force-dynamic";

function extractToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return (request.headers.get("x-ingest-token") || "").trim();
}

export async function GET(request: Request) {
  const expected = process.env.CONTENT_INGEST_TOKEN?.trim();
  if (!expected) {
    return jsonError("服务端未配置 CONTENT_INGEST_TOKEN，查询接口未启用。", 503);
  }
  if (extractToken(request) !== expected) {
    return jsonError("查询令牌无效。", 401);
  }

  const url = new URL(request.url);
  const days = Math.max(1, Math.min(60, Number(url.searchParams.get("days") || 1) || 1));
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50) || 50));
  const phone = (url.searchParams.get("phone") || process.env.CONTENT_INGEST_PHONE || "").trim();

  // 以本地时区的「今天 00:00」为起点
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));

  const owner = phone ? await prisma.user.findUnique({ where: { phone }, select: { id: true } }) : null;

  const items = await prisma.contentItem.findMany({
    where: {
      createdAt: { gte: since },
      ...(owner ? { userId: owner.id } : {})
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      title: true,
      category: true,
      createdAt: true,
      userId: true,
      publishRecords: {
        orderBy: { publishedAt: "desc" },
        select: {
          channel: true,
          status: true,
          remoteId: true,
          remoteUrl: true,
          publishedAt: true,
          error: true
        }
      }
    }
  });

  const phones = new Map<string, string>();
  for (const item of items) {
    if (!phones.has(item.userId)) {
      const user = await prisma.user.findUnique({
        where: { id: item.userId },
        select: { phone: true }
      });
      phones.set(item.userId, user?.phone || "");
    }
  }

  return jsonOk({
    days,
    since: since.toISOString(),
    count: items.length,
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      category: item.category,
      createdAt: item.createdAt,
      phone: phones.get(item.userId) || "",
      publishes: item.publishRecords
    }))
  });
}
