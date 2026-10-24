/**
 * POST /api/video-motion/tick —— 触发一轮「Studio 评论自动接单」。
 *
 * 与 scheduler / collectors 同一个模式：instrumentation 只做本机 HTTP 调用，
 * 真正的重逻辑（spawn om / DSH）留在普通服务端路由里，避免 instrumentation
 * 被 edge 运行时编译时引入 node 内置模块导致整站 500。
 *
 * 鉴权：Bearer 平台 Agent 令牌（与 scheduler tick 一致）。
 */
import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/http";
import { getAgentToken, isValidAgentToken } from "@/lib/platform-config";
import { runHuashuInboxTick } from "@/lib/video/huashu-inbox-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

function extractToken(request: NextRequest): string {
  const header = request.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return (request.headers.get("x-schedule-token") || "").trim();
}

async function handle(request: NextRequest) {
  const expected = getAgentToken();
  if (!expected) {
    return jsonError("服务端未配置平台 Agent 令牌（系统配置 → 平台 Agent 令牌），该接口未启用。", 503);
  }
  if (!isValidAgentToken(extractToken(request))) {
    return jsonError("令牌无效。", 401);
  }
  const result = await runHuashuInboxTick();
  return jsonOk(result);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
