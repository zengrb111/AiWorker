/**
 * 向量化与相似度计算。
 *
 * - 默认使用本地确定性哈希向量（256 维），无需联网，随时可用；
 * - 若配置了远端 embedding 模型（如智谱 embedding-3）且存在 API Key，
 *   则优先走远端；远端失败时自动回退到本地向量，保证训练/检索不中断。
 */

export const LOCAL_MODEL = "local-hash-256";
const LOCAL_DIM = 256;
const REMOTE_BATCH = 16;

export type EmbedResult = {
  vectors: number[][];
  model: string;
  remote: boolean;
};

export const VECTOR_MODEL_OPTIONS = [
  { value: LOCAL_MODEL, label: "本地哈希向量（256 维 · 免联网）" },
  { value: "embedding-3", label: "智谱 embedding-3（2048 维 · 需 API Key）" },
  { value: "embedding-2", label: "智谱 embedding-2（1024 维 · 需 API Key）" }
];

export function isRemoteModel(model: string): boolean {
  return model !== LOCAL_MODEL && /^embedding-/i.test(model.trim());
}

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 本地确定性向量：字符 unigram + bigram 哈希到固定维度后做 L2 归一化。 */
export function localEmbed(text: string): number[] {
  const vector = new Array<number>(LOCAL_DIM).fill(0);
  const normalized = text.replace(/\s+/g, " ").toLowerCase();

  for (let i = 0; i < normalized.length; i++) {
    const unigram = normalized[i];
    if (unigram.trim()) vector[hashToken(unigram) % LOCAL_DIM] += 1;
    if (i + 1 < normalized.length) {
      const bigram = normalized.slice(i, i + 2);
      if (bigram.trim().length > 1) vector[hashToken(bigram) % LOCAL_DIM] += 1.5;
    }
  }

  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
}

/**
 * 取 embedding 用的凭据（只用当前用户自己的）。
 *
 * 改造前这里读 `process.env.KB_EMBED_API_KEY || process.env.DASHSCOPE_API_KEY` ——
 * 平台公共 key，训练与检索都用它，不归属任何用户。2026-10-16 改为
 * `resolveCapabilityConfig(userId, "embedding")`，与这轮隔离改造保持一致。
 *
 * 未配置时返回 null：调用方退回本地哈希向量（本地算法，不需要 key，
 * 也不联网），这是**合理降级**而非静默烧平台额度。
 */
async function resolveEmbedCredential(
  userId: string | undefined,
  model: string,
): Promise<{ baseUrl: string; apiKey: string } | null> {
  if (!userId) return null;
  try {
    const { resolveCapabilityConfig } = await import("./model-credentials");
    const config = await resolveCapabilityConfig(userId, "embedding");
    if (!config.apiKey) return null;
    return { baseUrl: config.baseUrl.replace(/\/+$/, ""), apiKey: config.apiKey };
  } catch {
    // 未配置 / 解密失败 → 交给上层用本地向量，不报错打断训练
    return null;
  }
}

async function remoteEmbedBatch(
  texts: string[],
  model: string,
  credential: { baseUrl: string; apiKey: string },
): Promise<number[][]> {
  const { baseUrl, apiKey } = credential;

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, input: texts })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`embedding 接口返回 ${response.status} ${detail.slice(0, 160)}`);
  }

  const payload = (await response.json()) as { data?: Array<{ embedding: number[] }> };
  const rows = payload.data ?? [];
  if (rows.length !== texts.length) {
    throw new Error(`embedding 返回数量不匹配（期望 ${texts.length}，实际 ${rows.length}）`);
  }
  return rows.map((row) => row.embedding);
}

/** 将一批文本转成向量；未配置 embedding 服务时使用本地向量。 */
export async function embedTexts(
  texts: string[],
  model: string,
  userId?: string,
): Promise<EmbedResult> {
  if (texts.length === 0) return { vectors: [], model, remote: false };

  if (isRemoteModel(model)) {
    const credential = await resolveEmbedCredential(userId, model);
    if (credential) {
      try {
        const vectors: number[][] = [];
        for (let i = 0; i < texts.length; i += REMOTE_BATCH) {
          const batch = texts.slice(i, i + REMOTE_BATCH);
          vectors.push(...(await remoteEmbedBatch(batch, model, credential)));
        }
        return { vectors, model, remote: true };
      } catch {
        // 上游抖动 → 退回本地向量，不阻断知识库训练
      }
    }
  }

  return { vectors: texts.map((text) => localEmbed(text)), model: LOCAL_MODEL, remote: false };
}

export async function embedOne(
  text: string,
  model: string,
  userId?: string,
): Promise<{ vector: number[]; model: string }> {
  const result = await embedTexts([text], model, userId);
  return { vector: result.vectors[0] ?? localEmbed(text), model: result.model };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function parseEmbedding(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "number" ? (parsed as number[]) : null;
  } catch {
    return null;
  }
}
