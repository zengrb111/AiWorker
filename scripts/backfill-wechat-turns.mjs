/**
 * 一次性回填：把「已成功送达微信、但没归档到平台会话」的定时任务结果补进
 * data/wechat-turns.sqlite，让平台「微信会话」里能看到这些消息。
 *
 * 判定条件：lastStatus=SUCCEEDED 且 lastResult 末尾含「✅ 微信通知已送达」。
 * 正文去掉末尾的送达标记（那行是平台内部状态，不是发到微信的内容）。
 * 时间用 lastRunAt，与微信侧收到的时刻一致。
 *
 * 用法：node scripts/backfill-wechat-turns.mjs [--apply]
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const ROOT = process.cwd();

const prismaDb = new DatabaseSync(join(ROOT, "prisma", "dev.db"), { readOnly: true });
const storePath = join(ROOT, "data", "wechat-turns.sqlite");
mkdirSync(join(ROOT, "data"), { recursive: true });
const store = new DatabaseSync(storePath);
store.exec(
  `CREATE TABLE IF NOT EXISTS wechat_turn (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ` +
    `conversation_id TEXT NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`
);

const jobs = prismaDb
  .prepare(
    `SELECT j.id, j.userId, j.name, j.lastRunAt, j.lastResult, j.notifyWechat, u.phone
     FROM ScheduledJob j LEFT JOIN User u ON u.id = j.userId
     WHERE j.lastStatus = 'SUCCEEDED' AND j.lastResult LIKE '%✅ 微信通知已送达%'
     ORDER BY j.lastRunAt ASC`
  )
  .all();

console.log(`命中任务：${jobs.length} 条  ${APPLY ? "【实写】" : "【干跑】"}`);

let inserted = 0;
let skipped = 0;

for (const job of jobs) {
  const binding = prismaDb
    .prepare(
      `SELECT wechatNo FROM WechatBinding WHERE userId = ? AND status = 'BOUND'
       ORDER BY boundAt DESC LIMIT 1`
    )
    .get(job.userId);
  const conversationId = (binding?.wechatNo || "").trim();
  if (!conversationId.endsWith("@im.wechat")) {
    console.log(`  跳过 ${job.phone}/${job.name}：没有可用的 BOUND 绑定`);
    skipped++;
    continue;
  }

  const body = String(job.lastResult || "")
    .replace(/\n*✅ 微信通知已送达\s*$/, "")
    .trim();
  if (!body) {
    console.log(`  跳过 ${job.phone}/${job.name}：正文为空`);
    skipped++;
    continue;
  }

  const createdAt = new Date(Number(job.lastRunAt)).toISOString();
  const exists = store
    .prepare(
      `SELECT 1 FROM wechat_turn WHERE user_id = ? AND conversation_id = ? AND role = 'assistant' AND body = ? LIMIT 1`
    )
    .get(job.userId, conversationId, body);
  if (exists) {
    console.log(`  已有 ${job.phone}/${job.name}（${createdAt}），不重复写`);
    skipped++;
    continue;
  }

  console.log(
    `  ${APPLY ? "写入" : "将写入"} ${job.phone}/${job.name} | ${createdAt} | ${body.length} 字 | ${conversationId.slice(0, 18)}…`
  );
  if (APPLY) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    store
      .prepare(`INSERT INTO wechat_turn (id, user_id, conversation_id, role, body, created_at) VALUES (?,?,?,?,?,?)`)
      .run(id, job.userId, conversationId, "assistant", body, createdAt);
    inserted++;
  }
}

console.log(`\n汇总：写入 ${APPLY ? inserted : 0} 条，跳过 ${skipped} 条`);
if (!APPLY) console.log("干跑结束，加 --apply 实写。");

store.close();
prismaDb.close();
