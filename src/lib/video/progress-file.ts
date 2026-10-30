/**
 * 「后台视频任务」进度文件的统一写入口。
 *
 * 会话里要显示「正在生成视频 / 正在改片 · N%」这类实时进度，但两种任务的执行者完全不同：
 * - 生成：agent 用 bash 跑 `scripts/aiworker-video.mts`（独立进程，平台拿不到它的 token）；
 * - 改片：平台自己的 tick 进程里跑 DSH（`huashu-inbox-worker`）。
 *
 * 两边都往同一个地方写：`data/video-progress/<userId>.json`（按用户、只保留最新一次）。
 * 前端轮询 `/api/conversations/[id]/video-progress` 读它，因此不依赖 token。
 *
 * 放 `data/` 而不是 `public/`：进度文案（含用户写的评论摘要）不该被静态目录直接暴露。
 *
 * 并发说明：同一用户同一时刻只跑一个视频任务（改片本身有项目锁、生成是串行 bash），
 * 所以「按用户一个文件」够用。payload 里带 `conversationId`，接口只在会话匹配时显示，
 * 避免 A 会话的视频进度串到 B 会话。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type VideoProgressKind = "generate" | "edit";

export type VideoProgressInput = {
  userId: string;
  /** 归属会话；改片一定知道，CLI 生成可能没有 */
  conversationId?: string | null;
  kind: VideoProgressKind;
  /** 机器可读阶段（queued / look / editing / edited / rendering / done / failed） */
  stage: string;
  percent: number;
  message: string;
  token?: string;
  /** 任务结束（成功或失败） */
  terminal?: boolean;
  /** 新一轮任务的第一条进度：重置已用时间起点 */
  start?: boolean;
};

type StoredPayload = {
  userId: string;
  conversationId: string | null;
  kind: VideoProgressKind;
  stage: string;
  percent: number;
  message: string;
  token?: string;
  startedAt: string;
  updatedAt: string;
  terminal: boolean;
};

/** 每个任务（用户+会话）的起始时间，进程内缓存：多次写进度不会把已用时间清零。 */
const startedAtCache = new Map<string, number>();

const PROGRESS_DIR = () => join(process.cwd(), "data", "video-progress");

function keyOf(input: VideoProgressInput): string {
  return `${input.userId}|${input.conversationId ?? ""}`;
}

/**
 * 写一条进度。任何 IO 失败都静默忽略 —— 进度是给人看的辅助信息，
 * 绝不能因为它把出片/改片主流程带崩。
 */
export function writeVideoProgress(input: VideoProgressInput): void {
  const key = keyOf(input);
  const now = Date.now();
  if (input.start || !startedAtCache.has(key)) startedAtCache.set(key, now);
  const startedAt = startedAtCache.get(key) ?? now;
  if (input.terminal) startedAtCache.delete(key);

  const payload: StoredPayload = {
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    kind: input.kind,
    stage: input.stage,
    percent: Math.max(0, Math.min(100, Math.round(input.percent))),
    message: input.message,
    token: input.token,
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(now).toISOString(),
    terminal: !!input.terminal
  };

  try {
    const dir = PROGRESS_DIR();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${input.userId}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // 忽略：前端只会看不到进度条，任务本身照常跑。
  }
}

/** 读当前用户的进度文件（供 API 路由用）。读不到/损坏返回 null。 */
export function readVideoProgress(userId: string): StoredPayload | null {
  try {
    const raw = readFileSync(join(PROGRESS_DIR(), `${userId}.json`), "utf8");
    return JSON.parse(raw) as StoredPayload;
  } catch {
    return null;
  }
}
