import { cosineSimilarity, embedOne, localEmbed, parseEmbedding } from "./kb-embed";

export type RetrievalChunkInput = {
  id: string;
  content: string;
  embedding: string | null;
  documentId: string;
  knowledgeBaseId: string;
  seq: number;
};

export type ScoredChunk = {
  chunk: RetrievalChunkInput;
  score: number;
};

/**
 * 对候选切片做相似度打分。
 *
 * 向量空间一致性策略：
 * - 若所有候选切片都存有与查询向量同维度的向量 → 直接用存量向量；
 * - 否则整体回退到本地哈希向量（查询与切片同一空间重算），保证打分可比。
 */
export async function scoreChunks(
  query: string,
  chunks: RetrievalChunkInput[],
  model: string
): Promise<{ hits: ScoredChunk[]; space: "stored" | "local"; model: string }> {
  if (chunks.length === 0) return { hits: [], space: "local", model };

  const { vector: queryVector, model: usedModel } = await embedOne(query, model);
  const stored = chunks.map((chunk) => parseEmbedding(chunk.embedding));

  const allStoredMatch = stored.every((vec) => vec !== null && vec.length === queryVector.length);

  if (allStoredMatch) {
    return {
      hits: chunks
        .map((chunk, index) => ({ chunk, score: cosineSimilarity(queryVector, stored[index] as number[]) }))
        .sort((a, b) => b.score - a.score),
      space: "stored",
      model: usedModel
    };
  }

  const localQuery = localEmbed(query);
  return {
    hits: chunks
      .map((chunk) => ({ chunk, score: cosineSimilarity(localQuery, localEmbed(chunk.content)) }))
      .sort((a, b) => b.score - a.score),
    space: "local",
    model: "local-hash-256"
  };
}

/** 在召回片段中高亮命中关键词（供前端展示，返回纯文本标记） */
export function highlightTerms(query: string): string[] {
  const cleaned = query.replace(/[，。！？、,.!?；;：:（）()\[\]【】"'`]/g, " ");
  const terms = cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  return Array.from(new Set(terms)).slice(0, 8);
}
