import { jsonError, jsonOk } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { requireUser } from "@/lib/session";

/** GET /api/models — 当前会话模型 + 网关已配置的模型列表。 */
export async function GET() {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  try {
    const [current, models] = await Promise.all([
      openClawClient.getCurrentModel(),
      openClawClient.listModels()
    ]);
    return jsonOk({ current, models });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "读取模型列表失败。", 502);
  }
}
