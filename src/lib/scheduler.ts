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
import { runHuashuGeneration } from "@/lib/video/huashu-generate";

/** 调度轮询间隔。 */
const TICK_MS = 30_000;

/** 正在执行中的任务 id（防止同一任务并发执行）。 */
const inFlight = new Set<string>();

/**
 * 跨进程 / 跨重启的「同一分钟只准跑一次」锁。
 *
 * 2026-10-26 实测事故：17:30 的图文任务在 31 秒内被触发了两次（17:30:15、17:30:46），
 * 两轮各自生成 2 篇并各自入库，选题还顺延到了第二条热点 —— 同一时点产出翻倍。
 * 原因：inFlight 只是模块变量，dev 模式 HMR 重建模块或未来多进程都会各持一份；
 * 「同一分钟只跑一次」原先只靠 lastRunAt 判断，而 lastRunAt 要任务**跑完**才写，
 * 长任务跑的那几十秒里再来一次 tick 就会重复触发。
 * 改为在**开跑前**就抢占该分钟：抢到的进程才执行，抢不到的直接跳过。
 */
declare global {
  // eslint-disable-next-line no-var
  var __openclawSchedulerLocks: Map<string, number> | undefined;
}
const minuteLocks: Map<string, number> =
  (globalThis as unknown as { __openclawSchedulerLocks?: Map<string, number> })
    .__openclawSchedulerLocks ??
  ((globalThis as unknown as { __openclawSchedulerLocks?: Map<string, number> })
    .__openclawSchedulerLocks = new Map<string, number>());

/** 抢占「本分钟」的执行权：true 表示本进程拿到锁，可以执行。 */
async function claimMinute(jobId: string, key: string): Promise<boolean> {
  const memo = `${jobId}@${key}`;
  const local = minuteLocks.get(memo);
  if (typeof local === "number" && Date.now() - local < 120_000) return false;
  minuteLocks.set(memo, Date.now());
  if (minuteLocks.size > 200) {
    const cutoff = Date.now() - 600_000;
    for (const [k, v] of minuteLocks) if (v < cutoff) minuteLocks.delete(k);
  }
  // 数据库层再兜一次：lastRunAt 已落在本分钟，说明这个时点已经跑过（可能是别的进程跑的）。
  const job = await prisma.scheduledJob
    .findUnique({ where: { id: jobId }, select: { lastRunAt: true, timezone: true } })
    .catch(() => null);
  if (job?.lastRunAt && minuteKey(job.lastRunAt, job.timezone || "Asia/Shanghai") === key) return false;
  return true;
}

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

/**
 * 视频任务用哪个会话展示进度。
 *
 * 单独开一条「定时视频 · 任务名」的会话，而不是塞进用户正在聊的会话：
 * 定时出片是后台行为，进度消息和成片混进日常对话会把主线顶走；
 * 同一条会话反复复用，用户点进去就能看到历次初稿。
 */
async function resolveVideoConversation(userId: string, jobName: string): Promise<string> {
  const title = `定时视频 · ${jobName}`.slice(0, 60);
  const existing = await prisma.conversation.findFirst({
    where: { userId, title },
    orderBy: { updatedAt: "desc" }
  });
  if (existing) return existing.id;
  const created = await prisma.conversation.create({ data: { userId, title } });
  return created.id;
}

/**
 * 视频任务的「先选题、再出片」。
 *
 * 为什么需要这一步：视频任务的输入现在是一条**提示词**（和文字任务同一套写法），
 * 用户不再手写「创作需求」。所以到点先用 agent 按提示词检索一遍热点、选一个选题，
 * 产出一条能直接开拍的创作需求，再交给 huashu-motion 出片。
 *
 * 选题失败不能拖垮整个任务：拿不到就用提示词本身出片（质量差一点，但不会白跑）。
 */
const VIDEO_IDEA_TIMEOUT_MS = Number(process.env.SCHEDULE_VIDEO_IDEA_TIMEOUT_MS ?? 420_000);

