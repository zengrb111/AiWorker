/**
 * POST /api/content/[id]/wechat-clipboard
 * 生成「复制到公众号」用的富文本 HTML：内联样式排版 + 图片可达性处理。
 * 只返回 HTML 给前端写剪贴板，不改数据库、不建草稿。
 */
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { buildWechatClipboardHtml } from "@/lib/article/wechat-clipboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const item = await prisma.contentItem.findFirst({
    where: { id: context.params.id, userId: user.id },
    select: { id: true, title: true, body: true, coverImageUrl: true }
  });
  if (!item) return jsonError("内容不存在。", 404);

  const input = await readJson<{ body?: string }>(request);
  const body = typeof input.body === "string" ? input.body : item.body || "";

  try {
    const result = await buildWechatClipboardHtml({
      body,
      title: item.title,
      coverImageUrl: item.coverImageUrl,
      userId: user.id
    });
    return jsonOk(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(`生成剪贴板内容失败：${message}`, 502);
  }
}
