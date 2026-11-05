import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { nextRunAt } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

/**
 * GET /api/scheduled-jobs —— 当前登录用户的定时任务列表（**只读**）。
 *
 * 平台侧「定时任务」模块是纯查看器：只展示由龙虾（OpenClaw 网关 agent）经微信创建的任务
 * （source = "AGENT"）。新建 / 编辑 / 删除 / 立即执行一律在微信里跟龙虾聊，平台不再提供写操作。
 *
 * 到点执行与微信推送仍由 src/lib/scheduler 走 Prisma 直接完成，与本接口的只读化互不干扰。
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const jobs = await prisma.scheduledJob.findMany({
    where: { userId: user.id, source: "AGENT" },
    orderBy: { createdAt: "asc" }
  });
  // 下次执行时间由服务端算：cron 解析逻辑只放在这边一份，前端不做重复实现。
  // 暂停的任务不显示下次时间，避免「暂停了还显示要跑」的误解。
  return jsonOk({
    jobs: jobs.map((job) => ({
      ...job,
      nextRunAt: job.enabled
        ? job.runOnce
          ? job.oneShotAt && !job.lastRunAt
            ? new Date(job.oneShotAt).toISOString()
            : null
          : nextRunAt(job.cronExpr, job.timezone)?.toISOString() ?? null
        : null
    }))
  });
}
