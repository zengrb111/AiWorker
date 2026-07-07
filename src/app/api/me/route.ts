import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export async function GET() {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const binding = await prisma.wechatBinding.findFirst({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" }
  });

  return jsonOk({
    user: { id: user.id, phone: user.phone },
    wechatBinding: binding
  });
}
