import { jsonError, jsonOk } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import {
  CAPABILITY_LABELS,
  describeModelConfigError,
  type Capability
} from "@/lib/model-credentials";

/**
 * GET /api/models — 当前用户自己的模型清单 + 「对话与写作」当前默认模型。
 *
 * 数据源改为用户级配置表（原先读 OpenClaw 网关的全局模型列表）：
 * 用户在「系统配置」里配置的服务与密钥只有本人可见、可用。
 */
export async function GET() {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  try {
    const [providers, assignments] = await Promise.all([
      prisma.userModelProvider.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" }
      }),
      prisma.userModelAssignment.findMany({ where: { userId: user.id } })
    ]);

    const capabilityByRow = new Map(assignments.map((row) => [row.providerRowId, row.capability]));

    const models = providers.flatMap((provider) => {
      let modelList: Array<{ id: string; name: string }> = [];
      try {
        const parsed = JSON.parse(provider.modelsJson) as Array<{ id: string; name: string }>;
        if (Array.isArray(parsed)) modelList = parsed;
      } catch {
        modelList = [];
      }
      return modelList
        .filter((model) => model && model.id)
        .map((model) => {
          const capability = capabilityByRow.get(provider.id) as Capability | undefined;
          return {
            id: model.id,
            name: model.name || model.id,
            provider: provider.label,
            providerId: provider.providerId,
            providerRowId: provider.id,
            status: provider.status,
            capability: capability ? CAPABILITY_LABELS[capability] : null
          };
        });
    });

    const chat = assignments.find((row) => row.capability === "chat");
    const chatProvider = chat ? providers.find((p) => p.id === chat.providerRowId) : undefined;
    const current =
      chat && chatProvider
        ? {
            model: chat.model,
            provider: chatProvider.label,
            providerId: chatProvider.providerId,
            providerRowId: chatProvider.id,
            available: chatProvider.status !== "invalid"
          }
        : null;

    return jsonOk({ current, models });
  } catch (error) {
    const described = describeModelConfigError(error);
    if (process.env.NODE_ENV !== "production") {
      console.error(`[api/models] 读取用户模型配置失败 kind=${described.kind} ${described.message}`);
    }
    return jsonError(described.message, 500, { kind: described.kind });
  }
}
