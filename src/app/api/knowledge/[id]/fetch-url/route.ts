import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { extractHtmlMainText } from "@/lib/kb-extract";
import { chunkText, normalizeChunkOptions } from "@/lib/knowledge";
import { recomputeKnowledgeBaseStatus } from "@/lib/kb-store";

export const runtime = "nodejs";

const MAX_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;

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

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return jsonError("链接格式不正确，请填写完整的 http(s) 链接。");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return jsonError("仅支持 http / https 链接。");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html = "";
  let status = 0;
  try {
    const res = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      }
    });
    status = res.status;
    if (!res.ok) return jsonError(`网页返回 HTTP ${res.status}，无法获取。`);
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("html") && !contentType.includes("xml")) {
      return jsonError("该链接不是网页内容（需 text/html），请改用文件上传。");
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) return jsonError("网页内容过大（超过 30MB），已跳过。");
    html = buffer.toString("utf8");
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return jsonError(aborted ? "获取网页超时（20 秒）。" : `获取网页失败：${error instanceof Error ? error.message : "网络错误"}`);
  } finally {
    clearTimeout(timer);
  }

  const reading = extractHtmlMainText(html, target.hostname);
  const title = reading.title || target.hostname;
  const text = reading.text;

  const document = await prisma.kbDocument.create({
    data: {
      knowledgeBaseId: knowledgeBase.id,
      filename: title.slice(0, 180),
      mimeType: "text/html",
      kind: "url",
      sizeBytes: Buffer.byteLength(text, "utf8"),
      storedPath: target.toString(),
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
