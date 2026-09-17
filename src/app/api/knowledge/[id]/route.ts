import { rm, unlink } from "node:fs/promises";
import path from "node:path";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { MAX_CHUNK_SIZE, MIN_CHUNK_SIZE } from "@/lib/knowledge";
import { KB_UPLOAD_ROOT } from "@/lib/kb-store";

type UpdateBody = {
  name?: string;
  description?: string;
  vectorModel?: string;
  chunkStrategy?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  visibility?: string;
  topK?: number;
};

async function loadOwned(id: string, userId: string) {
  return prisma.knowledgeBase.findFirst({ where: { id, userId } });
}

/** GET /api/knowledge/[id] — 知识库详情（含文档与切片统计） */
export async function GET(_request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const knowledgeBase = await loadOwned(context.params.id, user.id);
  if (!knowledgeBase) return jsonError("知识库不存在。", 404);

  const [documents, chunkTotal, chunkTrained, chunkEnabled, sampleChunks] = await Promise.all([
    prisma.kbDocument.findMany({
      where: { knowledgeBaseId: knowledgeBase.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        kind: true,
        sizeBytes: true,
        parseStatus: true,
        parseNote: true,
        chunkCount: true,
        createdAt: true
      }
    }),
    prisma.kbChunk.count({ where: { knowledgeBaseId: knowledgeBase.id } }),
    prisma.kbChunk.count({ where: { knowledgeBaseId: knowledgeBase.id, embedding: { not: null } } }),
    prisma.kbChunk.count({ where: { knowledgeBaseId: knowledgeBase.id, enabled: true } }),
    prisma.kbChunk.findMany({
      where: { knowledgeBaseId: knowledgeBase.id },
      orderBy: [{ documentId: "asc" }, { seq: "asc" }],
      take: 12,
      select: { id: true, documentId: true, seq: true, content: true, charCount: true, enabled: true, embedding: true }
    })
  ]);

  return jsonOk({
    knowledgeBase: {
      ...knowledgeBase,
      createdAt: knowledgeBase.createdAt.toISOString(),
      updatedAt: knowledgeBase.updatedAt.toISOString()
    },
    documents: documents.map((doc) => ({ ...doc, createdAt: doc.createdAt.toISOString() })),
    stats: { chunkTotal, chunkTrained, chunkEnabled },
    sampleChunks: sampleChunks.map((chunk) => ({
      id: chunk.id,
      documentId: chunk.documentId,
      seq: chunk.seq,
      content: chunk.content,
      charCount: chunk.charCount,
      enabled: chunk.enabled,
      trained: Boolean(chunk.embedding)
    }))
  });
}

/** PATCH /api/knowledge/[id] — 更新基本信息 / 切片参数 */
export async function PATCH(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const existing = await loadOwned(context.params.id, user.id);
  if (!existing) return jsonError("知识库不存在。", 404);

  const body = await readJson<UpdateBody>(request);
  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return jsonError("知识库名称不能为空。");
    if (name.length > 60) return jsonError("知识库名称不超过 60 个字符。");
    data.name = name;
  }
  if (body.description !== undefined) data.description = body.description.trim();
  if (body.vectorModel !== undefined) data.vectorModel = body.vectorModel.trim() || existing.vectorModel;
  if (body.chunkStrategy !== undefined) data.chunkStrategy = body.chunkStrategy === "fixed" ? "fixed" : "semantic";
  if (body.visibility !== undefined) data.visibility = body.visibility === "team" ? "team" : "private";
  if (body.topK !== undefined) data.topK = Math.min(20, Math.max(1, Math.round(body.topK)));

  if (body.chunkSize !== undefined || body.chunkOverlap !== undefined) {
    const chunkSize = Math.min(
      MAX_CHUNK_SIZE,
      Math.max(MIN_CHUNK_SIZE, Math.round(body.chunkSize ?? existing.chunkSize))
    );
    data.chunkSize = chunkSize;
    data.chunkOverlap = Math.min(
      Math.floor(chunkSize / 2),
      Math.max(0, Math.round(body.chunkOverlap ?? existing.chunkOverlap))
    );
  }

  const knowledgeBase = await prisma.knowledgeBase.update({ where: { id: existing.id }, data });
  return jsonOk({
    knowledgeBase: {
      ...knowledgeBase,
      createdAt: knowledgeBase.createdAt.toISOString(),
      updatedAt: knowledgeBase.updatedAt.toISOString()
    }
  });
}

/** DELETE /api/knowledge/[id] — 删除知识库（级联删除文档与切片） */
export async function DELETE(_request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const existing = await loadOwned(context.params.id, user.id);
  if (!existing) return jsonError("知识库不存在。", 404);

  const documents = await prisma.kbDocument.findMany({
    where: { knowledgeBaseId: existing.id },
    select: { storedPath: true }
  });

  await prisma.knowledgeBase.delete({ where: { id: existing.id } });

  // 清理磁盘上的上传文件与目录（DB 级联删除文档与切片）
  await Promise.all(
    documents
      .filter((doc) => doc.storedPath)
      .map((doc) => unlink(path.join(process.cwd(), doc.storedPath)).catch(() => undefined))
  );
  await rm(path.join(KB_UPLOAD_ROOT, existing.id), { recursive: true, force: true }).catch(() => undefined);

  return jsonOk({ deleted: true });
}
