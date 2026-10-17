import { jsonError, jsonOk } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { invalidateUserCache } from "@/lib/model-credentials";
import { removeOpenClawAuthProfile } from "@/lib/openclaw-settings-sync";

/**
 * DELETE /api/settings/models/[providerId] —— 删除当前用户自己的某个模型服务。
 *
 * 同时清理引用它的能力分配，避免留下悬空 assignment（否则使用该能力时会报
 * 「所指定的模型服务已被删除」）。
 */
export async function DELETE(
  _request: Request,
  context: { params: { providerId: string } }
) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const rowId = context.params.providerId?.trim();
  if (!rowId) return jsonError("缺少模型服务 id。");

  // 严格按 userId 定位：即使猜到别人的行 id 也删不掉。
  const provider = await prisma.userModelProvider.findFirst({
    where: { id: rowId, userId: user.id }
  });
  if (!provider) return jsonError("该模型服务不存在或不属于当前用户。", 404);

  // 必须在删除**之前**查：下面的 $transaction 会一并清掉引用它的 assignment，
  // 删完再查就永远查不到「它此前是否是 chat」了。
  const wasChat = await prisma.userModelAssignment.findFirst({
    where: { userId: user.id, capability: "chat", providerRowId: provider.id }
  });

  const [, released] = await prisma.$transaction([
    prisma.userModelProvider.delete({ where: { id: provider.id } }),
    prisma.userModelAssignment.deleteMany({
      where: { userId: user.id, providerRowId: provider.id }
    })
  ]);
  invalidateUserCache(user.id);

  // ---- OpenClaw 反向清理（v3）----
  //
  // 删除的服务若正是 chat 用的那个，OpenClaw 侧的 auth profile 也要清掉，
  // 否则会残留一份指向已删服务的凭据，之后用户改配 chat 时可能被旧 profile 干扰。
  // 只在「该服务此前被分配为 chat」时清理；清理失败不影响删除结果。
  let openclawSync: { ok: boolean; reason?: string } | undefined;
  if (wasChat) {
    const outcome = await removeOpenClawAuthProfile(`${provider.providerId}:manual`);
    openclawSync = outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
  }

  return jsonOk({
    id: provider.id,
    releasedAssignments: released.count,
    openclawSync
  });
}
