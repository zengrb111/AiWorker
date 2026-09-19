import { readFile } from "fs/promises";
import path from "path";
import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

/**
 * GET /api/content/[id]/image — 返回封面图片二进制。
 * - 本地封面（/uploads/...）：直接从 public 目录读取（fetch 不支持相对路径）。
 * - 远程封面（pollinations 等）：服务端代理抓取，绕过浏览器 CORS。
 */
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

  // 1) 本地封面文件：直接读磁盘
  if (imageUrl.startsWith("/")) {
    const relative = path.normalize(imageUrl).replace(/^[/\\]+/, "");
    if (!relative.startsWith("uploads")) {
      return jsonError("图片路径非法。", 400);
    }
    const filePath = path.join(process.cwd(), "public", relative);
    try {
      const buffer = await readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      return new Response(new Uint8Array(buffer), {
        headers: {
          "Content-Type": MIME_BY_EXT[ext] ?? "application/octet-stream",
          "Cache-Control": "public, max-age=300, s-maxage=600",
        },
      });
    } catch {
      return jsonError("封面文件不存在，请重新生成。", 404);
    }
  }

  // 2) 远程封面：代理抓取
  let imageResponse: Response;
  try {
    imageResponse = await fetch(imageUrl, {
      signal: AbortSignal.timeout(20_000),
    });
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
