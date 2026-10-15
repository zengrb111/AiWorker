import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { isValidCronExpr } from "@/lib/scheduler";

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
};

export async function GET() {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const jobs = await prisma.scheduledJob.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" }
  });
  return jsonOk({ jobs });
}

export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const body = await readJson<CreateBody>(request);
  const name = (body.name || "").trim();
  const cronExpr = (body.cronExpr || "").trim();
  const prompt = (body.prompt || "").trim();
  const timezone = (body.timezone || "Asia/Shanghai").trim() || "Asia/Shanghai";

  if (!name) return jsonError("缺少任务名。");
  if (!isValidCronExpr(cronExpr)) {
    return jsonError("cron 表达式不合法（需 5 段：分 时 日 月 周，如 `30 17 * * *`）。");
  }
  if (!prompt) return jsonError("缺少执行内容（prompt）。");

  const job = await prisma.scheduledJob.create({
    data: {
      userId: user.id,
      name,
      cronExpr,
      timezone,
      prompt,
      enabled: body.enabled !== false
    }
  });
  return jsonOk({ job });
}
