import { jsonError, jsonOk, readJson } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { requireUser } from "@/lib/session";

type SwitchBody = { model?: string };

/** POST /api/models/switch — 切换当前会话使用的模型。 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const body = await readJson<SwitchBody>(request);
  const model = body.model?.trim();
  if (!model) {
    return jsonError("缺少模型 id。");
  }

  try {
    await openClawClient.switchModel(model);
    // 回读一次，确认网关真的切过去了（切换是异步落盘的）
    const current = await openClawClient.getCurrentModel();
    return jsonOk({ current });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "切换模型失败。", 502);
  }
}
