/**
 * Wiki 知识点：列表 / 提炼。
 *
 * POST 会真的调一次大模型（10~60 秒），所以 maxDuration 放大到 300s；
 * 前端按钮要显示"正在提炼…"，不能像普通接口那样秒回。
 */
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { extractPointsFromDocument } from "@/lib/kb-wiki";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function loadOwned(id: string, userId: string) {
  return prisma.knowledgeBase.findFirst({ where: { id, userId }, select: { id: true, name: true, kind: true } });
}

/** GET /api/knowledge/[id]/points — 知识点列表 */
export async function GET(_request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const base = await loadOwned(context.params.id, user.id);
  if (!base) return jsonError("知识库不存在。", 404);

  const points = await prisma.kbKnowledgePoint.findMany({
    where: { knowledgeBaseId: base.id },
    orderBy: [{ seq: "asc" }, { createdAt: "asc" }],
    include: { document: { select: { id: true, filename: true } } }
  });

  return jsonOk({
    knowledgeBase: base,
    points: points.map((point) => ({
      id: point.id,
      documentId: point.documentId,
      documentName: point.document?.filename ?? "",
      seq: point.seq,
      title: point.title,
      explanation: point.explanation,
      sourceExcerpt: point.sourceExcerpt,
      videoSeconds: point.videoSeconds,
      createdAt: point.createdAt.toISOString(),
      updatedAt: point.updatedAt.toISOString()
    }))
  });
}

/**
 * POST /api/knowledge/[id]/points — 提炼知识点
 *
 * body: { documentId?: string }
 * 给 documentId 就处理那一篇；不给就处理该库下**所有**已解析文档（逐篇串行，避免打爆模型限流）。
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const base = await loadOwned(context.params.id, user.id);
  if (!base) return jsonError("知识库不存在。", 404);

  const body = await readJson<{ documentId?: string }>(request).catch(() => null);
  const documentId = (body?.documentId || "").trim();

  const docs = await prisma.kbDocument.findMany({
    where: {
      knowledgeBaseId: base.id,
      ...(documentId ? { id: documentId } : {})
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, filename: true }
  });
  if (!docs.length) return jsonError("这个库里还没有文档，先上传图文文档再提炼。", 400);

  const notes: string[] = [];
  const failures: string[] = [];
  for (const doc of docs) {
    try {
      const result = await extractPointsFromDocument({
        userId: user.id,
        knowledgeBaseId: base.id,
        documentId: doc.id
      });
      notes.push(result.note);
    } catch (error) {
      failures.push(`《${doc.filename}》：${error instanceof Error ? error.message : "提炼失败"}`);
    }
  }

  const total = await prisma.kbKnowledgePoint.count({ where: { knowledgeBaseId: base.id } });
  if (!notes.length) {
    return jsonError(failures.join("；") || "提炼失败。", 500);
  }
  return jsonOk({
    total,
    notes,
    failures,
    message: `${notes.join(" ")}${failures.length ? ` 失败 ${failures.length} 篇：${failures.join("；")}` : ""}`
  });
}
