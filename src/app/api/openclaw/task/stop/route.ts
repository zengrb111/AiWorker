import { jsonError, jsonOk } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { requireUser } from "@/lib/session";

/**
 * 停止 OpenClaw 网关里正在运行的任务（agent run）—— **前端「停止」按钮专用**。
 *
 * 鉴权走 requireUser（当前登录用户的 Web 会话），平台按当前用户派生隔离会话 key
 * （agent:u-<id>:c<conv>），调用 chat.abort 中止该会话活跃 run。
 *
 * ⚠️ agent（龙虾）自身没有 Web 会话，调不了本接口；龙虾主动停任务走
 * 独立的 `/api/openclaw/task/stop/agent`（Bearer 平台 Agent 令牌鉴权）。
 *
 * 安全：一律以 requireUser 的身份为准，禁止跨用户 abort —— 显式 sessionKey
 * 必须以 `agent:u-<当前userId>:` 开头，否则 403。这样用户 A 无法停用户 B 的任务。
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    if (!user) {
      return jsonError("未登录。", 401);
    }

    const body = await req.json().catch(() => ({}));
    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    const explicitSessionKey =
      typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";

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
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "停止任务失败。", 502);
  }
}
