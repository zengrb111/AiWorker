/**
 * GET /api/conversations/[id]/video-progress —— 会话里「跑视频任务 / 改片」时的实时进度。
 *
 * 为什么需要它：两类后台任务都不经本进程的事件流 ——
 * - 生成视频：agent 在网关侧用 bash 跑 `scripts/aiworker-video.mts`；
 * - Studio 改片：跑在 tick 进程里（DSH，几分钟到十几分钟）。
 * 之前前端只能显示静止的「思考中…」，用户完全不知道点的那一下到底有没有在跑。
 *
 * 数据源：`data/video-progress/<userId>.json`（`writeVideoProgress()` 统一写），
 * 按登录用户读，**不依赖 token**，生成/改片两条链路都覆盖。
 *
 * 返回：
 *   { running:false }                                   没有正在跑的任务（或不是本会话的）
 *   { running:true, kind, stage, percent, message, elapsedSeconds }
 * 超过 STALE_MS 没有新写入且未终态 → running:false + stale:true（任务可能卡住/进程被杀）
 */
import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { readVideoProgress } from "@/lib/video/progress-file";

export const dynamic = "force-dynamic";

/** 进度文件多久没更新就算"可能卡住"（改片在 DSH 阶段可能几分钟没新行，5 分钟够宽松）。 */
const STALE_MS = 5 * 60 * 1000;

export async function GET(_request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const conversation = await prisma.conversation.findFirst({
    where: { id: context.params.id, userId: user.id },
    select: { id: true }
  });
  if (!conversation) return jsonError("对话不存在。", 404);

  const payload = readVideoProgress(user.id);
  if (!payload) return jsonOk({ running: false });

  // 进度文件是「按用户最新一次」。带了会话归属就只在对应会话里显示，
  // 否则 A 会话的改片进度会串到 B 会话的对话框里。
  if (payload.conversationId && payload.conversationId !== context.params.id) {
    return jsonOk({ running: false });
  }

  // 改片（kind: edit）的进展**不在平台会话里显示** —— 它只在 Studio 顶部状态区展示
  // （见 /api/video-motion/[token]/edit-status，由 Studio 服务端代理读取）。
  // 会话里刷「正在改片 %」会打断对话，用户明确要求挪到 Studio。
  if (payload.kind === "edit") return jsonOk({ running: false });

  const now = Date.now();
  const updatedAt = Date.parse(payload.updatedAt || "");
  if (!Number.isFinite(updatedAt)) return jsonOk({ running: false });
  const startedAt = Date.parse(payload.startedAt || "");

  const stale = now - updatedAt > STALE_MS;
  const running = !payload.terminal && !stale;

  return jsonOk({
    running,
    stale: !payload.terminal && stale,
    kind: payload.kind ?? "generate",
    stage: payload.stage ?? "",
    percent: typeof payload.percent === "number" ? payload.percent : 0,
    message: payload.message ?? "",
    elapsedSeconds: Number.isFinite(startedAt) ? Math.max(0, Math.round((now - startedAt) / 1000)) : null,
    updatedAt: payload.updatedAt
  });
}