type VideoIdea = { topic: string | null; requirement: string; reason: string | null };

/**
 * 选题 agent 兜底用的「干净创作需求」。
 *
 * 重要：定时视频任务的 `prompt` 是写给 OpenClaw agent 的**操作脚本**（含命令行、文件路径、入库步骤），
 * 任务类型是 VIDEO 时调度器**压根不走 agent**，直接调用 huashu-motion 出片。
 * 所以那个 prompt 绝不能当产品名塞给 DSH（会变成一整面操作指令，出片方向全乱）。
 * 选题失败时用这条与产品解耦的兜底 brief——产品细节由 om grab 抓下的官网素材推断。
 */
const DEFAULT_VIDEO_BRIEF =
  "结合今日与产品相关的热点做一支产品宣传片：前段把热点讲清楚、讲到位，并自然过渡到本产品；" +
  "后段集中讲清这个产品替谁解决了什么、怎么开始用，并给出明确行动指引（去官网免费开始）。" +
  "产品是什么、卖点有哪些，一律以出片环节抓到的官网素材为准，不要自行假设。" +
  "信息密度高、节奏快、真人感口播配音、经典白字烧录字幕，总时长 25 秒左右。";

function buildVideoIdeaPrompt(prompt: string): string {
  return [
    "你是竖版短视频的选题策划。请根据下面的任务要求，先选题，再写出一条可以直接开拍的创作需求。",
    "",
    "【任务要求】",
    prompt,
    "",
    "【做法】",
    "1. 如果任务要求需要结合当下热点，用你的搜索/抓取工具查一遍（与任务主题相关的最新话题、节日、社会情绪都算）。",
    "2. 只选 1 个最有传播力的选题，不要罗列多个，也不要给备选。",
    "3. 如果任务要求里已经明确了主题或产品名，直接沿用，不必强行找热点。",
    "4. 创作需求要能直接开拍：第一句就是视频的主题/产品名称，后面说清给谁看、讲什么、情绪基调。",
    "5. 创作需求必须包含这些要素：①前段讲哪个热点并自然过渡到本产品；②后段讲产品价值与明确行动指引；③明确要有真人感口播配音、烧录字幕、温暖治愈风格。",
    "6. **严禁**在创作需求里写任何操作步骤、命令行、脚本路径或「运行某 mjs」之类的话——那不是创作需求；也**不要**在创作需求里写产品网站地址或参考图链接，产品素材会在出片环节单独提供。",
    "",
    "【输出格式】严格三行，不要任何额外文字、不要 markdown 标题：",
    "选题：<一句话>",
    "创作需求：<40~160 字>",
    "理由：<一句话>"
  ]
    .filter(Boolean)
    .join("\n");
}

