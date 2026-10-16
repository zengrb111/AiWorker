import { jsonError, jsonOk, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { invalidateUserCache } from "@/lib/model-credentials";

type SwitchBody = { model?: string; providerRowId?: string };

/**
 * POST /api/models/switch — 切换「对话与写作」使用的模型。
 *
 * 写的是当前用户自己的 UserModelAssignment(capability="chat")，落库即生效，
 * 不再触碰网关的全局会话模型（那会让所有用户共用同一个模型选择）。
 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const body = await readJson<SwitchBody>(request);
  const model = body.model?.trim();
  const providerRowId = body.providerRowId?.trim();
  if (!model || !providerRowId) {
    return jsonError("缺少模型 id 或模型服务。");
  }

  // 严格按 userId 定位，杜绝改到别人的服务上。
  const provider = await prisma.userModelProvider.findFirst({
    where: { id: providerRowId, userId: user.id }
  });
  if (!provider) {
    return jsonError("该模型服务不存在或不属于当前用户。", 404);
  }

  const saved = await prisma.userModelAssignment.upsert({
    where: { userId_capability: { userId: user.id, capability: "chat" } },
    update: { providerRowId, model },
    create: { userId: user.id, capability: "chat", providerRowId, model }
  });
  invalidateUserCache(user.id);

  return jsonOk({
    current: {
      model: saved.model,
      provider: provider.label,
      providerId: provider.providerId,
      providerRowId: provider.id,
      available: provider.status !== "invalid"
    }
  });
}
