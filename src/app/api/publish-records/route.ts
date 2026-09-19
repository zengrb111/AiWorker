import { jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/**
 * GET /api/publish-records —— 发布管理列表。
 *
 * 返回当前账号的发布记录（标题快照 / 渠道 / 发布人 / 状态 / 时间），
 * 按 publishedAt 降序。`?status=failed` 只看失败记录。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requireUser();
  if (!user) {
    return jsonOk({ records: [], total: 0, note: "未登录。" });
  }

  const url = new URL(request.url);
  const statusFilter = (url.searchParams.get("status") || "").trim();
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 200);

  const records = await prisma.publishRecord.findMany({
    where: {
      contentItem: { userId: user.id },
      ...(statusFilter ? { status: statusFilter.toUpperCase() } : {})
    },
    orderBy: { publishedAt: "desc" },
    take: limit,
    select: {
      id: true,
      contentItemId: true,
      channel: true,
      title: true,
      publisher: true,
      status: true,
      error: true,
      remoteId: true,
      remoteUrl: true,
      publishedAt: true
    }
  });

  return jsonOk({
    records: records.map((record) => ({
      ...record,
      publishedAt: record.publishedAt.toISOString()
    })),
    total: records.length
  });
}
