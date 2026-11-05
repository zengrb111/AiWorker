import { NextRequest } from "next/server";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { resolveOwnerFromBody } from "@/lib/ingest-owner";
import { isValidCronExpr, runScheduledJob } from "@/lib/scheduler";
import { getAgentToken, isValidAgentToken } from "@/lib/platform-config";
import { sanitizeScheduledPrompt } from "@/lib/scheduled-job-prompt";

export const dynamic = "force-dynamic";

/**
 * POST /api/scheduled-jobs/agent —— 供 OpenClaw 里的 agent（会话中）管理定时任务。
 *
 * 鉴权走 Bearer 令牌（`SCHEDULE_API_TOKEN`，未配置则回退 `CONTENT_INGEST_TOKEN`），
 * 因为 agent 跑在网关侧、没有 Web 会话。
 *
 * 这是**替代 `openclaw cron`** 的唯一入口：用户级定时任务一律存在平台侧，
 * 网关 cron 不再保存用户数据（避免跨用户泄露）。
 *
 * 请求体：
 *   {
 *     action: "list" | "create" | "update" | "delete" | "run",
 *     userId? | sessionKey? | phone?,   // 归属账号（必填，不接受静默兜底）
 *     id?,                              // update/delete/run 用
 *     name?, cronExpr?, timezone?, prompt?, enabled?,
 *     kind?,                            // TEXT（默认）| VIDEO（走 huashu-motion 直接出片）
 *     videoSiteUrl?,                    // 视频任务：产品网站
 *     videoImages?,                     // 视频任务：参考图 URL 数组（最多 6 张）
 *     videoTargetSeconds?               // 视频任务：目标时长 10~60 秒
 *   }
 * 返回 { jobs } 或 { job } 或 { deleted } 或 { triggered }。
 */
type AgentBody = {
  action?: string;
  userId?: string;
  sessionKey?: string;
  phone?: string;
  id?: string;
  name?: string;
  cronExpr?: string;
  timezone?: string;
  prompt?: string;
  enabled?: boolean;
  kind?: string;
  videoSiteUrl?: string;
  videoImages?: string[];
  videoTargetSeconds?: number | null;
};

/**
 * 视频字段归一化：与平台历史网页端曾用的同一套校验规则保持一致，
 * 避免 agent 建出来的视频任务和平台原有逻辑行为不一致。
 */
function normalizeVideoFields(body: AgentBody) {
  const kind = (body.kind || "").trim().toUpperCase() === "VIDEO" ? "VIDEO" : "TEXT";
  const siteUrl = (body.videoSiteUrl || "").trim();
  const images = Array.isArray(body.videoImages)
    ? body.videoImages.map((u) => String(u || "").trim()).filter(Boolean).slice(0, 6)
    : [];
  let targetSeconds: number | null = null;
  if (typeof body.videoTargetSeconds === "number" && Number.isFinite(body.videoTargetSeconds)) {
    targetSeconds = Math.min(60, Math.max(10, Math.round(body.videoTargetSeconds)));
  }
  if (siteUrl && !/^https?:\/\//i.test(siteUrl)) {
    return { error: "videoSiteUrl 需以 http:// 或 https:// 开头。", kind, siteUrl, images, targetSeconds };
  }
  return { error: null, kind, siteUrl, images, targetSeconds };
}

function extractToken(request: NextRequest): string {
  const header = request.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return (request.headers.get("x-schedule-token") || "").trim();
}

