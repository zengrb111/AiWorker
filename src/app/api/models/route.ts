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
    const [current, models] = await Promise.all([
      openClawClient.getCurrentModel(user.id),
      openClawClient.listModels()
    ]);
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
