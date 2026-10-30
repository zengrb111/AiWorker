/**
 * Studio 评论的**自动接单**（后台 worker）。
 *
 * 目标：用户在 Studio 里写完评论就不用管了 —— 平台自己在后台扫描待处理评论，
 * 交给 DSH 改片，改完自动重新出片，平台里的视频直接变成新版。
 *
 * 为什么用 tick 轮询而不是 Studio 回调：
 * - Studio 是 om 起的一个本机 HTTP 服务，评论只落在项目目录的 `.om/inbox.jsonl` 里，
 *   没有 webhook，也没有对外事件；
 * - 项目里已有成熟的 tick 模式（scheduler / collectors 都是 instrumentation 定时 POST），
 *   照同一套走，不引入新的常驻进程。
 *
 * 成本控制（重要）：
 * - 一次 tick 最多处理 2 个项目、每个项目最多 1 条评论：一条评论就是一次几分钟的 DSH 调用；
 * - 同一项目串行（processing），避免同时改 index.html；
 * - 只扫最近 24 小时更新过、且已经出过片的项目，老项目不会一直被扫。
 */

import { prisma } from "@/lib/prisma";
import { runDshRender } from "@/lib/dsh";
import {
  buildEditPrompt,
  omDone,
  omInboxClaim,
  omInboxList,
  omInboxReopen,
  omLook,
  omRender,
  probeDuration,
  publishVideo,
  trimToSeconds,
  type MotionComment
} from "./huashu";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractVideoPoster } from "@/lib/video/poster";
import { writeVideoProgress } from "@/lib/video/progress-file";

const MAX_PROJECTS_PER_TICK = 2;
/** 每轮最多检查多少个项目的 inbox（纯读文件，很便宜） */
const MAX_SCAN_PER_TICK = 400;
const MAX_COMMENTS_PER_PROJECT = 1;
const RECENT_MS = 24 * 60 * 60 * 1000;

type ProjectLike = {
  id: string;
  token: string;
  userId: string;
  conversationId: string | null;
  /** 改片过程是否写进会话（手动出片为 false） */
  progressInChat: boolean;
  projectDir: string;
  videoUrl: string | null;
  versionsJson: string;
  /** 成片目标时长（秒）；Studio 改片据此约束节奏与裁剪。null=按 20s 旧默认。 */
  targetSeconds: number | null;
};

type VersionRecord = {
  version: number;
  videoUrl: string;
  duration: number | null;
  createdAt: string;
  note: string;
};

/**
 * 给 promise 套一层硬超时。
 *
 * runDshRender 自己也带 timeout，但它等的是子进程 exit：实测桥接进程被系统回收后
 * promise 永不 settle，任务会一直占着项目锁（评论停在 working，之后再也不能改）。
 * 这里再兜一层，超时直接抛错，交给上层 reopen 重试。
 */
function withHardTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * 本地判断 .om/inbox.jsonl 里有没有 pending 评论。
 *
 * 规则与 om 的 comments() 折叠一致：comment→pending、claim→working、
 * done→done、reopen→pending、cancel→cancelled。
 * 纯读文件（几 KB），用来决定「值不值得 spawn om inbox」——
 * 之前每轮对每个项目都 spawn 一次，只好把扫描量压到 2 个，老视频就永远轮不到。
 */
function readPendingCount(projectDir: string): number {
  try {
    const file = join(projectDir, ".om", "inbox.jsonl");
    if (!existsSync(file)) return 0;
    const status = new Map<string, string>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let event: { type?: string; id?: string };
      try {
        event = JSON.parse(line) as { type?: string; id?: string };
      } catch {
        continue;
      }
      if (!event.id) continue;
      if (event.type === "comment") status.set(event.id, "pending");
      else if (event.type === "claim") status.set(event.id, "working");
      else if (event.type === "done") status.set(event.id, "done");
      else if (event.type === "reopen") status.set(event.id, "pending");
      else if (event.type === "cancel") status.set(event.id, "cancelled");
    }
    let count = 0;
    for (const value of status.values()) if (value === "pending") count += 1;
    return count;
  } catch {
    return 0;
  }
}

/** 正在处理的项目（同一项目不并发，手动与自动共用这一把锁）。 */
const processing = new Set<string>();

/**
 * 每个项目复用的进度消息。
 *
 * 一轮 tick 只处理 1 条评论，3 条评论就会跑 3 轮；如果每轮都新建一条消息，
 * 会话里会堆出一串「## Studio 修改」，把对话刷屏（实测 4 条）。
 * 这里记住上一次用的消息，1 小时内继续往同一条里追加。
 */
