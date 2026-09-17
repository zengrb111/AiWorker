import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { prisma } from "./prisma";

export const KB_UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads", "kb");

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "file";
}

export async function saveKnowledgeFile(
  knowledgeBaseId: string,
  originalName: string,
  buffer: Buffer
): Promise<{ storedPath: string; publicPath: string }> {
  const dir = path.join(KB_UPLOAD_ROOT, knowledgeBaseId);
  await mkdir(dir, { recursive: true });

  const safeName = sanitizeFilename(originalName);
  const filename = `${randomUUID()}-${safeName}`;
  await writeFile(path.join(dir, filename), buffer);

  return {
    storedPath: path.posix.join("public/uploads/kb", knowledgeBaseId, filename),
    publicPath: `/uploads/kb/${knowledgeBaseId}/${filename}`
  };
}

/** 依据切片情况重算知识库状态：EMPTY（无切片）/ READY（全部已训练）/ EMPTY（有待训练切片） */
export async function recomputeKnowledgeBaseStatus(knowledgeBaseId: string): Promise<string> {
  const [total, trained] = await Promise.all([
    prisma.kbChunk.count({ where: { knowledgeBaseId, enabled: true } }),
    prisma.kbChunk.count({ where: { knowledgeBaseId, enabled: true, embedding: { not: null } } })
  ]);

  const status = total > 0 && trained === total ? "READY" : "EMPTY";
  await prisma.knowledgeBase.update({ where: { id: knowledgeBaseId }, data: { status } });
  return status;
}
