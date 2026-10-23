import { jsonError, jsonOk } from "@/lib/http";
import { readSessionUserId } from "@/lib/session";
import { healWeixinChannels } from "@/lib/weixin-self-heal";

/**
 * 微信通道自愈入口。
 *
 * POST：
 *  - 平台启动时由 instrumentation 用内部令牌自动调用（保证重启后自动恢复）；
 *  - 运维/用户也可在「网关单独重启、微信显示暂无法连接」时手动触发一次。
 *
 * 鉴权：登录用户 或 内部令牌（SCHEDULE_API_TOKEN / CONTENT_INGEST_TOKEN）。
 */
function isInternal(request: Request): boolean {
  const expected = (process.env.SCHEDULE_API_TOKEN || process.env.CONTENT_INGEST_TOKEN || "").trim();
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${expected}`;
}

export async function POST(request: Request) {
  try {
    const userId = readSessionUserId();
    if (!userId && !isInternal(request)) return jsonError("未登录。", 401);
    const result = await healWeixinChannels();
    return jsonOk(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "微信通道自愈失败。", 500);
  }
}
