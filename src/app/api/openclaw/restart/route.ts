/**
 * POST /api/openclaw/restart —— 重启 OpenClaw 网关（手动 / 内部调用）。
 *
 * 与 /api/openclaw/health（只体检不动手）配套：体检说「端口没人监听」时，
 * 这里负责把它拉起来。会话链路在发送消息遇到 not_running 时也会自动调用同一套逻辑
 * （见 `src/lib/gateway-restart.ts`），所以这个接口主要是给运维/前端按钮留的入口。
 *
 * 鉴权：登录用户 或 平台 Agent 令牌（Bearer）。
 */
import { jsonError, jsonOk } from "@/lib/http";
import { getAgentToken } from "@/lib/platform-config";
import { readSessionUserId } from "@/lib/session";
import { ensureGatewayRunning, probeGatewayPort } from "@/lib/gateway-restart";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isInternal(request: Request): boolean {
  const expected = getAgentToken();
  if (!expected) return false;
  const header = (request.headers.get("authorization") || "").trim();
  return header === `Bearer ${expected}`;
}

export async function POST(request: Request) {
  if (!readSessionUserId() && !isInternal(request)) return jsonError("未登录。", 401);

  try {
    // force：手动点了就一定要重启（即使端口还在听，也可能是进程僵死）
    const outcome = await ensureGatewayRunning({ force: true });
    return jsonOk({ ...outcome, listening: await probeGatewayPort() });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "网关重启失败。", 500);
  }
}

/** GET：只看状态，不动手（前端轮询用）。 */
export async function GET() {
  if (!readSessionUserId()) return jsonError("未登录。", 401);
  return jsonOk({ listening: await probeGatewayPort() });
}
