import { jsonError, jsonOk, readJson } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { findPreset } from "@/lib/model-presets";
import { requireUser } from "@/lib/session";

type ProviderBody = {
  providerId?: string;
  baseUrl?: string;
  modelId?: string;
  modelName?: string;
  apiKey?: string;
};

/** POST /api/models/provider — 添加/更新模型供应商并保存 API Key。 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const body = await readJson<ProviderBody>(request);
  const providerId = (body.providerId ?? "").trim();
  const modelId = (body.modelId ?? "").trim();
  const preset = providerId ? findPreset(providerId) : undefined;
  const baseUrl = (body.baseUrl ?? preset?.baseUrl ?? "").trim();
  const apiKey = (body.apiKey ?? "").trim();

  if (!providerId) return jsonError("请选择模型供应商。");
  if (!modelId) return jsonError("请选择或填写模型 id。");
  if (!baseUrl) return jsonError("缺少接口地址（baseUrl）。");

  try {
    await openClawClient.upsertModelProvider({
      providerId,
      baseUrl,
      modelId,
      modelName: body.modelName,
      apiKey: apiKey || undefined
    });

    // 网关一般会在配置变更后热加载，等它识别出新模型再回读（最多重试 3 次）
    let models = await openClawClient.listModels();
    for (let i = 0; i < 3 && !models.some((m) => m.id === modelId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      models = await openClawClient.listModels();
    }

    return jsonOk({
      models,
      registered: models.some((m) => m.id === modelId)
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "添加模型供应商失败。", 502);
  }
}
