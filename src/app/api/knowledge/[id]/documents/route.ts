import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { extractDocumentText, kindOf, normalizeWhitespace } from "@/lib/kb-extract";
import { recomputeKnowledgeBaseStatus, saveKnowledgeFile } from "@/lib/kb-store";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 30 * 1024 * 1024;

/** GET /api/knowledge/[id]/documents — 文档列表 */
export async function GET(_request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const knowledgeBase = await prisma.knowledgeBase.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!knowledgeBase) return jsonError("知识库不存在。", 404);

  const documents = await prisma.kbDocument.findMany({
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
  });

  return jsonOk({
    documents: documents.map((doc) => ({ ...doc, createdAt: doc.createdAt.toISOString() }))
  });
}

/** POST /api/knowledge/[id]/documents — 上传文本 / 图片 / 图文文件（multipart） */
export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const knowledgeBase = await prisma.knowledgeBase.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!knowledgeBase) return jsonError("知识库不存在。", 404);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("上传数据解析失败，请重试。");
  }

  const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) return jsonError("请选择要上传的文件。");

  const created: Array<Record<string, unknown>> = [];

  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const filename = file.name || "未命名文件";
    const mimeType = file.type || "";

    if (buffer.byteLength > MAX_FILE_BYTES) {
      created.push({
        id: `too-large-${filename}`,
        filename,
        kind: kindOf(filename),
        sizeBytes: buffer.byteLength,
        parseStatus: "FAILED",
        parseNote: "文件超过 30MB 上限，已跳过",
        chunkCount: 0
      });
      continue;
    }

    const { storedPath } = await saveKnowledgeFile(knowledgeBase.id, filename, buffer);
    const extracted = await extractDocumentText(buffer, filename);

    const document = await prisma.kbDocument.create({
      data: {
        knowledgeBaseId: knowledgeBase.id,
        filename,
        mimeType,
        kind: kindOf(filename),
        sizeBytes: buffer.byteLength,
        storedPath,
        parseStatus: extracted.status,
        parseNote: extracted.note,
        extractedText: normalizeWhitespace(extracted.text),
        chunkCount: 0
      }
    });

    created.push({
      id: document.id,
      filename: document.filename,
      kind: document.kind,
      sizeBytes: document.sizeBytes,
      parseStatus: document.parseStatus,
      parseNote: document.parseNote,
      chunkCount: document.chunkCount,
      createdAt: document.createdAt.toISOString()
    });
  }

  await recomputeKnowledgeBaseStatus(knowledgeBase.id);
  return jsonOk({ documents: created });
}
