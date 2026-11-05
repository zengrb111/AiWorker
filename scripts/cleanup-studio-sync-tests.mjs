/**
 * 清理本轮 Studio 同步排查产生的测试数据。
 * 保留 myvideo（完整版本链 v1-v4，可用来验证「去 Studio 修改」+「同步到内容库」）。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const db = new DatabaseSync("prisma/dev.db");
const KEEP_TOKENS = new Set(["myvideo"]);
const DROP_TITLES = [
  "Studio入口测试-13321118307",
  "Studio入口测试-13800138001",
  "自动识别测试-只传projectDir",
];

let removedItems = 0;
let removedFiles = 0;

for (const title of DROP_TITLES) {
  const rows = db.prepare("SELECT id, videoUrl, coverImageUrl FROM ContentItem WHERE title = ?").all(title);
  for (const row of rows) {
    for (const url of [row.videoUrl, row.coverImageUrl]) {
      if (!url || !url.startsWith("/")) continue;
      const abs = join(process.cwd(), "public", url.replace(/^\//, ""));
      if (existsSync(abs)) {
        try {
          unlinkSync(abs);
          removedFiles++;
        } catch {
          /* ignore */
        }
      }
    }
    db.prepare("DELETE FROM ContentItem WHERE id = ?").run(row.id);
    removedItems++;
  }
}

const projects = db.prepare("SELECT id, token, videoUrl, versionsJson FROM VideoMotionProject").all();
for (const project of projects) {
  if (KEEP_TOKENS.has(project.token)) continue;
  // 只清本轮造的测试项目：token 是时间戳随机串或 legacy-0001
  const isTest = project.token === "legacy-0001" || /^\d{13}-[0-9a-f]{8}$/.test(project.token);
  if (!isTest) continue;
  try {
    const versions = JSON.parse(project.versionsJson || "[]");
    for (const v of versions) {
      if (!v?.videoUrl?.startsWith("/")) continue;
      const abs = join(process.cwd(), "public", v.videoUrl.replace(/^\//, ""));
      if (existsSync(abs)) {
        unlinkSync(abs);
        removedFiles++;
      }
    }
  } catch {
    /* ignore */
  }
  db.prepare("DELETE FROM VideoMotionProject WHERE id = ?").run(project.id);
}

const leftover = db
  .prepare("SELECT token, videoUrl FROM VideoMotionProject ORDER BY createdAt DESC LIMIT 5")
  .all();
const sample = db.prepare("SELECT title, videoUrl FROM ContentItem WHERE videoUrl LIKE ?").get("%myvideo%");

console.log("删除 ContentItem:", removedItems, "条");
console.log("删除文件:", removedFiles, "个");
console.log("剩余项目（最近 5）:", JSON.stringify(leftover));
console.log("保留样例:", JSON.stringify(sample));
