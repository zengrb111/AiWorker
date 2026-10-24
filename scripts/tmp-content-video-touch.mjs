/**
 * 详情页同步验证辅助（针对条目 cmvmhtswk000fk1ln6mmekv00）：
 *   node scripts/tmp-content-video-touch.mjs get     -> 打印当前 videoUrl
 *   node scripts/tmp-content-video-touch.mjs fake    -> videoUrl 改成 v99（模拟改片出新版）
 *   node scripts/tmp-content-video-touch.mjs restore -> 恢复原 videoUrl
 */
import { PrismaClient } from "../src/generated/prisma/index.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

process.env.DATABASE_URL ||= "file:D:/OPCProjects/AiWorker/prisma/dev.db";
const prisma = new PrismaClient();
const STATE_FILE = new URL("./tmp-content-video-touch.state.json", import.meta.url);
const cmd = process.argv[2] || "get";

if (cmd === "get") {
  const item = await prisma.contentItem.findUnique({
    where: { id: "cmvmhtswk000fk1ln6mmekv00" },
    select: { id: true, videoUrl: true }
  });
  console.log(JSON.stringify(item));
} else if (cmd === "fake") {
  const item = await prisma.contentItem.findUnique({
    where: { id: "cmvmhtswk000fk1ln6mmekv00" },
    select: { videoUrl: true }
  });
  writeFileSync(STATE_FILE, JSON.stringify({ original: item.videoUrl }));
  const fake = item.videoUrl.replace(/-v\d+\.mp4/, "-v99.mp4");
  await prisma.contentItem.update({ where: { id: "cmvmhtswk000fk1ln6mmekv00" }, data: { videoUrl: fake } });
  console.log("FAKE_SET", fake);
} else if (cmd === "restore") {
  if (!existsSync(STATE_FILE)) { console.log("NO_STATE"); process.exit(1); }
  const { original } = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  await prisma.contentItem.update({ where: { id: "cmvmhtswk000fk1ln6mmekv00" }, data: { videoUrl: original } });
  console.log("RESTORED", original);
}
await prisma.$disconnect();
