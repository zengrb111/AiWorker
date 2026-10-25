import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { isValidCronExpr } from "@/lib/scheduler";
import { sanitizeScheduledPrompt } from "@/lib/scheduled-job-prompt";

export const dynamic = "force-dynamic";

/** PATCH / DELETE /api/scheduled-jobs/[id] —— 修改或删除当前用户自己的定时任务。 */
type PatchBody = {
  name?: string;
  cronExpr?: string;
  timezone?: string;
  prompt?: string;
  enabled?: boolean;
  runOnce?: boolean;
  oneShotAt?: string | null;
  notifyWechat?: boolean;
  /** TEXT | VIDEO */
  kind?: string;
  /** 视频任务：产品网站 */
  videoSiteUrl?: string | null;
  /** 视频任务：参考图 URL 数组 */
  videoImages?: string[];
  /** 视频任务：目标时长（秒），10~60 */
  videoTargetSeconds?: number | null;
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
    const prompt = sanitizeScheduledPrompt(body.prompt);
    if (!prompt) return jsonError("执行内容不能为空。");
    data.prompt = prompt;
  }
  if (body.enabled !== undefined) data.enabled = body.enabled !== false;
  if (body.runOnce !== undefined) {
    data.runOnce = body.runOnce === true;
    // 切到一次性时若未同时传 cronExpr，用占位；切回循环时若未传 cronExpr，保留原值。
    if (data.runOnce && body.cronExpr === undefined) data.cronExpr = "0 0 1 1 *";
  }
  if (body.oneShotAt !== undefined) {
    if (body.oneShotAt === null) {
      data.oneShotAt = null;
    } else {
      const d = new Date(body.oneShotAt);
      if (Number.isNaN(d.getTime())) return jsonError("执行时间不合法。");
      data.oneShotAt = d;
    }
  }
  if (body.notifyWechat !== undefined) data.notifyWechat = body.notifyWechat === true;

  if (body.kind !== undefined) {
    const kind = body.kind.trim().toUpperCase() === "VIDEO" ? "VIDEO" : "TEXT";
    data.kind = kind;
    // 切回文字任务时清掉视频配置，避免残留字段让下次执行误判
    if (kind === "TEXT") {
      data.videoSiteUrl = null;
      data.videoImagesJson = null;
    }
  }
  if (body.videoSiteUrl !== undefined) {
    const siteUrl = (body.videoSiteUrl || "").trim();
    if (siteUrl && !/^https?:\/\//i.test(siteUrl)) {
      return jsonError("产品网站需以 http:// 或 https:// 开头。");
    }
    data.videoSiteUrl = siteUrl || null;
  }
  if (body.videoImages !== undefined) {
    const images = Array.isArray(body.videoImages)
      ? body.videoImages.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
      : [];
    data.videoImagesJson = JSON.stringify(images);
  }
  if (body.videoTargetSeconds !== undefined) {
    if (body.videoTargetSeconds === null) {
      data.videoTargetSeconds = null;
    } else if (typeof body.videoTargetSeconds === "number" && Number.isFinite(body.videoTargetSeconds)) {
      data.videoTargetSeconds = Math.min(60, Math.max(10, Math.round(body.videoTargetSeconds)));
    } else {
      return jsonError("目标时长需为 10~60 的数字。");
    }
  }

  // 视频任务不再强制要求素材：提示词是主输入，AI 会先选题再出片
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