const progressMessages = new Map<string, { id: string; at: number; lines: string[] }>();
const PROGRESS_REUSE_MS = 60 * 60 * 1000;
const PROGRESS_MAX_LINES = 30;

/** 每条评论的自动重试次数（进程内），避免一条改不动的评论无限占用 tick。 */
/** 改片硬超时：比 DSH 自己的 900s 再多给 2 分钟收尾 */
const DSH_EDIT_TIMEOUT_MS = 1_020_000;

const retryAttempts = new Map<string, number>();
const MAX_RETRY = 2;

export type ProcessOutcome = {
  busy: boolean;
  processed: Array<{ id: string; text: string; note: string }>;
  remaining: number;
  /** 会话里的进度消息 id（没会话时为 null），供出片后追加结果行。 */
  progressMessageId: string | null;
};

/** 进度消息的正文：标题 + 若干条进度行。 */
function formatProgress(lines: string[]): string {
  return ["## Studio 修改", "", ...lines.map((line) => `- ${line}`)].join("\n");
}

/** 在会话里追加一行进度（进度消息被删/不存在时静默跳过）。 */
export async function appendProgressLine(messageId: string | null, line: string): Promise<void> {
  if (!messageId) return;
  try {
    const message = await prisma.message.findUnique({ where: { id: messageId }, select: { content: true } });
    if (!message) return;
    await prisma.message.update({
      where: { id: messageId },
      data: { content: `${message.content}\n- ${line}` }
    });
  } catch {
    // 进度写入失败不影响改片本身
  }
}

/**
 * 处理一个项目里待处理的评论。
 *
 * 手动入口（/api/video-motion/[token]/inbox）与自动 tick 都走这里，
 * 区别只是 onProgress 有没有人看。
 */
