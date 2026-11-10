/**
 * 知识库区分 RAG / WIKI + 新增知识点表。
 *
 * 为什么手写 SQL 而不用 `prisma db push`：
 * 本项目用一张裸 SQL 自建的 `PlatformConfig` KV 表存平台 Agent 令牌，
 * 它**故意不在 schema.prisma 里**。`prisma db push` / `migrate diff` 会把
 * 「schema 里没有的表」当成多余对象直接 DROP —— 令牌随之丢失，接口全线 401。
 * 所以结构性变更一律走这个脚本：只 ADD COLUMN / CREATE TABLE，不动既有表。
 *
 * 幂等：列或表已存在就跳过，可以反复跑。
 *
 * 用法：node scripts/migrate-kb-wiki.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

const DB = process.env.DATABASE_FILE || path.join(process.cwd(), "prisma", "dev.db");

if (!existsSync(DB)) {
  console.error(`找不到数据库：${DB}`);
  process.exit(1);
}

const db = new DatabaseSync(DB);

function columns(table) {
  try {
    return db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name);
  } catch {
    return [];
  }
}

function tableExists(table) {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table)
  );
}

function indexExists(name) {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name = ?`).get(name)
  );
}

let changed = 0;

// 1) KnowledgeBase.kind：存量库一律按 RAG 处理（老数据本来就是检索库）
if (!columns("KnowledgeBase").includes("kind")) {
  db.exec(`ALTER TABLE "KnowledgeBase" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'RAG'`);
  console.log("+ KnowledgeBase.kind");
  changed++;
} else {
  console.log("= KnowledgeBase.kind 已存在");
}

if (!indexExists("KnowledgeBase_userId_kind_idx")) {
  db.exec(`CREATE INDEX "KnowledgeBase_userId_kind_idx" ON "KnowledgeBase"("userId", "kind")`);
  console.log("+ index KnowledgeBase_userId_kind_idx");
  changed++;
}

// 2) 知识点表
if (!tableExists("KbKnowledgePoint")) {
  db.exec(`
    CREATE TABLE "KbKnowledgePoint" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "knowledgeBaseId" TEXT NOT NULL,
      "documentId" TEXT,
      "seq" INTEGER NOT NULL DEFAULT 0,
      "title" TEXT NOT NULL,
      "explanation" TEXT NOT NULL DEFAULT '',
      "sourceExcerpt" TEXT NOT NULL DEFAULT '',
      "videoSeconds" INTEGER,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "KbKnowledgePoint_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId")
        REFERENCES "KnowledgeBase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "KbKnowledgePoint_documentId_fkey" FOREIGN KEY ("documentId")
        REFERENCES "KbDocument" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    )
  `);
  console.log("+ table KbKnowledgePoint");
  changed++;
} else {
  console.log("= table KbKnowledgePoint 已存在");
}

if (!indexExists("KbKnowledgePoint_knowledgeBaseId_seq_idx")) {
  db.exec(
    `CREATE INDEX "KbKnowledgePoint_knowledgeBaseId_seq_idx" ON "KbKnowledgePoint"("knowledgeBaseId", "seq")`
  );
  console.log("+ index KbKnowledgePoint_knowledgeBaseId_seq_idx");
  changed++;
}

// 3) 之前那次迁移漏建的索引（schema 里有、库里没有，会让 Prisma 每次 diff 都报差异）
if (!indexExists("ScheduledJob_source_idx") && columns("ScheduledJob").includes("source")) {
  db.exec(`CREATE INDEX "ScheduledJob_source_idx" ON "ScheduledJob"("source")`);
  console.log("+ index ScheduledJob_source_idx");
  changed++;
}

console.log(changed ? `\n完成，${changed} 项变更。` : "\n无需变更。");
db.close();
