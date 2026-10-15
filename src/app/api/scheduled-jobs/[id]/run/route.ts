import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { runScheduledJob } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

/**
 * POST /api/scheduled-jobs/[id]/run —— 立即执行一次（手动触发，调试用）。
 * 任务可能要跑几分钟，所以立即返回，结果写回任务记录（lastStatus/lastResult）。
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const job = await prisma.scheduledJob.findUnique({ where: { id: params.id } });
  if (!job || job.userId !== user.id) return jsonError("任务不存在。", 404);

  void runScheduledJob(job.id).catch((error) => {
    console.error(`[scheduler] 手动执行任务 ${job.name} 失败：`, error);
  });
  return jsonOk({ triggered: job.id, message: "已触发，稍后可在任务列表查看执行结果。" });
}
