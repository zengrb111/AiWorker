/**
 * 平台自持的定时任务调度器（替代网关上「跨用户共享」的 cron）。
 *
 * 背景：OpenClaw 网关的 cron 存储是**全平台共享**的，任何 session 里的 agent 都能
 * `openclaw cron list` 看到别人的任务（已造成过跨用户泄露事故）。因此把用户级调度
 * 收到平台侧：任务存在本库，到点由本调度器在**该用户的专属会话**里执行 prompt。
 * 网关侧不再保存任何用户任务数据 → 外部通道（微信等）即使被诱导去查，也查不到。
 */
import { prisma } from "@/lib/prisma";
import { openClawClient } from "@/lib/openclaw";

/** 调度轮询间隔。 */
const TICK_MS = 30_000;

/** 正在执行中的任务 id（防止同一任务并发执行）。 */
const inFlight = new Set<string>();

let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

export type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

/**
 * 取某个时刻在指定时区下的「本地面包」。用 Intl 而不是自己算偏移，
 * 免去 DST / 时区表维护。
 */
export function localParts(date: Date, timeZone: string): LocalParts {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short"
    });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", {
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short"
    });
  }
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const hour = Number(map.hour) % 24; // 某些环境 24:00 表示午夜
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    weekday: WEEKDAYS[map.weekday] ?? date.getDay()
  };
}

/** 把时刻格式化成一个"分钟粒度"的 key，用于去重（同一分钟只跑一次）。 */
export function minuteKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

type CronField = Set<number> | null; // null = 通配

function parseCronField(raw: string, min: number, max: number): CronField {
  const field = raw.trim();
  if (!field || field === "*") return null;
  const values = new Set<number>();
  for (const chunk of field.split(",")) {
    const piece = chunk.trim();
    if (!piece) continue;
    const [rangePart, stepPart] = piece.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isFinite(step) || step <= 0) return null;
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map((v) => Number(v));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      start = a;
      end = b;
    } else {
      const single = Number(rangePart);
      if (!Number.isFinite(single)) return null;
      start = single;
      end = stepPart ? max : single;
    }
    for (let v = start; v <= end; v += step) {
      if (v >= min && v <= max) values.add(v);
    }
  }
  return values.size ? values : null;
}

/**
 * 判断 5 段 cron（分 时 日 月 周）是否命中给定时刻。
 * 日与周的语义遵循 cron 惯例：两者都限定时取「或」（任一命中即可）。
 */
export function matchCron(cronExpr: string, p: LocalParts): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length < 5) return false;
  const [minF, hourF, domF, monF, dowF] = fields;
  const minute = parseCronField(minF, 0, 59);
  const hour = parseCronField(hourF, 0, 23);
  const dom = parseCronField(domF, 1, 31);
  const month = parseCronField(monF, 1, 12);
  const dow = parseCronField(dowF, 0, 6);

  if (minute && !minute.has(p.minute)) return false;
  if (hour && !hour.has(p.hour)) return false;
  if (month && !month.has(p.month)) return false;

  const domMatch = dom ? dom.has(p.day) : null;
  const dowMatch = dow ? dow.has(p.weekday) : null;
  if (domMatch === null && dowMatch === null) return true;
  if (domMatch === null) return dowMatch === true;
  if (dowMatch === null) return domMatch === true;
  return domMatch || dowMatch;
}

export type SchedulerRunResult = {
  ok: boolean;
  status: "SUCCEEDED" | "FAILED";
  content?: string;
  error?: string;
};

/** 立即执行一个任务（手动触发与定时触发共用）。 */
export async function runScheduledJob(jobId: string): Promise<SchedulerRunResult> {
  const job = await prisma.scheduledJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, status: "FAILED", error: "任务不存在。" };
  if (inFlight.has(jobId)) return { ok: false, status: "FAILED", error: "任务正在执行中。" };

  inFlight.add(jobId);
  await prisma.scheduledJob
    .update({ where: { id: jobId }, data: { lastStatus: "RUNNING", lastError: null } })
    .catch(() => undefined);
  try {
    const result = await openClawClient.sendTask({ message: job.prompt, userId: job.userId });
    const content = (result.content || "").trim();
    await prisma.scheduledJob.update({
      where: { id: jobId },
      data: {
        lastRunAt: new Date(),
        lastStatus: "SUCCEEDED",
        lastError: null,
        lastResult: content.slice(0, 2000),
        runCount: { increment: 1 }
      }
    });
    return { ok: true, status: "SUCCEEDED", content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.scheduledJob
      .update({
        where: { id: jobId },
        data: { lastRunAt: new Date(), lastStatus: "FAILED", lastError: message.slice(0, 1000) }
      })
      .catch(() => undefined);
    return { ok: false, status: "FAILED", error: message };
  } finally {
    inFlight.delete(jobId);
  }
}

/** 一次轮询：找出"本分钟应当执行"的任务并触发。 */
export async function tickScheduler(now = new Date()): Promise<string[]> {
  const jobs = await prisma.scheduledJob.findMany({ where: { enabled: true } });
  const fired: string[] = [];
  for (const job of jobs) {
    if (inFlight.has(job.id)) continue;
    const key = minuteKey(now, job.timezone);
    // 同一分钟只跑一次（重启后靠 lastRunAt 去重）
    if (job.lastRunAt && minuteKey(job.lastRunAt, job.timezone) === key) continue;
    if (!matchCron(job.cronExpr, localParts(now, job.timezone))) continue;
    fired.push(job.id);
    // 不 await：长任务不应阻塞本轮其它任务
    void runScheduledJob(job.id).catch((error) => {
      console.error(`[scheduler] 任务 ${job.name} 执行异常：`, error);
    });
  }
  return fired;
}

/** 启动调度器（幂等，服务启动时调用一次）。 */
export function startScheduler(): void {
  if (started) return;
  started = true;
  timer = setInterval(() => {
    tickScheduler().catch((error) => {
      console.error("[scheduler] 轮询失败：", error instanceof Error ? error.message : error);
    });
  }, TICK_MS);
  // 不阻止进程退出
  if (typeof timer.unref === "function") timer.unref();
  // 启动即补一次，避免正好跨过触发点
  tickScheduler().catch(() => undefined);
  console.log(`[scheduler] 平台定时任务调度器已启动（每 ${TICK_MS / 1000}s 轮询）`);
}

/** 校验 5 段 cron 表达式是否合法（用于接口入参校验）。 */
export function isValidCronExpr(cronExpr: string): boolean {
  const fields = (cronExpr || "").trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6]
  ];
  return fields.every((f, i) => {
    if (f === "*") return true;
    const parsed = parseCronField(f, ranges[i][0], ranges[i][1]);
    return parsed !== null && parsed.size > 0;
  });
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
