import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { chunkSummary, chunkText, normalizeChunkOptions } from "@/lib/knowledge";
import { recomputeKnowledgeBaseStatus } from "@/lib/kb-store";

type ChunkBody = {
  strategy?: string;
  size?: number;
  overlap?: number;
  documentIds?: string[];
};

/** POST /api/knowledge/[id]/chunk — 对已解析文档执行切片（可重复执行，会重建切片） */
export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const knowledgeBase = await prisma.knowledgeBase.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!knowledgeBase) return jsonError("知识库不存在。", 404);

  const body = await readJson<ChunkBody>(request);
  const options = normalizeChunkOptions({
    strategy: body.strategy === "fixed" ? "fixed" : body.strategy === "semantic" ? "semantic" : (knowledgeBase.chunkStrategy as "semantic" | "fixed"),
    size: body.size ?? knowledgeBase.chunkSize,
    overlap: body.overlap ?? knowledgeBase.chunkOverlap
  });

  const where = {
    knowledgeBaseId: knowledgeBase.id,
    ...(body.documentIds && body.documentIds.length > 0 ? { id: { in: body.documentIds } } : {})
  };

  const documents = await prisma.kbDocument.findMany({ where });
  if (documents.length === 0) return jsonError("没有可切片的文档，请先上传文件。");

  await prisma.$transaction([
    prisma.kbChunk.deleteMany({ where: { knowledgeBaseId: knowledgeBase.id, documentId: { in: documents.map((d) => d.id) } } }),
    prisma.knowledgeBase.update({
      where: { id: knowledgeBase.id },
      data: {
        chunkStrategy: options.strategy,
        chunkSize: options.size,
        chunkOverlap: options.overlap
      }
    })
  ]);

  const preview: Array<{ id: string; seq: number; content: string; charCount: number }> = [];
  let totalChunks = 0;

  for (const document of documents) {
    const pieces = chunkText(document.extractedText, options);
    let seq = 0;

    for (const piece of pieces) {
      const chunk = await prisma.kbChunk.create({
        data: {
          knowledgeBaseId: knowledgeBase.id,
          documentId: document.id,
          seq: ++seq,
          content: piece,
          charCount: piece.length,
          enabled: true
        }
      });
      totalChunks++;
      if (preview.length < 12) {
        preview.push({ id: chunk.id, seq: chunk.seq, content: chunkSummary(chunk.content, 120), charCount: chunk.charCount });
      }
    }

    await prisma.kbDocument.update({ where: { id: document.id }, data: { chunkCount: pieces.length } });
  }

  const status = await recomputeKnowledgeBaseStatus(knowledgeBase.id);
  return jsonOk({
    chunkCount: totalChunks,
    documentCount: documents.length,
    preview,
    options,
    status
  });
}
