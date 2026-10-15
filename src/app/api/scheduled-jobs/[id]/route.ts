import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { isValidCronExpr } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

/** PATCH / DELETE /api/scheduled-jobs/[id] —— 修改或删除当前用户自己的定时任务。 */
type PatchBody = {
  name?: string;
  cronExpr?: string;
  timezone?: string;
  prompt?: string;
  enabled?: boolean;
};

async function loadOwnedJob(id: string, userId: string) {
  const job = await prisma.scheduledJob.findUnique({ where: { id } });
  if (!job || job.userId !== userId) return null;
  return job;
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const existing = await loadOwnedJob(params.id, user.id);
  if (!existing) return jsonError("任务不存在。", 404);

  const body = await readJson<PatchBody>(request);
  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return jsonError("任务名不能为空。");
    data.name = name;
  }
  if (body.cronExpr !== undefined) {
    const cronExpr = body.cronExpr.trim();
    if (!isValidCronExpr(cronExpr)) return jsonError("cron 表达式不合法。");
    data.cronExpr = cronExpr;
  }
  if (body.timezone !== undefined) {
    data.timezone = body.timezone.trim() || "Asia/Shanghai";
  }
  if (body.prompt !== undefined) {
    const prompt = body.prompt.trim();
    if (!prompt) return jsonError("执行内容不能为空。");
    data.prompt = prompt;
  }
  if (body.enabled !== undefined) data.enabled = body.enabled !== false;

  if (Object.keys(data).length === 0) return jsonError("没有需要修改的字段。");

  const job = await prisma.scheduledJob.update({ where: { id: params.id }, data });
  return jsonOk({ job });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const existing = await loadOwnedJob(params.id, user.id);
  if (!existing) return jsonError("任务不存在。", 404);

  await prisma.scheduledJob.delete({ where: { id: params.id } });
  return jsonOk({ deleted: params.id });
}
