import { jsonError, jsonOk } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { invalidateUserCache } from "@/lib/model-credentials";

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

  const [, released] = await prisma.$transaction([
    prisma.userModelProvider.delete({ where: { id: provider.id } }),
    prisma.userModelAssignment.deleteMany({
      where: { userId: user.id, providerRowId: provider.id }
    })
  ]);
  invalidateUserCache(user.id);

  return jsonOk({ id: provider.id, releasedAssignments: released.count });
}
