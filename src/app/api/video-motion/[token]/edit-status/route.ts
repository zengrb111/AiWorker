/**
 * GET /api/video-motion/[token]/edit-status —— Studio 顶部状态区的「AI 正在改」进展。
 *
 * 为什么要有它：改片（DSH 编辑 + 重新出片）要几分钟到十几分钟，Studio 顶部以前只显示
 * 一句固定的「Agent 正在改：<评论前 18 个字>」，用户看不出到底卡在哪一步。现在把
 * `huashu-inbox-worker` 每一步写进 `data/video-progress/<userId>.json` 的进展读回来，
 * 由 Studio 轮询展示（"正在定位那一帧 → AI 正在改这一处 → 正在重新出片 → 已出片 vN"）。
 *
 * 反过来，平台会话**不再显示**改片进度（`/video-progress` 会过滤 kind=edit）。
 *
 * 鉴权：内部令牌（Studio 服务端代理）或登录用户。
 * 说明：只认 `kind === "edit"` 且 `token` 与路径一致的那条，避免拿到别的项目的进度。
 */
import { jsonError, jsonOk } from "@/lib/http";
import { getAgentToken } from "@/lib/platform-config";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { readVideoProgress } from "@/lib/video/progress-file";

export const dynamic = "force-dynamic";

/** 终态保留这么久就够用户看到"已出片 vN"，过后回到"已保存 · 第 N 版" */
const TERMINAL_GRACE_MS = 90_000;
/** 多久没更新视为卡住（改片 DSH 阶段可能几分钟不出新行） */
const STALE_MS = 8 * 60 * 1000;

function isInternal(request: Request): boolean {
  const expected = getAgentToken();
  if (!expected) return false;
  const header = (request.headers.get("authorization") || "").trim();
  if (header === `Bearer ${expected}`) return true;
  return (request.headers.get("x-platform-token") || "").trim() === expected;
}

export async function GET(request: Request, { params }: { params: { token: string } }) {
  const internal = isInternal(request);
  const user = internal ? null : await requireUser();
  if (!internal && !user) return jsonError("未登录。", 401);

  const project = await prisma.videoMotionProject.findFirst({
    where: internal ? { token: params.token } : { token: params.token, userId: user!.id },
    select: { token: true, userId: true, conversationId: true }
  });
  if (!project) return jsonError("视频项目不存在。", 404);

  const payload = readVideoProgress(project.userId);
  if (!payload || payload.kind !== "edit" || payload.token !== project.token) {
    return jsonOk({ active: false });
  }

  const now = Date.now();
  const updatedAt = Date.parse(payload.updatedAt || "");
  if (!Number.isFinite(updatedAt)) return jsonOk({ active: false });

  // 终态只保留一小段时间，避免"已出片"一直挂在顶部
  if (payload.terminal) {
    return jsonOk({
      active: now - updatedAt < TERMINAL_GRACE_MS,
      terminal: true,
      stage: payload.stage,
      percent: payload.percent,
      message: payload.message
    });
  }

  if (now - updatedAt > STALE_MS) {
    return jsonOk({ active: false, stale: true, message: payload.message });
  }

  const startedAt = Date.parse(payload.startedAt || "");
  return jsonOk({
    active: true,
    terminal: false,
    stage: payload.stage,
    percent: payload.percent,
    message: payload.message,
    elapsedSeconds: Number.isFinite(startedAt) ? Math.max(0, Math.round((now - startedAt) / 1000)) : null
  });
}
