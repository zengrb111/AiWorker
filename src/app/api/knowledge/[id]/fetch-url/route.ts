import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { fetchWebPage } from "@/lib/fetch-web-page";
import { chunkText, normalizeChunkOptions } from "@/lib/knowledge";
import { recomputeKnowledgeBaseStatus } from "@/lib/kb-store";

export const runtime = "nodejs";

type FetchUrlBody = { url?: string };

/** POST /api/knowledge/[id]/fetch-url — 获取网页正文并切片入库 */
export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const knowledgeBase = await prisma.knowledgeBase.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!knowledgeBase) return jsonError("知识库不存在。", 404);

  const body = await readJson<FetchUrlBody>(request);
  const rawUrl = (body.url || "").trim();
  if (!rawUrl) return jsonError("请填写网页链接。");

  // 抓取与正文提取已抽到 fetchWebPage（文章转视频共用）。这里传 allowPrivateHosts
  // 保持知识库的历史行为 —— 它本来就能抓内网知识页面。
  let page;
  try {
    page = await fetchWebPage(rawUrl, { allowPrivateHosts: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "获取网页失败。");
  }

  const title = page.title;
  const text = page.text;

  const document = await prisma.kbDocument.create({
    data: {
      knowledgeBaseId: knowledgeBase.id,
      filename: title.slice(0, 180),
      mimeType: "text/html",
      kind: "url",
      sizeBytes: Buffer.byteLength(text, "utf8"),
      storedPath: page.url,
      parseStatus: text ? "PARSED" : "EMPTY",
      parseNote: text ? `已获取网页正文（${text.length} 字）` : "未提取到正文内容",
      extractedText: text
    }
  });

  let chunkCount = 0;
  if (text) {
    const options = normalizeChunkOptions({
      strategy: (knowledgeBase.chunkStrategy as "semantic" | "fixed") || "semantic",
      size: knowledgeBase.chunkSize || undefined,
      overlap: knowledgeBase.chunkOverlap || undefined
    });
    const pieces = chunkText(text, options);
    let seq = 0;
    for (const piece of pieces) {
      await prisma.kbChunk.create({
        data: {
          knowledgeBaseId: knowledgeBase.id,
          documentId: document.id,
          seq: ++seq,
          content: piece,
          charCount: piece.length,
          enabled: true
        }
      });
    }
    chunkCount = pieces.length;
    await prisma.kbDocument.update({
      where: { id: document.id },
      data: { chunkCount: pieces.length }
    });
  }

  await recomputeKnowledgeBaseStatus(knowledgeBase.id);

  return jsonOk({
    document: {
      id: document.id,
      filename: document.filename,
      kind: document.kind,
      sizeBytes: document.sizeBytes,
      parseStatus: document.parseStatus,
      parseNote: document.parseNote,
      chunkCount: document.chunkCount,
      createdAt: document.createdAt.toISOString()
    },
    chunkCount
  });
}
