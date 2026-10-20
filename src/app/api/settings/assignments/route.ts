import { jsonError, jsonOk, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { invalidateUserCache, decryptProviderCredential, type Capability } from "@/lib/model-credentials";
import { syncModelKeyToOpenClaw, syncOpenClawChatModel } from "@/lib/openclaw-settings-sync";

type AssignmentBody = {
  assignments?: Array<{ capability?: string; providerRowId?: string | null; model?: string | null }>;
};

/**
 * PUT /api/settings/assignments —— 批量保存「默认模型分配」。
 *
 * 校验规则：provider 必须属于当前用户，且 model 必须在该服务的模型列表里；
 * 传 null 表示清空该项分配（不落库）。
 */
export async function PUT(request: Request) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const body = await readJson<AssignmentBody>(request);
  const rows = Array.isArray(body.assignments) ? body.assignments : [];
  if (rows.length === 0) return jsonError("没有需要保存的分配。");

  const providers = await prisma.userModelProvider.findMany({ where: { userId: user.id } });
  const providerById = new Map(providers.map((p) => [p.id, p]));

  const resolved: Array<{ capability: string; providerRowId: string; model: string }> = [];
  const cleared: string[] = [];

  for (const row of rows) {
    const capability = (row.capability ?? "").trim();
    if (!capability) continue;

    const providerRowId = row.providerRowId?.trim() || null;
    const model = row.model?.trim() || null;

    if (!providerRowId || !model) {
      cleared.push(capability);
      continue;
    }

    const provider = providerById.get(providerRowId);
    if (!provider) {
      return jsonError("所选模型服务不存在或不属于当前用户。", 400);
    }

    let models: Array<{ id?: string }> = [];
    try {
      models = JSON.parse(provider.modelsJson || "[]") as Array<{ id?: string }>;
    } catch {
      models = [];
    }
    if (models.length > 0 && !models.some((m) => m?.id === model)) {
      return jsonError(`模型「${model}」不在「${provider.label}」的模型列表中。`, 400);
    }

    resolved.push({ capability, providerRowId, model });
  }

  await prisma.$transaction([
    // 先清掉本次提交里显式置空的项
    ...(cleared.length > 0
      ? [
          prisma.userModelAssignment.deleteMany({
            where: { userId: user.id, capability: { in: cleared } }
          })
        ]
      : []),
    // 再逐项 upsert
    ...resolved.map((row) =>
      prisma.userModelAssignment.upsert({
        where: {
          userId_capability: {
            userId: user.id,
            capability: row.capability as Capability
          }
        },
        update: { providerRowId: row.providerRowId, model: row.model },
        create: {
          userId: user.id,
          capability: row.capability,
          providerRowId: row.providerRowId,
          model: row.model
        }
      })
    )
  ]);
  invalidateUserCache(user.id);

  // ---- OpenClaw 同步（v3：只同步主对话模型）----
  //
  // 用户在「默认模型分配」里改 chat 时，OpenClaw 侧的默认模型要跟着变。
  // 同时把该服务的 key 也推一份过去 —— 用户可能刚给一个新服务配了 key
  // 就把它设为 chat，此时 OpenClaw 还没有这个 provider 的凭据。
  // 失败不阻断保存，只在响应里带回原因供界面提示。
  let openclawSync: { ok: boolean; reason?: string } | undefined;
  const chatRow = resolved.find((row) => row.capability === "chat");
  if (chatRow) {
    const provider = providerById.get(chatRow.providerRowId);
    if (provider) {
      const credential = decryptProviderCredential(provider.credentialEnc);
      const profileId = `${provider.providerId}:manual`;
      const keyOutcome = await syncModelKeyToOpenClaw({
        provider: provider.providerId,
        apiKey: credential?.apiKey ?? "",
        profileId
      });
      if (!keyOutcome.ok) {
        openclawSync = { ok: false, reason: keyOutcome.reason };
      } else {
        // defaults 与 agent 级配置**一起**改：agent 级优先级更高，只改 defaults
        // 会导致会话继续用旧模型（见 openclaw-settings-sync 里的实测说明）。
        const modelOutcome = await syncOpenClawChatModel({
          provider: provider.providerId,
          model: chatRow.model,
          profileId
        });
        if (!modelOutcome.ok) openclawSync = { ok: false, reason: modelOutcome.reason };
        else openclawSync = { ok: true };
      }
    }
  }

  const assignments = await prisma.userModelAssignment.findMany({ where: { userId: user.id } });
  return jsonOk({
    saved: resolved.length,
    cleared: cleared.length,
    assignments: assignments.map((row) => ({
      capability: row.capability,
      providerRowId: row.providerRowId,
      model: row.model
    })),
    openclawSync
  });
}
