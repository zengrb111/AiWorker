import { jsonError, jsonOk, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { probeProvider } from "@/lib/llm-client";
import { invalidateUserCache } from "@/lib/model-credentials";

/**
 * POST /api/settings/models/test —— 「测试连接」。
 *
 * 用该用户自己保存的凭据发一次最小请求，把结论（可用 / 凭据无效 + 具体原因）
 * 写回 provider 的 status / statusMsg / lastVerifyAt，前端就地展示。
 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const body = await readJson<{ providerRowId?: string; model?: string }>(request);
  const rowId = body.providerRowId?.trim();
  if (!rowId) return jsonError("缺少模型服务 id。");

  const provider = await prisma.userModelProvider.findFirst({
    where: { id: rowId, userId: user.id }
  });
  if (!provider) return jsonError("该模型服务不存在或不属于当前用户。", 404);

  // 传该服务里第一个模型做探测；模型列表为空时让探测逻辑自己兜底。
  let model = body.model?.trim() ?? "";
  if (!model) {
    try {
      const parsed = JSON.parse(provider.modelsJson || "[]") as Array<{ id?: string }>;
      model = parsed.find((item) => item?.id)?.id ?? "";
    } catch {
      model = "";
    }
  }

  const result = await probeProvider(user.id, provider.id, provider.apiFormat, model);
  const verifiedAt = new Date();

  await prisma.userModelProvider.update({
    where: { id: provider.id },
    data: {
      status: result.status,
      statusMsg: result.message.slice(0, 500),
      lastVerifyAt: verifiedAt
    }
  });
  invalidateUserCache(user.id);

  return jsonOk({
    status: result.status,
    message: result.message,
    lastVerifyAt: verifiedAt.toISOString()
  });
}
