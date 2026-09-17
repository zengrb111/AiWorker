import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/** GET /api/content/[id]/image — proxy the cover image blob (bypasses CORS). */
export async function GET(
  _request: Request,
  context: { params: { id: string } }
) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const contentItem = await prisma.contentItem.findFirst({
    where: { id: context.params.id, userId: user.id },
    select: { coverImageUrl: true },
  });

  if (!contentItem) {
    return jsonError("内容不存在。", 404);
  }

  const imageUrl = contentItem.coverImageUrl;
  if (!imageUrl) {
    return jsonError("暂无封面图片。", 404);
  }

  let imageResponse: Response;
  try {
    imageResponse = await fetch(imageUrl);
  } catch {
    return jsonError("获取图片失败，请稍后重试。", 502);
  }

  if (!imageResponse.ok) {
    return jsonError("获取图片失败，图片服务不可用。", 502);
  }

  const blob = await imageResponse.blob();
  const contentType =
    imageResponse.headers.get("Content-Type") || blob.type || "image/png";

  return new Response(blob, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=300, s-maxage=600",
    },
  });
}
