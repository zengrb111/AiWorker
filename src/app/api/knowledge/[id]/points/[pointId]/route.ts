/**
 * 单个知识点的编辑 / 删除。
 *
 * 编辑是刚需：模型提炼的讲解稿用户几乎总要改两句（换成自己的说法、删掉拗口的词），
 * 改完再拿去生成视频。所以 title / explanation / videoSeconds 都允许逐字段更新。
 */
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type PatchBody = {
  title?: string;
  explanation?: string;
  videoSeconds?: number | null;
};

async function loadOwnedPoint(pointId: string, knowledgeBaseId: string, userId: string) {
  const base = await prisma.knowledgeBase.findFirst({
    where: { id: knowledgeBaseId, userId },
    select: { id: true }
  });
  if (!base) return null;
  return prisma.kbKnowledgePoint.findFirst({ where: { id: pointId, knowledgeBaseId: base.id } });
}

export async function PATCH(
  request: Request,
  context: { params: { id: string; pointId: string } }
) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const point = await loadOwnedPoint(context.params.pointId, context.params.id, user.id);
  if (!point) return jsonError("知识点不存在。", 404);

  const body = await readJson<PatchBody>(request);
  const data: Record<string, unknown> = {};

  if (body?.title !== undefined) {
    const title = body.title.trim();
    if (!title) return jsonError("标题不能为空。");
    data.title = title.slice(0, 60);
  }
  if (body?.explanation !== undefined) {
    data.explanation = body.explanation.trim().slice(0, 4000);
  }
  if (body?.videoSeconds !== undefined) {
    if (body.videoSeconds === null) {
      data.videoSeconds = null;
    } else {
      const seconds = Number(body.videoSeconds);
      if (!Number.isFinite(seconds)) return jsonError("时长必须是数字。");
      data.videoSeconds = Math.min(90, Math.max(10, Math.round(seconds)));
    }
  }
  if (!Object.keys(data).length) return jsonError("没有需要修改的字段。");

  const updated = await prisma.kbKnowledgePoint.update({ where: { id: point.id }, data });
  return jsonOk({
    point: {
      id: updated.id,
      title: updated.title,
      explanation: updated.explanation,
      videoSeconds: updated.videoSeconds,
      updatedAt: updated.updatedAt.toISOString()
    }
  });
}

export async function DELETE(
  _request: Request,
  context: { params: { id: string; pointId: string } }
) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const point = await loadOwnedPoint(context.params.pointId, context.params.id, user.id);
  if (!point) return jsonError("知识点不存在。", 404);

  await prisma.kbKnowledgePoint.delete({ where: { id: point.id } });
  return jsonOk({ deleted: point.id });
}