export async function POST(request: NextRequest) {
  const expected = getAgentToken();
  if (!expected) {
    return jsonError("服务端未配置平台 Agent 令牌（系统配置 → 平台 Agent 令牌），该接口未启用。", 503);
  }
  if (!isValidAgentToken(extractToken(request))) {
    return jsonError("令牌无效。", 401);
  }

  const body = await readJson<AgentBody>(request);
  const action = (body.action || "list").trim();

  // 归属账号必须显式给出（不接受静默兜底，否则会写到别人账号上）。
  const hasOwner = Boolean((body.userId || "").trim() || (body.sessionKey || "").trim() || (body.phone || "").trim());
  if (!hasOwner) {
    return jsonError("缺少归属账号：请传 userId / sessionKey / phone 之一。");
  }
  const owner = await resolveOwnerFromBody(body);
  if (!owner.ok) return jsonError(owner.error, owner.status);
  const user = owner.user;

  const ownedJob = async (id?: string) => {
    const jobId = (id || "").trim();
    if (!jobId) return null;
    const job = await prisma.scheduledJob.findUnique({ where: { id: jobId } });
    if (!job || job.userId !== user.id) return null;
    return job;
  };

  switch (action) {
    case "list": {
      const jobs = await prisma.scheduledJob.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" }
      });
      return jsonOk({ account: user.phone, jobs });
    }
    case "create": {
      const name = (body.name || "").trim();
      const cronExpr = (body.cronExpr || "").trim();
      const prompt = sanitizeScheduledPrompt(body.prompt || "");
      const timezone = (body.timezone || "Asia/Shanghai").trim() || "Asia/Shanghai";
      if (!name) return jsonError("缺少 name。");
      if (!isValidCronExpr(cronExpr)) return jsonError("cronExpr 不合法（5 段：分 时 日 月 周）。");
      if (!prompt) return jsonError("缺少 prompt（到点要执行的内容）。");
      const video = normalizeVideoFields(body);
      if (video.error) return jsonError(video.error);
      const job = await prisma.scheduledJob.create({
        data: {
          userId: user.id,
          name,
          cronExpr,
          timezone,
          prompt,
          // 来源标记为「龙虾（网关 agent）经微信创建」。平台侧定时任务模块是纯查看器，
          // 只展示 source=AGENT 的任务；平台网页端创建逻辑已废弃。
          source: "AGENT",
          enabled: body.enabled !== false,
          kind: video.kind,
          videoSiteUrl: video.kind === "VIDEO" ? video.siteUrl || null : null,
          videoImagesJson: video.kind === "VIDEO" ? JSON.stringify(video.images) : null,
          videoTargetSeconds: video.kind === "VIDEO" ? video.targetSeconds : null
        }
      });
      return jsonOk({ account: user.phone, job });
    }
    case "update": {
      const job = await ownedJob(body.id);
      if (!job) return jsonError("任务不存在或不属于该账号。", 404);
      const data: Record<string, unknown> = {};
      if (body.name !== undefined) {
        const name = body.name.trim();
        if (!name) return jsonError("name 不能为空。");
        data.name = name;
      }
      if (body.cronExpr !== undefined) {
        const cronExpr = body.cronExpr.trim();
        if (!isValidCronExpr(cronExpr)) return jsonError("cronExpr 不合法。");
        data.cronExpr = cronExpr;
      }
      if (body.timezone !== undefined) data.timezone = body.timezone.trim() || "Asia/Shanghai";
      if (body.prompt !== undefined) {
        const prompt = sanitizeScheduledPrompt(body.prompt);
        if (!prompt) return jsonError("prompt 不能为空。");
        data.prompt = prompt;
      }
      if (body.enabled !== undefined) data.enabled = body.enabled !== false;
      // 视频相关字段：只带其中任意一个就按视频规则校验并整组落库，
      // 这样 agent 既能「只改时长」，也能「只换官网」，不用每次都补齐全部字段。
      if (
        body.kind !== undefined ||
        body.videoSiteUrl !== undefined ||
        body.videoImages !== undefined ||
        body.videoTargetSeconds !== undefined
      ) {
        const video = normalizeVideoFields(body);
        // 部分字段时可以沿用已有任务的取值
        const kind = body.kind !== undefined ? video.kind : ((job.kind || "TEXT").toUpperCase() === "VIDEO" ? "VIDEO" : "TEXT");
        const siteUrl = body.videoSiteUrl !== undefined ? video.siteUrl : (kind === "VIDEO" ? job.videoSiteUrl || "" : "");
        if (video.error && body.videoSiteUrl !== undefined) return jsonError(video.error);
        const images = body.videoImages !== undefined
          ? video.images
          : (job.videoImagesJson ? (JSON.parse(job.videoImagesJson) as string[]) : []);
        const targetSeconds = body.videoTargetSeconds !== undefined
          ? video.targetSeconds
          : job.videoTargetSeconds;
        data.kind = kind;
        data.videoSiteUrl = kind === "VIDEO" ? siteUrl || null : null;
        data.videoImagesJson = kind === "VIDEO" ? JSON.stringify(images) : null;
        data.videoTargetSeconds = kind === "VIDEO" ? targetSeconds ?? null : null;
      }
      if (Object.keys(data).length === 0) return jsonError("没有需要修改的字段。");
      const updated = await prisma.scheduledJob.update({ where: { id: job.id }, data });
      return jsonOk({ account: user.phone, job: updated });
    }
    case "delete": {
      const job = await ownedJob(body.id);
      if (!job) return jsonError("任务不存在或不属于该账号。", 404);
      await prisma.scheduledJob.delete({ where: { id: job.id } });
      return jsonOk({ account: user.phone, deleted: job.id });
    }
    case "run": {
      const job = await ownedJob(body.id);
      if (!job) return jsonError("任务不存在或不属于该账号。", 404);
      void runScheduledJob(job.id).catch((error) => {
        console.error(`[scheduler] agent 触发任务 ${job.name} 失败：`, error);
      });
      return jsonOk({ account: user.phone, triggered: job.id });
    }
    default:
      return jsonError(`不支持的 action：${action}（可用 list/create/update/delete/run）。`);
  }
}
