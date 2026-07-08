import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

type ContentUpdateBody = {
  title?: string;
  body?: string;
  coverImageUrl?: string | null;
  inlineImagesJson?: string | null;
};

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

/** PATCH /api/content/[id] — update title, body, or images. */
export async function PATCH(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const body = await readJson<ContentUpdateBody>(request);

  const existing = await prisma.contentItem.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!existing) {
    return jsonError("内容不存在。", 404);
  }

  const data: Record<string, unknown> = {};
  if (body.title !== undefined) data.title = body.title.trim() || existing.title;
  if (body.body !== undefined) data.body = body.body;
  if (body.coverImageUrl !== undefined) data.coverImageUrl = body.coverImageUrl;
  if (body.inlineImagesJson !== undefined) data.inlineImagesJson = body.inlineImagesJson;

  const contentItem = await prisma.contentItem.update({
    where: { id: context.params.id },
    data
  });

  return jsonOk({ contentItem });
}
