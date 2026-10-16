import { jsonError, jsonOk, readJson } from "@/lib/http";
import { findPreset } from "@/lib/model-presets";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { encodeCredential, invalidateUserCache } from "@/lib/model-credentials";

type ProviderBody = {
  providerId?: string;
  label?: string;
  baseUrl?: string;
  modelId?: string;
  modelName?: string;
  apiKey?: string;
};

/**
 * POST /api/models/provider — 添加/更新**当前用户自己的**模型服务。
 *
 * 旧实现会写 ~/.openclaw/openclaw.json 并把 API Key 明文交给 OpenClaw CLI
 * （全平台共享）。现在改为按 userId 加密落库，其他用户既读不到也用不了。
 */
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
  const label = (body.label ?? preset?.label ?? providerId).trim();

  if (!providerId) return jsonError("请选择模型供应商。");
  if (!modelId) return jsonError("请选择或填写模型 id。");
  if (!baseUrl) return jsonError("缺少接口地址（baseUrl）。");

  const existing = await prisma.userModelProvider.findFirst({
    where: { userId: user.id, providerId, label }
  });

  if (!apiKey && !existing) {
    return jsonError("请填写 API Key。");
  }

  const models = preset?.models.some((m) => m.id === modelId)
    ? preset.models
    : [
        ...(preset?.models ?? []),
        { id: modelId, name: body.modelName?.trim() || modelId }
      ].filter((model, index, list) => list.findIndex((m) => m.id === model.id) === index);

  const data = {
    baseUrl,
    modelsJson: JSON.stringify(models),
    // 换密钥或改地址后，旧的校验结论不再可信，回到「未验证」等待用户点测试。
    status: "untested",
    statusMsg: "",
    lastVerifyAt: null,
    ...(apiKey
      ? { credentialEnc: encodeCredential({ apiKey }) }
      : {})
  };

  const provider = existing
    ? await prisma.userModelProvider.update({ where: { id: existing.id }, data })
    : await prisma.userModelProvider.create({
        data: {
          userId: user.id,
          providerId,
          label,
          apiFormat: "openai-completions",
          baseUrl,
          credentialEnc: encodeCredential({ apiKey }),
          modelsJson: data.modelsJson
        }
      });

  invalidateUserCache(user.id);

  return jsonOk({
    provider: {
      id: provider.id,
      providerId: provider.providerId,
      label: provider.label,
      baseUrl: provider.baseUrl,
      models: models.map((m) => ({ id: m.id, name: m.name }))
    },
    registered: true
  });
}
