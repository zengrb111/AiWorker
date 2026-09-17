import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { cosineSimilarity, localEmbed, LOCAL_MODEL } from "@/lib/kb-embed";
import { scoreChunks, type RetrievalChunkInput } from "@/lib/kb-retrieval";

type SearchBody = {
  query?: string;
  mode?: "hybrid" | "vector" | "bm25";
  topK?: number;
  threshold?: number;
  scope?: string; // "all" 或具体知识库 id
};

const MAX_CANDIDATES = 6000;

/** POST /api/knowledge/search — 对当前用户全部（或指定）知识库做检索测试 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const body = await readJson<SearchBody>(request);
  const query = (body.query ?? "").trim();
  if (!query) return jsonError("请输入要检索的问题。");

  const mode = body.mode === "vector" || body.mode === "bm25" ? body.mode : "hybrid";
  const topK = Math.min(20, Math.max(1, Math.round(body.topK ?? 5)));
  const threshold = Math.min(0.99, Math.max(0, body.threshold ?? 0));
  const scope = body.scope && body.scope !== "all" ? body.scope : null;

  const knowledgeBases = await prisma.knowledgeBase.findMany({
    where: { userId: user.id, ...(scope ? { id: scope } : {}) },
    select: { id: true, name: true, vectorModel: true }
  });
  if (knowledgeBases.length === 0) {
    return jsonOk({ hits: [], stats: { took: 0, total: 0, kbCount: 0, topK, scope: scope ?? "all" }, message: "没有可检索的知识库。" });
  }

  const kbNameMap = new Map(knowledgeBases.map((kb) => [kb.id, kb.name]));
  const kbIds = knowledgeBases.map((kb) => kb.id);

  const [rows, docRows] = await Promise.all([
    prisma.kbChunk.findMany({
      where: { knowledgeBaseId: { in: kbIds }, enabled: true },
      orderBy: { createdAt: "asc" },
      take: MAX_CANDIDATES,
      select: { id: true, knowledgeBaseId: true, documentId: true, seq: true, content: true, embedding: true, charCount: true }
    }),
    prisma.kbDocument.findMany({
      where: { knowledgeBaseId: { in: kbIds } },
      select: { id: true, filename: true }
    })
  ]);

  if (rows.length === 0) {
    return jsonOk({
      hits: [],
      stats: { took: Date.now() - startedAt, total: 0, kbCount: knowledgeBases.length, topK, scope: scope ?? "all" },
      message: "知识库中还没有可检索的切片，请先完成切片与训练。"
    });
  }

  const filenameMap = new Map(docRows.map((doc) => [doc.id, doc.filename]));
  const candidates: RetrievalChunkInput[] = rows;

  const models = new Set(knowledgeBases.map((kb) => kb.vectorModel));
  const preferredModel = models.size === 1 ? [...models][0] : LOCAL_MODEL;

  const { hits: vectorHits } = await scoreChunks(
    query,
    candidates,
    mode === "bm25" ? LOCAL_MODEL : preferredModel
  );

  const localQuery = localEmbed(query);
  const localHits = candidates
    .map((chunk) => ({ chunk, score: cosineSimilarity(localQuery, localEmbed(chunk.content)) }))
    .sort((a, b) => b.score - a.score);

  const merged =
    mode === "bm25"
      ? localHits
      : mode === "vector"
        ? vectorHits
        : mergeHybrid(vectorHits, localHits);

  const filtered = merged
    .filter((hit) => hit.score >= threshold)
    .slice(0, topK)
    .map((hit) => ({
      chunkId: hit.chunk.id,
      knowledgeBaseId: hit.chunk.knowledgeBaseId,
      knowledgeBaseName: kbNameMap.get(hit.chunk.knowledgeBaseId) ?? "未知知识库",
      documentId: hit.chunk.documentId,
      filename: filenameMap.get(hit.chunk.documentId) ?? "未知文档",
      seq: hit.chunk.seq,
      content: hit.chunk.content,
      score: Number(hit.score.toFixed(4)),
      enabled: true
    }));

  const scores = filtered.map((hit) => hit.score);
  return jsonOk({
    hits: filtered,
    stats: {
      took: Date.now() - startedAt,
      total: candidates.length,
      matched: filtered.length,
      kbCount: new Set(filtered.map((hit) => hit.knowledgeBaseId)).size,
      max: scores.length ? Math.max(...scores) : 0,
      avg: scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4)) : 0,
      topK,
      scope: scope ?? "all",
      atTopK: filtered.length === topK
    }
  });
}

function mergeHybrid(
  vectorHits: Array<{ chunk: RetrievalChunkInput; score: number }>,
  localHits: Array<{ chunk: RetrievalChunkInput; score: number }>
) {
  const localMap = new Map(localHits.map((hit) => [hit.chunk.id, hit.score]));
  return vectorHits
    .map((hit) => ({
      chunk: hit.chunk,
      score: hit.score * 0.7 + (localMap.get(hit.chunk.id) ?? 0) * 0.3
    }))
    .sort((a, b) => b.score - a.score);
}
