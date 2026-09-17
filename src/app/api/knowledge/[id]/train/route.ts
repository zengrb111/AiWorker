import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { embedTexts } from "@/lib/kb-embed";
import { recomputeKnowledgeBaseStatus } from "@/lib/kb-store";

export const runtime = "nodejs";
export const maxDuration = 300;

/** POST /api/knowledge/[id]/train — 对全部启用切片做向量化训练 */
export async function POST(_request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const knowledgeBase = await prisma.knowledgeBase.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!knowledgeBase) return jsonError("知识库不存在。", 404);

  const chunks = await prisma.kbChunk.findMany({
    where: { knowledgeBaseId: knowledgeBase.id, enabled: true },
    orderBy: [{ documentId: "asc" }, { seq: "asc" }],
    select: { id: true, content: true }
  });
  if (chunks.length === 0) return jsonError("没有可训练的切片，请先完成切片步骤。");

  await prisma.knowledgeBase.update({ where: { id: knowledgeBase.id }, data: { status: "TRAINING" } });

  const startedAt = Date.now();
  try {
    const { vectors, model, remote } = await embedTexts(
      chunks.map((chunk) => chunk.content),
      knowledgeBase.vectorModel
    );

    const now = new Date();
    const operations = chunks.map((chunk, index) =>
      prisma.kbChunk.update({
        where: { id: chunk.id },
        data: { embedding: JSON.stringify(vectors[index]), trainedAt: now }
      })
    );
    for (let i = 0; i < operations.length; i += 50) {
      await prisma.$transaction(operations.slice(i, i + 50));
    }
    if (model !== knowledgeBase.vectorModel) {
      await prisma.knowledgeBase.update({ where: { id: knowledgeBase.id }, data: { vectorModel: model } });
    }

    const status = await recomputeKnowledgeBaseStatus(knowledgeBase.id);
    return jsonOk({
      chunkCount: chunks.length,
      dimension: vectors[0]?.length ?? 0,
      model,
      remote,
      durationMs: Date.now() - startedAt,
      status
    });
  } catch (error) {
    await recomputeKnowledgeBaseStatus(knowledgeBase.id);
    return jsonError(error instanceof Error ? error.message : "训练失败。", 500);
  }
}
