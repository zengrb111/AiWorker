import { jsonError, jsonOk, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { getAgentToken, setAgentToken } from "@/lib/platform-config";
import { maskSecret } from "@/lib/model-credentials";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

/**
 * GET /api/settings/agent-token —— 读取当前「平台 Agent 令牌」状态（仅掩码 + 是否启用）。
 * 这把令牌是龙虾（OpenClaw agent）回调平台接口的唯一鉴权凭据，配置收编到「系统配置」里，
 * 不再散落在 .env.local 环境变量。
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const token = getAgentToken();
  return jsonOk({
    enabled: Boolean(token),
    masked: maskSecret(token)
  });
}

/**
 * PUT /api/settings/agent-token —— 设置 / 重新生成平台 Agent 令牌。
 *  body: { token?: string }  —— 不传或传空则自动生成 32 位 hex；传则使用传入值。
 * 会同时写入系统配置（DB）并同步镜像文件供龙虾 cat 读取。
 */
export async function PUT(request: Request) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const body = await readJson<{ token?: string }>(request).catch(
    () => ({}) as { token?: string }
  );
  const incoming = (body.token || "").trim();
  const token = incoming || crypto.randomBytes(16).toString("hex"); // 32 位 hex
  if (incoming && incoming.length < 16) {
    return jsonError("令牌长度过短（至少 16 位）。", 400);
  }
  try {
    setAgentToken(token);
  } catch (error) {
    return jsonError(`保存失败：${(error as Error).message}`, 500);
  }
  return jsonOk({
    enabled: true,
    masked: maskSecret(token),
    token // 仅在本次响应回显一次，便于复制；之后不再明文展示
  });
}
