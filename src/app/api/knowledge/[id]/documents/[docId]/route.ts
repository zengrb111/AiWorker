import { unlink } from "node:fs/promises";
import path from "node:path";
import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { recomputeKnowledgeBaseStatus } from "@/lib/kb-store";

/** DELETE /api/knowledge/[id]/documents/[docId] — 删除文档（连同切片） */
export async function DELETE(_request: Request, context: { params: { id: string; docId: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const knowledgeBase = await prisma.knowledgeBase.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!knowledgeBase) return jsonError("知识库不存在。", 404);

  const document = await prisma.kbDocument.findFirst({
    where: { id: context.params.docId, knowledgeBaseId: knowledgeBase.id }
  });
  if (!document) return jsonError("文档不存在。", 404);

  await prisma.kbDocument.delete({ where: { id: document.id } });

  if (document.storedPath) {
    try {
      await unlink(path.join(process.cwd(), document.storedPath));
    } catch {
      // 文件可能已不存在，忽略
    }
  }

  await recomputeKnowledgeBaseStatus(knowledgeBase.id);
  return jsonOk({ deleted: true });
}
