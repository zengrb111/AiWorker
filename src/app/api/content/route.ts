import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export async function GET() {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const contentItems = await prisma.contentItem.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" }
  });
  return jsonOk({ contentItems });
}
