import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

function requireGatewayToken() {
  const token = process.env.OPENCLAW_API_TOKEN?.trim();
  if (!token) {
    throw new Error("OpenClaw Gateway token 未配置。");
  }
  return token;
}

function resolveWsUrl() {
  if (process.env.OPENCLAW_GATEWAY_WS_URL) {
    return process.env.OPENCLAW_GATEWAY_WS_URL;
  }

  const baseUrl = process.env.OPENCLAW_BASE_URL;
  if (!baseUrl) {
    throw new Error("OPENCLAW_BASE_URL 未配置。");
  }

  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function GET() {
  try {
    return jsonOk({
      wsUrl: resolveWsUrl(),
      token: requireGatewayToken()
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "读取 OpenClaw Gateway 配置失败。", 500);
  }
}
