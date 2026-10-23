/**
 * 平台自持的定时任务调度器（替代网关上「跨用户共享」的 cron）。
 *
 * 背景：OpenClaw 网关的 cron 存储是**全平台共享**的，任何 session 里的 agent 都能
 * `openclaw cron list` 看到别人的任务（已造成过跨用户泄露事故）。因此把用户级调度
 * 收到平台侧：任务存在本库，到点由本调度器在**该用户的专属会话**里执行 prompt。
 * 网关侧不再保存任何用户任务数据 → 外部通道（微信等）即使被诱导去查，也查不到。
 */
import { prisma } from "@/lib/prisma";
import { openClawClient, deliverWechatMessage } from "@/lib/openclaw";
import { appendTurn } from "@/lib/wechat-conversation-store";

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

/**
 * 解析该用户的微信投递目标（to=收件人 wechatNo，accountRef=机器人 wechatOpenId 原始值）。
 * 只取该用户**自己** status=BOUND 的最新绑定；未绑定或历史脏数据返回 null（宁可不投，绝不投错人）。
 * accountRef 传原始值，由 deliverWechatMessage 内部做规范化与 userId 反查，避免这里重复实现。
 */
async function resolveWechatTarget(userId: string): Promise<{ to: string; accountRef: string } | null> {
  const binding = await prisma.wechatBinding
    .findFirst({ where: { userId, status: "BOUND" }, orderBy: { boundAt: "desc" } })
    .catch(() => null);
  if (!binding) return null;
  const to = (binding.wechatNo || "").trim();
  const accountRef = (binding.wechatOpenId || "").trim();
  if (!to.endsWith("@im.wechat") || !accountRef.endsWith("@im.bot")) return null;
  return { to, accountRef };
}

/**
 * 把定时任务的结果通过微信推给该用户本人。
 *
 * 走**确定性投递**（平台直接持机器人 token 调 `ilink/bot/sendmessage`），
 * 不再依赖 agent 在回合里自觉调 `--announce` 工具——那一路实测三次均未真正发出。
 * 目标（to / accountRef）来自用户自己的绑定记录，绝不投错人；未绑定不会调到这里。
 *
 * 投递成功后**同步落一份平台侧会话**：微信插件只记录它自己收发的消息，
 * 平台直投的这一条不会进 `ref-messages.sqlite`，不补写的话平台「微信会话」
 * 里就看不到定时任务的结果（用户侧现象：微信收到了、平台里没有）。
 */
async function deliverJobResultToWechat(
  jobName: string,
  userId: string,
  target: { to: string; accountRef: string },
  text: string
): Promise<void> {
  const content = (text || "").trim() || `定时任务「${jobName}」已执行（无文本结果）。`;
  const result = await deliverWechatMessage(target.accountRef, target.to, content);
  console.log(
    `[scheduler] 微信通知已投递：任务=${jobName} to=${target.to} messageId=${result.messageId ?? "?"}`
  );
  // 归档到平台会话（conversationId 与「微信会话」面板一致 = 收件人 wechatNo）。
  // 写失败不影响投递结果：消息已经到微信了，只是平台侧少一条记录。
  appendTurn({ userId, conversationId: target.to, role: "assistant", body: content });
}

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
    const target = await resolveWechatTarget(job.userId).catch(() => null);

    const result = await openClawClient.sendTask({
      message: job.prompt,
      userId: job.userId,
      // 定时任务常是多步长流程（抓热点/生成/入库），120s 默认超时必掐断；放宽到 10 分钟。
      timeoutMs: Number(process.env.SCHEDULE_TASK_TIMEOUT_MS ?? 600_000),
      // 空文本自动重跑 = 整个任务再执行一遍（重复入库/发布），对有副作用的任务绝不允许。
      retryOnEmpty: false
    });
    const content = (result.content || "").trim();
    await prisma.scheduledJob.update({
      where: { id: jobId },
      data: {
        lastRunAt: new Date(),
        lastStatus: "SUCCEEDED",
        lastError: null,
        lastResult: (
          content ||
          // 空文本 ≠ 失败：agent 可能以工具调用形式完成任务、或仍在后台收尾；
          // 微信通知走独立投递回合，不依赖这里抓到文本。
          "已执行。agent 未返回文本结果（可能以工具调用完成或仍在后台收尾）；如已绑定微信，结果会由 agent 直接推送。"
        ).slice(0, 2000),
        runCount: { increment: 1 }
      }
    });
    // 微信通知走**确定性投递**：平台直接调微信官方接口，不依赖 agent 调 --announce。
    // 单独一轮（而不是把投递塞进任务 prompt）避免被主任务逻辑覆盖。
    // 投递结果回写到 lastResult，避免「任务成功却收不到通知」的不可见问题。
    // notifyWechat=false 的任务只执行不通知（参照 WorkBuddy 的「消息推送到企业微信」开关）。
    if (target && job.notifyWechat !== false) {
      const notifyText = content || "定时任务已执行完成（无文本结果）。";
      try {
        await deliverJobResultToWechat(job.name, job.userId, target, notifyText);
        await prisma.scheduledJob
          .update({
            where: { id: jobId },
            data: { lastResult: `${notifyText}\n\n✅ 微信通知已送达`.slice(0, 2000) }
          })
          .catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[scheduler] 任务 ${job.name} 微信通知投递失败：`, error);
        await prisma.scheduledJob
          .update({
            where: { id: jobId },
            data: {
              lastResult: `${notifyText}\n\n⚠️ 微信通知未送达：${message}`.slice(0, 2000)
            }
          })
          .catch(() => undefined);
      }
    }
    // 成功后收尾：一次性任务 → 关闭，避免反复触发（循环任务保持运行）。
    if (job.runOnce) {
      await prisma.scheduledJob
        .update({ where: { id: jobId }, data: { enabled: false } })
        .catch(() => undefined);
    }
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

    // 一次性任务：到 oneShotAt 时间点执行一次后由 runScheduledJob 自动禁用。
    // 已执行过（lastRunAt 有值，无论成败）永久跳过；未到计划时间也跳过。
    if (job.runOnce) {
      if (job.lastRunAt) continue;
      const at = job.oneShotAt ? new Date(job.oneShotAt) : null;
      if (!at || Number.isNaN(at.getTime())) continue;
      if (now.getTime() < at.getTime()) continue;
      fired.push(job.id);
      void runScheduledJob(job.id).catch((error) => {
        console.error(`[scheduler] 一次性任务 ${job.name} 执行异常：`, error);
      });
      continue;
    }

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

/**
 * 算出下一次执行时间（给界面显示「下次 明天 17:30」）。
 *
 * 逐分钟向前试，命中即返回 —— 每天跑的任务最多试 1440 次，开销可以忽略。
 * 上限 60 天：合法 cron 在 60 天内必有触发（最稀疏的是「2 月 29 日」，
 * 那种会返回 null，界面显示「暂无」即可）。
 *
 * 用本地时间推进游标、用 `localParts` 按任务时区判断，所以服务器时区与任务时区
 * 不一致时也能算对。中国无夏令时，不存在重复/跳过分钟的问题。
 */
export function nextRunAt(
  cronExpr: string,
  timeZone: string,
  from: Date = new Date()
): Date | null {
  if (!isValidCronExpr(cronExpr)) return null;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = 60 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matchCron(cronExpr, localParts(cursor, timeZone))) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
