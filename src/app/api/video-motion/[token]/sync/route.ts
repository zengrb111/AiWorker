/**
 * 手动同步：把视频项目的**当前版本**回写到内容库 / 会话里的视频消息。
 *
 * 为什么是手动：改片是「在工作副本上试」，用户可能连改几版才满意。自动回写会把
 * 已发布的内容库条目和聊天里那条视频一起刷成半成品（2026-10-26 改）。
 *
 * 两个调用方：
 * 1. 平台前端（登录用户）—— 视频面板 / 内容库详情页的「同步修改到…」按钮；
 * 2. huashu Studio（端口 4850）的服务端代理 —— 浏览器直连平台会被跨站 cookie 拦掉
 *    （Studio 走 localhost:4850，平台在 127.0.0.1:3000，属于不同 site），所以由
 *    Studio 服务端用 platform agent token 代发，见 `cli/lib/server.js` 的 /api/sync。
 *
 * body: { targets?: ("content" | "conversation")[] }，默认两个都同步。
 */
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { getAgentToken } from "@/lib/platform-config";
import { readSessionUserId } from "@/lib/session";
import { syncProjectTargets, type SyncTarget } from "@/lib/video/huashu-inbox-worker";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ALLOWED: SyncTarget[] = ["content", "conversation"];

/** 内部令牌（Studio 服务端代理 / 龙虾脚本）。 */
function isInternal(request: Request): boolean {
  const expected = getAgentToken();
  if (!expected) return false;
  const header = (request.headers.get("authorization") || "").trim();
  if (header === `Bearer ${expected}`) return true;
  return (request.headers.get("x-platform-token") || "").trim() === expected;
}

function normalizeTargets(raw: unknown): SyncTarget[] {
  if (!Array.isArray(raw) || raw.length === 0) return ALLOWED;
  const picked = raw.filter((item): item is SyncTarget => ALLOWED.includes(item as SyncTarget));
  return picked.length ? picked : ALLOWED;
}

export async function POST(request: Request, { params }: { params: { token: string } }) {
  const internal = isInternal(request);
  const userId = readSessionUserId();
  if (!internal && !userId) return jsonError("未登录。", 401);

  const body = await readJson<{ targets?: unknown }>(request);
  const targets = normalizeTargets(body?.targets);

  const project = await prisma.videoMotionProject.findFirst({
    where: { token: params.token },
    select: { id: true, userId: true, videoUrl: true }
  });
  if (!project) return jsonError("视频项目不存在。", 404);
  if (!internal && project.userId !== userId) return jsonError("无权操作这个视频。", 403);

  try {
    const result = await syncProjectTargets(params.token, targets, { userId: internal ? undefined : userId ?? undefined });
    return jsonOk({ ...result, targets });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "同步失败。", 500);
  }
}
