// 一次性迁移：给 ScheduledJob 增加 source 列（AGENT=龙虾经微信创建 / PLATFORM=平台网页端创建）。
// 用裸 node:sqlite 执行，避免 prisma db push 误删裸建的 PlatformConfig KV 表（存平台 Agent 令牌）。
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const db = new DatabaseSync(join(process.cwd(), "prisma", "dev.db"));

const cols = db.prepare("PRAGMA table_info(ScheduledJob)").all().map((r) => r.name);
if (!cols.includes("source")) {
  db.exec(`ALTER TABLE ScheduledJob ADD COLUMN source TEXT NOT NULL DEFAULT 'PLATFORM'`);
  console.log("[migrate] 已新增 source 列（存量行回填 PLATFORM）");
} else {
  console.log("[migrate] source 列已存在，跳过");
}

// 确认 PlatformConfig 完好（不应被触碰）。
const pc = db.prepare("SELECT COUNT(*) AS n FROM PlatformConfig").get();
console.log("[migrate] PlatformConfig 行数 =", pc.n);
const after = db.prepare("PRAGMA table_info(ScheduledJob)").all().map((r) => r.name);
console.log("[migrate] ScheduledJob 列 =", after.join(", "));
