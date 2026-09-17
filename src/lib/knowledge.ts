import { normalizeWhitespace } from "./kb-extract";

export type ChunkStrategy = "semantic" | "fixed";

export type ChunkOptions = {
  strategy: ChunkStrategy;
  size: number;
  overlap: number;
};

export const DEFAULT_CHUNK_SIZE = 600;
export const DEFAULT_CHUNK_OVERLAP = 80;
export const MIN_CHUNK_SIZE = 120;
export const MAX_CHUNK_SIZE = 2000;

export function normalizeChunkOptions(input: Partial<ChunkOptions> | undefined): ChunkOptions {
  const strategy: ChunkStrategy = input?.strategy === "fixed" ? "fixed" : "semantic";
  const size = Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, Math.round(input?.size ?? DEFAULT_CHUNK_SIZE)));
  const overlap = Math.min(Math.floor(size / 2), Math.max(0, Math.round(input?.overlap ?? DEFAULT_CHUNK_OVERLAP)));
  return { strategy, size, overlap };
}

/** 按中英文标点切句 */
export function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[。！？!?；;])|\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

function sliceWithOverlap(text: string, size: number, overlap: number): string[] {
  const step = Math.max(1, size - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    const piece = text.slice(start, start + size).trim();
    if (piece) chunks.push(piece);
    if (start + size >= text.length) break;
  }
  return chunks;
}

function semanticChunk(text: string, size: number, overlap: number): string[] {
  const sentences = splitSentences(text);
  const chunks: string[] = [];
  let buffer = "";

  const flush = (force = false) => {
    const piece = buffer.trim();
    if (piece.length >= Math.min(size, MIN_CHUNK_SIZE) || (force && piece)) {
      chunks.push(piece);
      buffer = overlap > 0 ? piece.slice(-overlap) : "";
    }
  };

  for (const sentence of sentences) {
    // 单句就超长 → 先冲刷缓冲，再对该句做定长切分
    if (sentence.length > size) {
      if (buffer.trim()) {
        chunks.push(buffer.trim());
        buffer = "";
      }
      const pieces = sliceWithOverlap(sentence, size, overlap);
      chunks.push(...pieces);
      buffer = overlap > 0 && pieces.length > 0 ? pieces[pieces.length - 1].slice(-overlap) : "";
      continue;
    }

    if ((buffer + sentence).length > size) {
      flush(true);
    }
    buffer += sentence;
  }

  if (buffer.trim()) chunks.push(buffer.trim());

  return chunks.map((c) => c.trim()).filter((c) => c.length > 0);
}

export function chunkText(rawText: string, options: ChunkOptions): string[] {
  const text = normalizeWhitespace(rawText);
  if (!text) return [];
  if (text.length <= options.size) return [text];

  const chunks =
    options.strategy === "fixed"
      ? sliceWithOverlap(text, options.size, options.overlap)
      : semanticChunk(text, options.size, options.overlap);

  // 去掉切分产生的重复片段，并剔除纯空白
  const seen = new Set<string>();
  const result: string[] = [];
  for (const chunk of chunks) {
    const key = chunk.slice(0, 120);
    if (!chunk.trim() || seen.has(key)) continue;
    seen.add(key);
    result.push(chunk);
  }
  return result;
}

/** 取切片正文的一句话摘要（列表预览用） */
export function chunkSummary(content: string, max = 60): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