/** 从 agent 回复里抽三段；抽不到就整段当创作需求。 */
function parseVideoIdea(text: string, fallback: string): VideoIdea {
  const pick = (label: string): string | null => {
    const matched = new RegExp(`${label}[：:]\\s*([^\\n]+)`).exec(text);
    const value = matched?.[1]?.trim();
    return value ? value.replace(/^[「"'*]+|[」"'*]+$/g, "").trim() : null;
  };
  const requirement = pick("创作需求");
  const topic = pick("选题");
  const reason = pick("理由");
  if (requirement && requirement.length >= 8) return { topic, requirement, reason };
  // 兜底：整段压缩成一句（去掉 markdown 符号与多余空行）
  const flattened = text
    .replace(/[#*>`]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return { topic, requirement: (flattened || fallback).slice(0, 300), reason };
}

async function pickVideoIdea(
  userId: string,
  prompt: string
): Promise<VideoIdea | null> {
  try {
    const result = await openClawClient.sendTask({
      message: buildVideoIdeaPrompt(prompt),
      userId,
      timeoutMs: VIDEO_IDEA_TIMEOUT_MS,
      // 选题独立会话：不污染用户正在聊的会话，也不与视频任务的会话混在一起
      sessionKey: `agent:u-${userId}:video-idea`,
      retryOnEmpty: false
    });
    const text = (result.content || "").trim();
    if (!text) return null;
    return parseVideoIdea(text, prompt);
  } catch (error) {
    console.error("[scheduler] 视频选题失败，改用提示词直接出片：", error);
    return null;
  }
}

/** 视频任务：先选题 → 再走 huashu-motion 出片 → 写进内容库，返回给用户看的摘要。 */
async function runVideoJob(job: {
  userId: string;
  name: string;
  prompt: string;
  videoSiteUrl: string | null;
  videoImagesJson: string | null;
  videoTargetSeconds?: number | null;
}): Promise<string> {
  let imageUrls: string[] = [];
  try {
    const parsed = JSON.parse(job.videoImagesJson || "[]");
    if (Array.isArray(parsed)) imageUrls = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    imageUrls = [];
  }

  const conversationId = await resolveVideoConversation(job.userId, job.name);
  const idea = await pickVideoIdea(job.userId, job.prompt);
  // 关键：绝不要把整段「操作脚本」prompt 当产品名塞给 DSH（会让出片方向混乱）。
  // 选题成功用 AI 提炼的创作需求；失败用干净的默认 brief。
  const requirement = idea?.requirement || DEFAULT_VIDEO_BRIEF;
  const prefixLines = idea
    ? [
        "选题完成…",
        `选题：${idea.topic || "（沿用任务给定主题）"}`,
        `创作需求：${requirement}`,
        ...(idea.reason ? [`理由：${idea.reason}`] : [])
      ]
    : ["选题步骤未返回结果，用默认创作需求出片。"];

  const result = await runHuashuGeneration({
    userId: job.userId,
    conversationId,
    requirement,
    siteUrl: job.videoSiteUrl || null,
    images: imageUrls.map((url) => ({ url })),
    progressTitle: `定时视频 · ${job.name}`,
    prefixLines,
    allowNoMaterials: true,
    // 定时视频是「初稿」，改片过程留在这条任务会话里便于回看
    progressInChat: true,
    targetSeconds: job.videoTargetSeconds ?? 20
  });

  const duration = result.duration != null ? `${result.duration.toFixed(1)}s` : "时长未知";
  return [
    `视频初稿已生成（${duration}）：${result.videoUrl}`,
    idea?.topic ? `选题：${idea.topic}` : "",
    "已存入内容库（分类「视频」）。想改：在这条会话的成片下方点「在 Studio 里修改」，或内容库打开这条再点同一个按钮。"
  ]
    .filter(Boolean)
    .join("\n");
}

/** 立即执行一个任务（手动触发与定时触发共用）。 */export async function runScheduledJob(
  jobId: string,
  trigger: "SCHEDULE" | "MANUAL" = "SCHEDULE"
): Promise<SchedulerRunResult> {
  const job = await prisma.scheduledJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, status: "FAILED", error: "任务不存在。" };
  if (inFlight.has(jobId)) return { ok: false, status: "FAILED", error: "任务正在执行中。" };

  inFlight.add(jobId);
  await prisma.scheduledJob
    .update({ where: { id: jobId }, data: { lastStatus: "RUNNING", lastError: null } })
    .catch(() => undefined);

  // 每次执行落一条运行记录（任务卡片里可以展开看历史）。
  // 记录失败不能影响任务本身：整段 catch 掉。
  const startedAt = Date.now();
  const run = await prisma.scheduledJobRun
    .create({ data: { jobId, userId: job.userId, status: "RUNNING", trigger, startedAt: new Date() } })
    .catch(() => null);

  /** 收尾：写状态/耗时，并只保留最近 50 条，避免表无限长。 */
  const finishRun = async (status: "SUCCEEDED" | "FAILED", payload: { result?: string; error?: string }) => {
    if (!run) return;
    await prisma.scheduledJobRun
      .update({
        where: { id: run.id },
        data: {
          status,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
          result: payload.result?.slice(0, 4000) ?? null,
          error: payload.error?.slice(0, 1000) ?? null
        }
      })
      .catch(() => undefined);
    const overflow = await prisma.scheduledJobRun
      .findMany({ where: { jobId }, orderBy: { startedAt: "desc" }, skip: 50, select: { id: true } })
      .catch(() => [] as Array<{ id: string }>);
    if (overflow.length) {
      await prisma.scheduledJobRun
        .deleteMany({ where: { id: { in: overflow.map((item) => item.id) } } })
        .catch(() => undefined);
    }
  };

  try {
    const target = await resolveWechatTarget(job.userId).catch(() => null);

    // 视频任务不走 agent：直接跑 huashu-motion 出片（一条 15~25 分钟），
    // 成片写进内容库并在这条任务专属会话里留进度，方便之后去 Studio 改。
    const isVideoJob = (job.kind || "TEXT").toUpperCase() === "VIDEO";
    let content = "";
    if (isVideoJob) {
      content = await runVideoJob({
        userId: job.userId,
        name: job.name,
        prompt: job.prompt,
        videoSiteUrl: job.videoSiteUrl ?? null,
        videoImagesJson: job.videoImagesJson ?? null,
        videoTargetSeconds: job.videoTargetSeconds
      });
    } else {
      const result = await openClawClient.sendTask({
        message: job.prompt,
        userId: job.userId,
        // 定时任务常是多步长流程（抓热点/生成/入库），120s 默认超时必掐断；放宽到 10 分钟。
        timeoutMs: Number(process.env.SCHEDULE_TASK_TIMEOUT_MS ?? 600_000),
        // 空文本自动重跑 = 整个任务再执行一遍（重复入库/发布），对有副作用的任务绝不允许。
        retryOnEmpty: false
      });
      content = (result.content || "").trim();
    }
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
    await finishRun("SUCCEEDED", { result: content });
    return { ok: true, status: "SUCCEEDED", content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.scheduledJob
      .update({
        where: { id: jobId },
        data: { lastRunAt: new Date(), lastStatus: "FAILED", lastError: message.slice(0, 1000) }
      })
      .catch(() => undefined);
    await finishRun("FAILED", { error: message });
    return { ok: false, status: "FAILED", error: message };
  } finally {
    inFlight.delete(jobId);
  }
}

/**
 * 当天是否已经成功跑过一次（按任务自己的时区算日历日）。
 *
 * 给「每天一次」类任务兜底：即使同一分钟锁被绕过（自动化脚本自己再触发一次，
 * 或手动执行完又恰好到点），同一天也不会产出第二批内容。
 * 只看 SCHEDULE 触发的成功记录，手动执行不受影响。
 */
async function alreadyRanToday(jobId: string, timeZone: string, now: Date): Promise<boolean> {
  const today = localParts(now, timeZone);
  const since = new Date(now.getTime() - 26 * 60 * 60 * 1000);
  const sameDay = (d: Date) => {
    const p = localParts(d, timeZone);
    return p.year === today.year && p.month === today.month && p.day === today.day;
  };
  const runs = await prisma.scheduledJobRun
    .findMany({
      where: { jobId, status: "SUCCEEDED", trigger: "SCHEDULE", startedAt: { gte: since } },
      select: { startedAt: true },
      orderBy: { startedAt: "desc" },
      take: 20
    })
    .catch(() => [] as Array<{ startedAt: Date }>);
  if (runs.some((r) => sameDay(r.startedAt))) return true;
  // 运行记录被裁剪（每个任务只留最近 50 条）时，回退看 lastRunAt。
  const job = await prisma.scheduledJob
    .findUnique({ where: { id: jobId }, select: { lastRunAt: true, lastStatus: true } })
    .catch(() => null);
  return Boolean(job?.lastRunAt && job.lastStatus === "SUCCEEDED" && sameDay(job.lastRunAt));
}

/**
 * 一次轮询：找出「本分钟应当执行」的任务并触发。
 */

export async function tickScheduler(now = new Date()): Promise<string[]> {
  const jobs = await prisma.scheduledJob.findMany({ where: { enabled: true } });
  const fired: string[] = [];
  for (const job of jobs) {
    if (inFlight.has(job.id)) continue;
    const oncePerDayEnabled = (job as unknown as { oncePerDay?: boolean }).oncePerDay === true;

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
    // 同一分钟只跑一次（开跑前还会用 claimMinute 抢占，覆盖长任务未写完 lastRunAt 的窗口）
    if (job.lastRunAt && minuteKey(job.lastRunAt, job.timezone) === key) continue;
    if (!matchCron(job.cronExpr, localParts(now, job.timezone))) continue;
    // 同一分钟只允许一个执行者：抢不到锁就跳过（跨进程 / HMR / 重启都靠这一层兜住）。
    if (!(await claimMinute(job.id, key))) continue;
    // 每天一次类任务：当天已经成功跑过就不再跑第二遍（防同一时点被重复触发）。
    // 用户可以随时把任务的 oncePerDay 关掉，改回纯 cron 语义。
    if (oncePerDayEnabled && (await alreadyRanToday(job.id, job.timezone || "Asia/Shanghai", now))) continue;
    fired.push(job.id);
    // 不 await：长任务不应阻塞本轮其它任务
    void runScheduledJob(job.id).catch((error) => {
      console.error(`[scheduler] 任务 ${job.name} 执行异常：`, error);
    });
  }
  return fired;
}

/** 启动调度器（幂等，服务启动时调用一次）。 */
/**
 * 服务启动时把「上一次进程里没跑完」的状态收尾。
 *
 * 执行任务的 promise 活在上一个进程里，进程一重启它就消失了，
 * 但数据库里 lastStatus / ScheduledJobRun.status 仍是 RUNNING、视频项目仍是 BUILDING，
 * 面板会永远显示「正在执行」，定时任务也可能因为 inFlight 判断而卡住。
 */
export async function recoverInterruptedRuns(): Promise<void> {
  const now = new Date();
  // 只清「3 分钟前就开始了」的：清理本身可能因为 HMR / 多实例被再次触发，
  // 无差别清理会把刚点「立即执行」还在跑的任务误判为中断（实测踩过一次）。
  const cutoff = new Date(now.getTime() - 3 * 60 * 1000);
  const jobs = await prisma.scheduledJob
    .updateMany({
      where: { lastStatus: "RUNNING", lastRunAt: { lt: cutoff } },
      data: { lastStatus: "FAILED", lastError: "服务重启，本次执行被中断。" }
    })
    .catch(() => null);
  const runs = await prisma.scheduledJobRun
    .updateMany({
      where: { status: "RUNNING", startedAt: { lt: cutoff } },
      data: { status: "FAILED", finishedAt: now, error: "服务重启，本次执行被中断。" }
    })
    .catch(() => null);
  if (jobs?.count || runs?.count) {
    console.log(`[scheduler] 清理中断执行：任务 ${jobs?.count ?? 0} 条，记录 ${runs?.count ?? 0} 条`);
  }

  // 出片项目同理：卡在 BUILDING 的（30 分钟前创建）一定是被中断的，改 FAILED 才能重试
  const projects = await prisma.videoMotionProject
    .updateMany({
      where: { status: "BUILDING", createdAt: { lt: new Date(Date.now() - 30 * 60 * 1000) } },
      data: { status: "FAILED", error: "生成中断（服务重启或 DSH 无响应）。" }
    })
    .catch(() => null);
  if (projects?.count) {
    console.log(`[scheduler] 清理中断的视频项目：${projects.count} 个`);
  }
}

export function startScheduler(): void {
  if (started) return;
  started = true;
  // 进程重启时，上一轮还在跑的任务/记录会永远停在 RUNNING（执行它的进程已经没了）。
  // 启动即补一次收尾，否则面板上会一直显示「正在执行」。
  void recoverInterruptedRuns().catch((error) => {
    console.error("[scheduler] 清理中断任务失败：", error instanceof Error ? error.message : error);
  });
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
