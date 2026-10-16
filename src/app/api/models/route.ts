import { jsonError, jsonOk } from "@/lib/http";
import { classifyGatewayError, friendlyGatewayError, openClawClient } from "@/lib/openclaw";
import { requireUser } from "@/lib/session";

/** GET /api/models — 当前会话模型 + 网关已配置的模型列表。 */
export async function GET() {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  try {
    let [current, models] = await Promise.all([
      openClawClient.getCurrentModel(user.id),
      openClawClient.listModels(user.id)
    ]);

    // 自愈：若该会话当前模型在网关侧不可用（如 provider 余额耗尽 / 被配额挂起），
    // 自动切到第一个可用模型，避免用户发消息后一直「思考中」直到超时。
    if (current && models.length > 0) {
      const cur = models.find(
        (m) => m.id === current!.model || m.id === `${current!.provider}/${current!.model}`
      );
      if (cur && cur.available === false) {
        const fallback = models.find((m) => m.available !== false);
        if (fallback) {
          try {
            await openClawClient.switchModel(fallback.id, user.id);
            current = await openClawClient.getCurrentModel(user.id);
          } catch {
            // 自愈失败不阻断返回，用户仍可在选择器里手动切换。
          }
        }
      }
    }

    return jsonOk({ current, models });
  } catch (error) {
    // 此前这里把原始 message 直接抛给界面，于是出现过
    // 「OpenClaw Gateway 连接失败：」这种冒号后为空的文案。
    // 现在走诊断层：转成可读中文，并附上 kind 便于前端后续按类型展示。
    const diagnosis = classifyGatewayError(error);
    if (process.env.NODE_ENV !== "production") {
      console.error(`[api/models] 网关不可用 kind=${diagnosis.kind} ${diagnosis.detail}`);
    }
    return jsonError(friendlyGatewayError(error), 502, { kind: diagnosis.kind });
  }
}
