import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { isValidCronExpr, nextRunAt } from "@/lib/scheduler";
import { sanitizeScheduledPrompt } from "@/lib/scheduled-job-prompt";

export const dynamic = "force-dynamic";

/**
 * GET  /api/scheduled-jobs —— 当前登录用户的定时任务列表
 * POST /api/scheduled-jobs —— 新建定时任务
 *
 * 平台自持调度：任务存在本库，到点由 src/lib/scheduler 在该用户专属会话里执行。
 * 不再往网关注册 cron（网关 cron 是全平台共享的，会造成跨用户泄露）。
 */
type CreateBody = {
  name?: string;
  cronExpr?: string;
  timezone?: string;
  prompt?: string;
  enabled?: boolean;
  runOnce?: boolean;
  oneShotAt?: string;
  notifyWechat?: boolean;
};

/** 一次性任务的占位 cron（runOnce 不按 cron 触发，仅用于占位，避免空字段）。 */
const ONESHOT_PLACEHOLDER_CRON = "0 0 1 1 *";

export async function GET() {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const jobs = await prisma.scheduledJob.findMany({
    where: { userId: user.id },
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

export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const body = await readJson<CreateBody>(request);
  const name = (body.name || "").trim();
  const cronExprRaw = (body.cronExpr || "").trim();
  const prompt = sanitizeScheduledPrompt(body.prompt || "");
  const timezone = (body.timezone || "Asia/Shanghai").trim() || "Asia/Shanghai";
  const runOnce = body.runOnce === true;
  const oneShotAt = body.oneShotAt ? new Date(body.oneShotAt) : null;
  const notifyWechat = body.notifyWechat !== false;

  if (!name) return jsonError("缺少任务名。");
  if (!prompt) return jsonError("缺少执行内容（prompt）。");

  let cronExpr = cronExprRaw;
  if (runOnce) {
    if (!oneShotAt || Number.isNaN(oneShotAt.getTime())) {
      return jsonError("一次性任务需要有效的执行时间。");
    }
    if (oneShotAt.getTime() <= Date.now()) {
      return jsonError("一次性任务的执行时间必须晚于当前时间。");
    }
    cronExpr = ONESHOT_PLACEHOLDER_CRON;
  } else if (!isValidCronExpr(cronExpr)) {
    return jsonError("cron 表达式不合法（需 5 段：分 时 日 月 周，如 `30 17 * * *`）。");
  }

  const job = await prisma.scheduledJob.create({
    data: {
      userId: user.id,
      name,
      cronExpr,
      timezone,
      prompt,
      enabled: body.enabled !== false,
      runOnce,
      oneShotAt,
      notifyWechat
    }
  });
  return jsonOk({ job });
}
