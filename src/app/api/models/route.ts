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
    return jsonError(error instanceof Error ? error.message : "读取模型列表失败。", 502);
  }
}
