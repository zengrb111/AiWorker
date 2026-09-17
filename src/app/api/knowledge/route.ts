import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE
} from "@/lib/knowledge";
import { LOCAL_MODEL } from "@/lib/kb-embed";

type CreateBody = {
  name?: string;
  description?: string;
  vectorModel?: string;
  chunkStrategy?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  visibility?: string;
  topK?: number;
};

/** GET /api/knowledge — 当前用户的知识库列表（含统计） */
export async function GET() {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const items = await prisma.knowledgeBase.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { documents: true, chunks: true } } }
  });

  const trainedRows = await prisma.kbChunk.groupBy({
    by: ["knowledgeBaseId"],
    where: { knowledgeBaseId: { in: items.map((item) => item.id) }, embedding: { not: null } },
    _count: { _all: true }
  });
  const trainedMap = new Map(trainedRows.map((row) => [row.knowledgeBaseId, row._count._all]));

  const knowledgeBases = items.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    vectorModel: item.vectorModel,
    chunkStrategy: item.chunkStrategy,
    chunkSize: item.chunkSize,
    chunkOverlap: item.chunkOverlap,
    visibility: item.visibility,
    topK: item.topK,
    status: item.status,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    documentCount: item._count.documents,
    chunkCount: item._count.chunks,
    trainedCount: trainedMap.get(item.id) ?? 0
  }));

  return jsonOk({ knowledgeBases });
}

/** POST /api/knowledge — 新建知识库 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const body = await readJson<CreateBody>(request);
  const name = (body.name ?? "").trim();
  if (!name) return jsonError("请填写知识库名称。");
  if (name.length > 60) return jsonError("知识库名称不超过 60 个字符。");

  const chunkSize = Math.min(
    MAX_CHUNK_SIZE,
    Math.max(MIN_CHUNK_SIZE, Math.round(body.chunkSize ?? DEFAULT_CHUNK_SIZE))
  );
  const chunkOverlap = Math.min(
    Math.floor(chunkSize / 2),
    Math.max(0, Math.round(body.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP))
  );

  const knowledgeBase = await prisma.knowledgeBase.create({
    data: {
      userId: user.id,
      name,
      description: (body.description ?? "").trim(),
      vectorModel: (body.vectorModel ?? LOCAL_MODEL).trim() || LOCAL_MODEL,
      chunkStrategy: body.chunkStrategy === "fixed" ? "fixed" : "semantic",
      chunkSize,
      chunkOverlap,
      visibility: body.visibility === "team" ? "team" : "private",
      topK: Math.min(20, Math.max(1, Math.round(body.topK ?? 5))),
      status: "EMPTY"
    }
  });

  return jsonOk({ knowledgeBase });
}
