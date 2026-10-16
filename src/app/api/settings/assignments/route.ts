import { jsonError, jsonOk, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { invalidateUserCache, type Capability } from "@/lib/model-credentials";

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

  const assignments = await prisma.userModelAssignment.findMany({ where: { userId: user.id } });
  return jsonOk({
    saved: resolved.length,
    cleared: cleared.length,
    assignments: assignments.map((row) => ({
      capability: row.capability,
      providerRowId: row.providerRowId,
      model: row.model
    }))
  });
}
