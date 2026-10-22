import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 平台侧发起的微信会话往返（本地归档）。
 *
 * 为什么需要这张表：
 * - 用户在平台「微信会话」面板里继续追问时，那一来一回**不经过微信插件**：
 *   用户消息来自网页表单，AI 回复由平台直调 `ilink/bot/sendmessage` 推回微信。
 * - 微信插件的 `~/.openclaw/openclaw-weixin/ref-messages.sqlite` 只记录**插件自己收发**的消息，
 *   平台直投的消息不会落进去（实测确认）。不另存一份，刷新页面这段对话就消失了。
 *
 * 为什么不复用 Prisma：
 * - 表不在 Prisma schema 里，裸 SQL 建表即可生效，不用 `prisma generate` + 重启 dev server。
 * - 单独放 `data/wechat-turns.sqlite`（已 gitignore），和 Prisma 的 dev.db 完全隔离，
 *   避免和 Prisma 抢同一个 sqlite 文件的写锁。
 */

const TABLE = "wechat_turn";

export type WechatTurnRole = "user" | "assistant";

export type WechatTurn = {
  role: WechatTurnRole;
  body: string;
  createdAt: string;
};

/** 常驻连接（懒建）：轮询每 5 秒读一次，反复开库既慢也容易在并发下抢锁。 */
let cachedDb: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (cachedDb) return cachedDb;
  const dir = join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "wechat-turns.sqlite"));
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
      `id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, ` +
      `role TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_${TABLE}_owner ON ${TABLE}(user_id, conversation_id, created_at)`
  );
  cachedDb = db;
  return db;
}

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  try {
    return fn(db);
  } catch (error) {
    // 连接可能因文件被移动/HMR 失效：丢弃缓存，下次重连再试。
    try {
      cachedDb?.close();
    } catch {
      /* ignore */
    }
    cachedDb = null;
    throw error;
  }
}

/** 追加一条往返消息；正文为空时直接跳过（微信不允许发空消息）。 */
export function appendTurn(input: {
  userId: string;
  conversationId: string;
  role: WechatTurnRole;
  body: string;
  createdAt?: Date;
}): WechatTurn | null {
  const body = (input.body || "").trim();
  if (!body) return null;
  const createdAt = (input.createdAt ?? new Date()).toISOString();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    withDb((db) => {
      db.prepare(
        `INSERT INTO ${TABLE} (id, user_id, conversation_id, role, body, created_at) VALUES (?,?,?,?,?,?)`
      ).run(id, input.userId, input.conversationId, input.role, body, createdAt);
    });
    return { role: input.role, body, createdAt };
  } catch (error) {
    console.error("[wechat-turn] 写入失败：", error);
    return null;
  }
}

/** 按时间升序取出该用户在该微信会话下的平台侧往返。 */
export function listTurns(
  userId: string,
  conversationId: string,
  limit = 1000
): WechatTurn[] {
  try {
    return withDb((db) => {
      const rows = db
        .prepare(
          `SELECT role, body, created_at FROM ${TABLE} ` +
            `WHERE user_id = ? AND conversation_id = ? ORDER BY created_at ASC LIMIT ?`
        )
        .all(userId, conversationId, limit) as Array<{
        role: string;
        body: string;
        created_at: string;
      }>;
      return rows.map((row) => ({
        role: row.role === "assistant" ? ("assistant" as const) : ("user" as const),
        body: row.body,
        createdAt: row.created_at
      }));
    });
  } catch (error) {
    console.error("[wechat-turn] 读取失败：", error);
    return [];
  }
}
