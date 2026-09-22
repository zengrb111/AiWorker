// 把已发布到官网的内容，把完整正文（markdown→纯文本）补回官网 content 字段。
// 已有内容库正文，按 publishRecord.remoteId PATCH /api/recommends/:id。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ROOT = process.cwd();
const envRaw = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
const TOKEN = (envRaw.match(/^HGWX_PUBLISH_TOKEN=(.*)$/m)?.[1] || "").trim().replace(/^"|"$/g, "");
const API = (envRaw.match(/^HGWX_PUBLISH_API=(.*)$/m)?.[1] || "https://hgwx.aimemory.cafe").trim().replace(/^"|"$/g, "").replace(/\/+$/, "");
if (!TOKEN) { console.error("缺少 HGWX_PUBLISH_TOKEN"); process.exit(1); }

function mdToPlainText(md) {
  if (!md) return "";
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*+]\s+/gm, "· ")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const { PrismaClient } = require(path.join(ROOT, "src/generated/prisma"));
const prisma = new PrismaClient();

(async () => {
  const recs = await prisma.publishRecord.findMany({
    where: { channel: "官网好物推荐", status: "SUCCESS" },
    orderBy: { publishedAt: "desc" },
    select: { remoteId: true, contentItemId: true, title: true },
  });

  // 按 remoteId 去重（同一内容可能有多条成功记录）
  const byRemote = new Map();
  for (const r of recs) {
    if (r.remoteId && !byRemote.has(r.remoteId)) byRemote.set(r.remoteId, r);
  }
  console.log(`去重后待补条目: ${byRemote.size}`);

  let ok = 0, fail = 0;
  for (const r of byRemote.values()) {
    const item = await prisma.contentItem.findUnique({ where: { id: r.contentItemId }, select: { body: true, title: true } });
    const content = mdToPlainText(item?.body);
    if (!content) { console.log(`跳过(空正文): ${r.title}`); continue; }
    try {
      const res = await fetch(`${API}/api/recommends/${r.remoteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ content }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) { ok++; console.log(`OK [${content.length}字] ${r.title.slice(0, 24)}`); }
      else { fail++; console.log(`FAIL ${res.status} ${j.error || ""} | ${r.title.slice(0, 24)}`); }
    } catch (e) {
      fail++; console.log(`ERR ${e.message} | ${r.title.slice(0, 24)}`);
    }
  }
  console.log(`完成: ok=${ok} fail=${fail}`);
  await prisma.$disconnect();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
