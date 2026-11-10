/**
 * 「当前用户有哪些定时任务」的唯一数据源。
 *
 * 为什么需要这一层：任务实际存在**两个地方**，只查一边就会「建了却看不见」——
 *
 *   1. 平台库 `ScheduledJob`（source=AGENT）—— 龙虾调 `/api/scheduled-jobs/agent` 建的任务，
 *      由平台调度器到点执行、推微信，有完整的运行记录（ScheduledJobRun）；
 *   2. OpenClaw 网关 cron —— 龙虾直接用 `openclaw cron add`（或历史路径）建的任务，
 *      由**网关自己**到点执行，平台库没有它们的记录。
 *
 * 2026-11 的真实故障：本地 13800138003 有两条任务只在网关里，平台面板和龙虾查
 * `/api/scheduled-jobs/agent?action=list` 都返回空 —— 用户看到的就是「任务不见了」。
 *
 * 合并规则：
 * - 平台库任务优先（有执行结果），若 gatewayJobId 能在网关对上，用网关的 nextRunAt 校正排期；
 * - 网关任务里排除系统自建项（心跳 / 技能巡检 / 记忆巩固），否则面板被系统任务刷屏；
 * - 返回带 `origin`，调用方据此区分「谁在执行」，网关任务不能在平台上改/删。
 */
import { prisma } from "@/lib/prisma";
import { nextRunAt } from "@/lib/scheduler";
import { openClawClient, type CronJobSummary } from "@/lib/openclaw";
import { userAgentId } from "@/lib/openclaw-user-agent";

/** 系统自动装配的网关任务：声明式托管 key 非空，或名字带系统前缀。 */
const SYSTEM_CRON_PREFIX = /^(heartbeat|skill-collection-review|memory-|skill-?collection)/i;

function isSystemCron(job: CronJobSummary): boolean {
  if (job.declarationKey) return true;
  return SYSTEM_CRON_PREFIX.test(job.name || "");
}

export type ScheduledJobOrigin = "PLATFORM" | "GATEWAY";

export type ScheduledJobView = {
  id: string;
  gatewayJobId: string | null;
  name: string;
  enabled: boolean;
  runOnce: boolean;
  oneShotAt: string | null;
  notifyWechat: boolean;
  cronExpr: string;
  timezone: string;
  prompt: string;
  kind: string;
  videoSiteUrl: string | null;
  videoImagesJson: string | null;
  videoTargetSeconds: number | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastResult: string | null;
  runCount: number;
  source: string;
  origin: ScheduledJobOrigin;
  nextRunAt: string | null;
  createdAt: string;
  lastDurationMs?: number | null;
};

export async function listUserScheduledJobs(userId: string): Promise<{
  jobs: ScheduledJobView[];
  gatewayError: string | null;
}> {
  const rows = await prisma.scheduledJob.findMany({
    where: { userId, source: "AGENT" },
    orderBy: { createdAt: "asc" }
  });

  // 网关读失败不抛：平台库任务照常返回，把原因带出去让调用方如实说明。
  let gatewayJobs: CronJobSummary[] = [];
  let gatewayError: string | null = null;
  try {
    const agentId = userAgentId(userId);
    const all = await openClawClient.listCronJobs();
    gatewayJobs = all.filter(
      (job) =>
        (job.agentId === agentId || job.sessionKey.startsWith(`agent:${agentId}:`)) &&
        !isSystemCron(job)
    );
  } catch (error) {
    gatewayError = error instanceof Error ? error.message : "读取网关定时任务失败。";
  }

  const knownGatewayIds = new Set(
    rows.map((row) => row.gatewayJobId).filter((id): id is string => Boolean(id))
  );
  const gatewayById = new Map(gatewayJobs.map((job) => [job.id, job]));

  const platformItems: ScheduledJobView[] = rows.map((row) => {
    const gw = row.gatewayJobId ? gatewayById.get(row.gatewayJobId) : undefined;
    return {
      id: row.id,
      gatewayJobId: row.gatewayJobId ?? null,
      name: row.name,
      enabled: row.enabled,
      runOnce: row.runOnce,
      oneShotAt: row.oneShotAt ? row.oneShotAt.toISOString() : null,
      notifyWechat: row.notifyWechat,
      cronExpr: row.cronExpr,
      timezone: row.timezone,
      prompt: row.prompt || gw?.prompt || "",
      kind: row.kind ?? "TEXT",
      videoSiteUrl: row.videoSiteUrl ?? null,
      videoImagesJson: row.videoImagesJson ?? null,
      videoTargetSeconds: row.videoTargetSeconds ?? null,
      lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
      lastStatus: row.lastStatus ?? null,
      lastError: row.lastError ?? null,
      lastResult: row.lastResult ?? null,
      runCount: row.runCount,
      source: row.source,
      origin: "PLATFORM",
      // 已登记的网关任务，nextRunAt 以网关为准（网关重载可能改过排期）。
      nextRunAt: row.enabled
        ? row.runOnce
          ? row.oneShotAt && !row.lastRunAt
            ? row.oneShotAt.toISOString()
            : null
          : gw?.nextRunAtMs
            ? new Date(gw.nextRunAtMs).toISOString()
            : nextRunAt(row.cronExpr, row.timezone)?.toISOString() ?? null
        : null,
      createdAt: row.createdAt.toISOString()
    };
  });

  const gatewayItems: ScheduledJobView[] = gatewayJobs
    .filter((job) => !knownGatewayIds.has(job.id))
    .map((job) => {
      // 被操作者停用的任务，网关会写一条 "Cron job disabled by operator." 的 lastError，
      // 那不是执行失败，别在面板上报红。
      const disabledByOperator = /disabled by operator/i.test(job.lastError || "");
      const status =
        disabledByOperator || !job.enabled
          ? null
          : job.lastRunStatus === "ok"
            ? "SUCCEEDED"
            : job.lastRunStatus === "error"
              ? "FAILED"
              : job.lastRunStatus === "skipped"
                ? "SKIPPED"
                : null;
      return {
        // 前缀区分来源，避免与库里的 cuid 撞 id（前端展开运行记录要用）。
        id: `gw:${job.id}`,
        gatewayJobId: job.id,
        name: job.name,
        enabled: job.enabled,
        runOnce: false,
        oneShotAt: null,
        notifyWechat: true,
        cronExpr: job.cronExpr,
        timezone: job.timezone,
        prompt: job.prompt,
        kind: "TEXT",
        videoSiteUrl: null,
        videoImagesJson: null,
        videoTargetSeconds: null,
        lastRunAt: job.lastRunAtMs ? new Date(job.lastRunAtMs).toISOString() : null,
        lastStatus: status,
        lastError: status === "FAILED" ? job.lastError : null,
        lastResult: null,
        runCount: 0,
        source: "GATEWAY",
        origin: "GATEWAY",
        nextRunAt:
          job.enabled && job.nextRunAtMs ? new Date(job.nextRunAtMs).toISOString() : null,
        createdAt: job.createdAtMs
          ? new Date(job.createdAtMs).toISOString()
          : new Date(0).toISOString(),
        lastDurationMs: job.lastDurationMs
      };
    });

  const jobs = [...platformItems, ...gatewayItems].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
  return { jobs, gatewayError };
}
