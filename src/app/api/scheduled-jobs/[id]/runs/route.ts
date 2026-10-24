/**
 * GET /api/scheduled-jobs/[id]/runs?limit=20 —— 某条任务的运行记录（最近的在前）。
 *
 * 只回当前用户自己的任务；默认 20 条，最多 50。
 */
import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const job = await prisma.scheduledJob.findUnique({ where: { id: params.id }, select: { userId: true } });
  if (!job || job.userId !== user.id) return jsonError("任务不存在。", 404);

  const limitRaw = Number(new URL(request.url).searchParams.get("limit") || 20);
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, Math.trunc(limitRaw))) : 20;

  const runs = await prisma.scheduledJobRun.findMany({
    where: { jobId: params.id },
    orderBy: { startedAt: "desc" },
    take: limit
  });

  return jsonOk({ runs });
}
