import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export async function GET(_request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const contentItem = await prisma.contentItem.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!contentItem) {
    return jsonError("内容不存在。", 404);
  }

  return jsonOk({ contentItem });
}