export async function processPendingComments(
  project: ProjectLike,
  options: {
    limit?: number;
    onProgress?: (text: string) => void;
    /**
     * 是否把进度写进平台会话（默认跟 project.progressInChat）。
     *
     * 2026-10-27 起自动 tick 传 false：Studio 改片的进展只在 **Studio 顶部状态区** 显示，
     * 平台会话里不再刷「## Studio 修改」这类消息（用户明确要求）。手动从会话里点「立即处理」
     * 的入口仍传 true —— 那本来就是用户主动要看的流式进度。
     */
    chatProgress?: boolean;
  } = {}
): Promise<ProcessOutcome> {
  const limit = options.limit ?? MAX_COMMENTS_PER_PROJECT;
  const chatProgress = options.chatProgress ?? project.progressInChat;

  if (processing.has(project.id)) {
    return { busy: true, processed: [], remaining: 0, progressMessageId: null };
  }
  processing.add(project.id);

  let progressMessageId: string | null = null;
  let progressLines: string[] = [];

  /** 同时推给 SSE 与「会话里的进度消息」；进度写入失败不影响改片。 */
  const report = async (text: string) => {
    progressLines = [...progressLines, text];
    options.onProgress?.(text);
    if (!progressMessageId) return;
    progressMessages.set(project.id, { id: progressMessageId, at: Date.now(), lines: progressLines });
    await prisma.message
      .update({ where: { id: progressMessageId }, data: { content: formatProgress(progressLines) } })
      .catch(() => undefined);
  };

  try {
    const pending = (await omInboxList(project.projectDir)).filter(
      (c) => !c.status || c.status === "pending"
    );
    if (!pending.length) return { busy: false, processed: [], remaining: 0, progressMessageId: null };

    // 会话里的进度消息：用户切走了也能回来看到「AI 在做什么、改到第几条」。
    // 1 小时内复用同一条（3 条评论 = 3 轮 tick，不该刷出 3 条独立消息）。
    if (project.conversationId && chatProgress) {
      const cached = progressMessages.get(project.id);
      const reusable =
        cached && Date.now() - cached.at < PROGRESS_REUSE_MS && cached.lines.length < PROGRESS_MAX_LINES;
      if (reusable) {
        progressMessageId = cached!.id;
        progressLines = [...cached!.lines, `还有 ${pending.length} 条待处理评论，继续处理…`];
        await prisma.message
          .update({ where: { id: progressMessageId }, data: { content: formatProgress(progressLines) } })
          .catch(() => undefined);
      } else {
        // 进程重启后内存记录会丢：从会话里找回 1 小时内最近一条进度消息接着写，
        // 否则每重启一次就多一条「## Studio 修改」。
        const recent = await prisma.message
          .findFirst({
            where: {
              conversationId: project.conversationId,
              role: "ASSISTANT",
              content: { startsWith: "## Studio 修改" },
              createdAt: { gte: new Date(Date.now() - PROGRESS_REUSE_MS) }
            },
            orderBy: { createdAt: "desc" },
            select: { id: true, content: true }
          })
          .catch(() => null);
        const recentLines = recent
          ? recent.content.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2))
          : [];
        if (recent && recentLines.length < PROGRESS_MAX_LINES) {
          progressMessageId = recent.id;
          progressLines = [...recentLines, `还有 ${pending.length} 条待处理评论，继续处理…`];
          await prisma.message
            .update({ where: { id: progressMessageId }, data: { content: formatProgress(progressLines) } })
            .catch(() => undefined);
        } else {
          const message = await prisma.message
            .create({
              data: {
                conversationId: project.conversationId,
                role: "ASSISTANT",
                content: formatProgress([`收到 ${pending.length} 条 Studio 评论，开始处理…`])
              }
            })
            .catch(() => null);
          progressMessageId = message?.id ?? null;
          progressLines = [`收到 ${pending.length} 条 Studio 评论，开始处理…`];
        }
      }
      if (progressMessageId) {
        progressMessages.set(project.id, { id: progressMessageId, at: Date.now(), lines: progressLines });
      }
    }

    const processed: Array<{ id: string; text: string; note: string }> = [];
    for (let index = 0; index < limit; index++) {
      // 原子认领：两个进程同时扫到同一条时，只有先 claim 的那个能拿到，
      // 避免同一条评论被改两遍（实测发生过，重复出片也浪费模型调用）。
      const comment = await omInboxClaim(project.projectDir, 2);
      if (!comment) break;
      // 会话里的实时进度卡：改片动辄十几分钟，只显示「思考中」用户没法判断死活。
      // 这里按 project 的归属用户/会话写，前端轮询 /video-progress 读。
      writeVideoProgress({
        userId: project.userId,
        conversationId: project.conversationId,
        kind: "edit",
          token: project.token,
        stage: "queued",
        percent: 8,
        message: `已接单：正在定位「${comment.text.slice(0, 16)}」那一帧…`,
        start: index === 0
      });
      try {
        await report(
          `正在看「${comment.text.slice(0, 24)}」那一帧（${comment.t != null ? comment.t.toFixed(1) + "s" : "无时间点"}）…`
        );
        const look = await omLook(comment.id, project.projectDir);
        writeVideoProgress({
          userId: project.userId,
          conversationId: project.conversationId,
          kind: "edit",
          token: project.token,
          stage: "editing",
          percent: 25,
          message: "AI 正在按你的评论改这一处（通常 3~10 分钟）…"
        });
        await report("帧图已生成，AI 正在只改这一处…");
        const reply = await withHardTimeout(
          runDshRender(
            buildEditPrompt({
              dir: project.projectDir,
              comment,
              lookOutput: look,
              // 原始就没设目标时长（对话一键生成未写时长）则传 null：改片不强行压回 20s，
              // 只改用户点出来的那一处，整体长度保持原样。
              targetSeconds: project.targetSeconds
            }),
            {
            userId: project.userId,
            timeoutMs: 900_000,
            sessionId: `huashu-edit-${project.token}`,
            workspaceDir: project.projectDir
          }),
          DSH_EDIT_TIMEOUT_MS,
          `DSH 改片超时（${Math.round(DSH_EDIT_TIMEOUT_MS / 60000)} 分钟无响应）`
        );
        const note =
          (reply || "已按要求修改。").trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || "已按要求修改。";
        await omDone(comment.id, project.projectDir, note.slice(0, 200));
        writeVideoProgress({
          userId: project.userId,
          conversationId: project.conversationId,
          kind: "edit",
          token: project.token,
          stage: "edited",
          percent: 60,
          message: "这一处已改好，准备重新出片"
        });
        processed.push({ id: comment.id, text: comment.text, note });
        retryAttempts.delete(comment.id);
        await report(`已改完：${note}`);
      } catch (editError) {
        const reason = editError instanceof Error ? editError.message : String(editError);
        const attempt = (retryAttempts.get(comment.id) ?? 0) + 1;
        retryAttempts.set(comment.id, attempt);

        // 关键：认领后失败如果不管，这条评论会停在 working，之后永远扫不到 ——
        // 用户看到的就是「大部分改过来了、有一条没过来」。这里退回待处理，下一轮重试。
        writeVideoProgress({
          userId: project.userId,
          conversationId: project.conversationId,
          kind: "edit",
          token: project.token,
          stage: attempt <= MAX_RETRY ? "retry" : "failed",
          percent: attempt <= MAX_RETRY ? 20 : 100,
          message:
            attempt <= MAX_RETRY
              ? `改片失败，正在自动重试（第 ${attempt} 次）…`
              : `改片失败（已重试 ${attempt} 次）：${reason.split(/\r?\n/)[0].slice(0, 80)}`,
          terminal: attempt > MAX_RETRY
        });
        if (attempt <= MAX_RETRY) {
          await omInboxReopen(
            project.projectDir,
            comment.id,
            `自动重试（第 ${attempt} 次）：${reason}`
          ).catch(() => undefined);
          await report(`这条改失败，已排队自动重试（第 ${attempt} 次）：${reason.split(/\r?\n/)[0]}`);
        } else {
          await omDone(
            comment.id,
            project.projectDir,
            `自动重试 ${attempt} 次仍失败：${reason}`.slice(0, 200)
          ).catch(() => undefined);
          await report(`这条多次失败，已跳过并记录原因：${reason.split(/\r?\n/)[0]}`);
        }
      }
    }

    const left = (await omInboxList(project.projectDir).catch(() => [])).filter(
      (c) => !c.status || c.status === "pending"
    ).length;
    return {
      busy: false,
      processed,
      remaining: left,
      progressMessageId
    };
  } catch (error) {
    // 失败也要落一行，否则会话里那条进度消息会永远停在「正在看…」
    if (progressMessageId) {
      await appendProgressLine(
        progressMessageId,
        `处理失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw error;
  } finally {
    processing.delete(project.id);
  }
}

/**
 * 出片锁：同一项目同一时刻只允许一个进程渲染。
 *
 * `processing` 只是进程内标记，挡不住「两个 dev server 同时在跑」——
 * 实测 3000 与 3001 都开着时，两边各渲染一次，版本号都算成 v7，
 * 后写的把先写的覆盖掉。这里用项目目录下的锁目录做跨进程互斥。
 */
async function withRenderLock<T>(project: ProjectLike, fn: () => Promise<T>): Promise<T> {
  const lockDir = join(project.projectDir, "out", ".render-lock");
  const deadline = Date.now() + 600_000;
  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false });
      break;
    } catch {
      // 锁超过 15 分钟视为残留（渲染正常 1 分钟内完成）
      try {
        const age = Date.now() - statSync(lockDir).mtimeMs;
        if (age > 15 * 60 * 1000) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error("另一个进程正在出片，等待超时。");
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * 重新出片并更新**项目记录**，返回新版本信息。手动按钮与自动 tick 共用。
 *
 * 2026-10-26 起这里**不再**顺带回写内容库与会话里的视频消息：
 * 改片是「在工作副本上试」，用户可能连改几版才满意，自动回写会把已发布内容
 * 和聊天里那条消息一起刷成半成品。回写统一走 `syncProjectTargets()`（手动按钮触发）。
 */
export async function rerenderProject(project: ProjectLike): Promise<{
  videoUrl: string;
  version: number;
  duration: number | null;
}> {
  return withRenderLock(project, async () => {
    writeVideoProgress({
      userId: project.userId,
      conversationId: project.conversationId,
      kind: "edit",
          token: project.token,
      stage: "rendering",
      percent: 72,
      message: "正在重新出片（1080×1920 逐帧渲染，约 1~4 分钟）…"
    });
    const rendered = await omRender(project.projectDir);
    let file = rendered.file;
    let duration = await probeDuration(file);
    // 按项目目标时长裁剪：DSH 偶尔会超长，超了再兜底裁。
    // 项目未设目标时长（null，即对话「一键生成视频」未写时长时）则不裁剪，
    // 保留 DSH 自然展开的成片长度，避免把无上限的片子硬砍回 20s。
    const targetSeconds = project.targetSeconds;
    if (targetSeconds != null && duration != null && duration > targetSeconds + 0.3) {
      const maxSeconds = targetSeconds + 0.3; // 渲染按帧对齐常差一两帧，给 0.3s 容差
      const trimmed = join(project.projectDir, "out", `trimmed-${targetSeconds}s.mp4`);
      await trimToSeconds(file, targetSeconds, trimmed);
      file = trimmed;
      duration = (await probeDuration(file)) ?? targetSeconds;
    }

    // 版本号取「数据库记录」与「已经在 public/videos 里的文件」两者最大值 +1：
    // 并发或历史脏数据都可能让 JSON 里的条数比实际文件少，只按条数算会覆盖旧版本。
    const versions = (JSON.parse(project.versionsJson || "[]") as VersionRecord[]) || [];
    const published = readdirSync(join(process.cwd(), "public", "videos"))
      .map((name) => {
        const hit = new RegExp(`^huashu-${project.token}-v(\\d+)\\.mp4$`).exec(name);
        return hit ? Number(hit[1]) : 0;
      })
      .filter(Boolean);
    const version = Math.max(versions.length, ...published, 0) + 1;
    const videoUrl = publishVideo(file, project.token, version);
    const record: VersionRecord = {
      version,
      videoUrl,
      duration,
      createdAt: new Date().toISOString(),
      note: "Studio 评论修改后自动出片"
    };

    await prisma.videoMotionProject.update({
      where: { id: project.id },
      data: {
        videoUrl,
        versionsJson: JSON.stringify([...versions, record]),
        status: "READY",
        error: null
      }
    });

    writeVideoProgress({
      userId: project.userId,
      conversationId: project.conversationId,
      kind: "edit",
          token: project.token,
      stage: "done",
      percent: 100,
      message: `已出片 v${version}${duration ? `（${duration.toFixed(1)}s）` : ""}`,
      terminal: true
    });

    return { videoUrl, version, duration };
  });
}

/** 同步目标：内容库条目 / 会话里那条视频消息。 */
export type SyncTarget = "content" | "conversation";

export type SyncResult = {
  videoUrl: string;
  version: number | null;
  /** 内容库里匹配到的条目数（0 = 这条片子没入库，比如手动出片的） */
  contentFound: number;
  contentUpdated: number;
  /** 会话里引用了这条视频的消息数（0 = 没有对话记录） */
  messagesFound: number;
  messagesUpdated: number;
};

/**
 * 把项目**当前版本**（VideoMotionProject.videoUrl）回写到指定目标。
 *
 * 只在用户显式点按钮时调用：改片自动出片只更新项目本身，内容库/会话保持旧版，
 * 直到用户确认「这版可以了」再同步过去。
 *
 * 匹配一律按 token，不按上一版 URL 精确匹配 —— 历史版本可能跳号
 * （手动出过 v2 但当时没回写），精确替换会漏。
 */
export async function syncProjectTargets(
  token: string,
  targets: SyncTarget[],
  options: { userId?: string } = {}
): Promise<SyncResult> {
  const project = await prisma.videoMotionProject.findFirst({ where: { token } });
  if (!project) throw new Error("视频项目不存在。");
  if (options.userId && project.userId !== options.userId) throw new Error("无权操作这个视频。");
  const videoUrl = project.videoUrl;
  if (!videoUrl) throw new Error("这个视频还没有出过片，没有可同步的版本。");

  const versionHit = new RegExp(`/huashu-${project.token}-v(\\d+)\\.mp4$`).exec(videoUrl);
  const version = versionHit ? Number(versionHit[1]) : null;

  let contentFound = 0;
  let contentUpdated = 0;
  let messagesFound = 0;
  let messagesUpdated = 0;

  if (targets.includes("content")) {
    const contentMarker = `/videos/huashu-${project.token}-v`;
    const linked = await prisma.contentItem
      .findMany({ where: { userId: project.userId, videoUrl: { contains: contentMarker } }, select: { id: true } })
      .catch(() => [] as Array<{ id: string }>);
    contentFound = linked.length;
    if (linked.length) {
      const ids = linked.map((item) => item.id);
      await prisma.contentItem
        .updateMany({ where: { id: { in: ids } }, data: { videoUrl } })
        .catch(() => undefined);
      contentUpdated = ids.length;

      // 新版可能换了开场画面，封面帧跟着重抽一次（失败就保留旧封面）
      const poster = await extractVideoPoster(videoUrl, `huashu-${project.token}-v${version ?? "x"}`);
      if (poster) {
        await prisma.contentItem
          .updateMany({ where: { id: { in: ids } }, data: { coverImageUrl: poster } })
          .catch(() => undefined);
      }
    }
  }

  if (targets.includes("conversation")) {
    const marker = `/videos/huashu-${project.token}-v`;
    const versionRe = new RegExp(`/videos/huashu-${project.token}-v\\d+\\.mp4`, "g");
    const stale = await prisma.message
      .findMany({ where: { content: { contains: marker } }, select: { id: true, content: true } })
      .catch(() => [] as Array<{ id: string; content: string }>);
    messagesFound = stale.length;
    for (const message of stale) {
      const next = message.content.replace(versionRe, videoUrl);
      if (next === message.content) continue;
      await prisma.message
        .update({ where: { id: message.id }, data: { content: next } })
        .catch(() => undefined);
      messagesUpdated += 1;
    }
  }

  return { videoUrl, version, contentFound, contentUpdated, messagesFound, messagesUpdated };
}

let ticking = false;

export type TickResult = {
  scanned: number;
  edited: number;
  rendered: number;
  skipped: boolean;
  notes: string[];
};

/**
 * 扫一轮：有待处理评论就改，改完自动重出片。
 *
 * 重叠保护：上一轮还在跑（DSH 可能十几分钟）时直接返回 skipped，
 * 否则 instrumentation 每 30 秒一次会把请求堆成几十个。
 */
export async function runHuashuInboxTick(): Promise<TickResult> {
  if (ticking) return { scanned: 0, edited: 0, rendered: 0, skipped: true, notes: [] };
  ticking = true;
  const notes: string[] = [];
  let scanned = 0;
  let edited = 0;
  let rendered = 0;

  try {
    // 🔴 不能再只扫「最近更新的 N 个项目」：老视频在 Studio 里改了以后永远轮不到
    // （实测 v12 那条 7 小时没更新过，评论一直 pending）。改成扫全部 READY/FAILED，
    // 先用**本地读文件**判断有没有 pending 评论（纯 fs，不 spawn om），有才认领。
    const projects = await prisma.videoMotionProject.findMany({
      where: {
        status: { in: ["READY", "FAILED"] },
        updatedAt: { gte: new Date(Date.now() - RECENT_MS) }
      },
      orderBy: { updatedAt: "desc" },
      take: MAX_SCAN_PER_TICK
    });

    let claimedThisTick = 0;
    for (const project of projects) {
      scanned += 1;
      if (processing.has(project.id)) continue;
      if (claimedThisTick >= MAX_PROJECTS_PER_TICK) break;
      if (readPendingCount(project.projectDir) === 0) continue;

      const pendingCount = readPendingCount(project.projectDir);
      notes.push(`${project.token}: 收到 ${pendingCount} 条评论`);
      const outcome = await processPendingComments(project, {
        limit: MAX_COMMENTS_PER_PROJECT,
        // Studio 触发的改片不往平台会话里刷进度（进展只在 Studio 顶部状态区显示）
        chatProgress: false,
        onProgress: (text) => notes.push(`${project.token}: ${text}`)
      });
      claimedThisTick += 1;
      edited += outcome.processed.length;
      if (!outcome.processed.length) continue;

      // 改完直接出新版（只更新项目本身）。内容库与会话里的视频**不自动变**：
      // 用户确认这版可以后，自己去点「同步修改到内容库 / 视频」。
      try {
        await appendProgressLine(outcome.progressMessageId, "正在重新出片…");
        const next = await rerenderProject(project);
        rendered += 1;
        notes.push(`${project.token}: 已自动出片 v${next.version}`);
        await appendProgressLine(
          outcome.progressMessageId,
          `已出片 v${next.version}${next.duration ? `（${next.duration.toFixed(1)}s）` : ""}。` +
            `内容库与会话视频没有自动更新——确认这版可以后，在 Studio 点「同步修改到内容库」，或在视频面板点「同步修改到视频」。`
        );
      } catch (renderError) {
        const reason = renderError instanceof Error ? renderError.message : String(renderError);
        writeVideoProgress({
          userId: project.userId,
          conversationId: project.conversationId,
          kind: "edit",
          token: project.token,
          stage: "failed",
          percent: 100,
          message: `出片失败：${reason.split(/\r?\n/)[0].slice(0, 80)}`,
          terminal: true
        });
        notes.push(`${project.token}: 修改完成但自动出片失败（${reason}）`);
        await appendProgressLine(outcome.progressMessageId, `自动出片失败：${reason}`);
      }
    }

    return { scanned, edited, rendered, skipped: false, notes };
  } finally {
    ticking = false;
  }
}

/** 给前端展示「AI 正在改」用。 */
export function isProjectProcessing(projectId: string): boolean {
  return processing.has(projectId);
}

export type { MotionComment };
