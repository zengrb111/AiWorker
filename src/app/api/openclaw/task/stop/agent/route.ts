import { NextRequest } from "next/server";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { getAgentToken, isValidAgentToken } from "@/lib/platform-config";
import { resolveOwnerFromBody } from "@/lib/ingest-owner";

export const dynamic = "force-dynamic";

/**
 * POST /api/openclaw/task/stop/agent
 *
 * 供 OpenClaw 里的 agent（龙虾）**主动中止它自己正在运行的任务 / 后台子任务**。
 *
 * 鉴权走 Bearer 平台 Agent 令牌（与 /api/scheduled-jobs/agent 同一套），因为 agent 跑在网关侧、
 * 没有 Web 会话，复刻不了前端「停止」按钮的 requireUser（cookie）鉴权。
 *
 * 与前端按钮的区别：
 *   - 前端 /api/openclaw/task/stop 用 requireUser（当前登录用户），只传 conversationId；
 *   - 本接口用 Bearer 令牌 + body 里的归属字段，显式按账号隔离，可精确 abort 某个 sessionKey / runId。
 *
 * 请求体：
 *   {
 *     userId? | sessionKey? | phone?,   // 归属账号（必填，不接受静默兜底；sessionKey 同时作为 abort 目标）
 *     conversationId?,                  // 停止「某会话」当前活跃 run（与 sessionKey 二选一，缺省则按 sessionKey）
 *     runId?,                           // 精确取消某个 run（视频生成等后台子任务）
 *     sessionKey?                       // 直接给完整会话 key（如 agent:u-<id>:c<conv> 或后台任务的独立 key）
 *   }
 *
 * 安全：归属账号由令牌对应的调用方在 body 显式声明，且显式 sessionKey 必须以 `agent:u-<该账号id>:`
 * 开头，否则 403 —— 用户 A 无法停用户 B 的任务。
 */
function extractToken(request: NextRequest): string {
  const header = request.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return (request.headers.get("x-agent-token") || "").trim();
}

export async function POST(request: NextRequest) {
  const expected = getAgentToken();
  if (!expected) {
    return jsonError(
      "服务端未配置平台 Agent 令牌（系统配置 → 平台 Agent 令牌），该接口未启用。",
      503
    );
  }
  if (!isValidAgentToken(extractToken(request))) {
    return jsonError("令牌无效。", 401);
  }

  const body = await readJson<{
    userId?: string;
    sessionKey?: string;
    phone?: string;
    conversationId?: string;
    runId?: string;
  }>(request);

  // 归属账号必须显式给出（不接受静默兜底，否则会错停到别人账号）。
  const hasOwner = Boolean(
    (body.userId || "").trim() || (body.sessionKey || "").trim() || (body.phone || "").trim()
  );
  if (!hasOwner) {
    return jsonError("缺少归属账号：请传 userId / sessionKey / phone 之一。");
  }
  const owner = await resolveOwnerFromBody(body);
  if (!owner.ok) return jsonError(owner.error, owner.status);
  const user = owner.user;

  const conversationId = (body.conversationId || "").trim();
  const runId = (body.runId || "").trim();
  const explicitSessionKey = (body.sessionKey || "").trim();

  // 显式 sessionKey 必须属于当前归属账号 —— 防跨用户 abort。
  if (explicitSessionKey) {
    const allowedPrefix = `agent:u-${user.id}:`;
    if (!explicitSessionKey.startsWith(allowedPrefix)) {
      return jsonError("无权中止其他用户的任务。", 403);
    }
  }

  const result = await openClawClient.stopTask({
    userId: user.id,
    conversationId: conversationId || undefined,
    sessionKey: explicitSessionKey || undefined,
    runId: runId || undefined
  });

  return jsonOk({
    stopped: result.aborted,
    error: result.error ?? null
  });
}
