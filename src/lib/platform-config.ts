import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 平台全局配置（轻量键值表）。
 *
 * 为什么不用 Prisma：
 * - 这是一个极简的全局 KV（目前只装「平台 Agent 令牌」一项），改动频繁且希望「改完立刻对所有
 *   接口生效、不依赖 Prisma generate + 重启 dev server」。直接用 node:sqlite 裸读 dev.db，与
 *   Prisma 共用同一个 SQLite 文件（表不在 Prisma schema 里，裸 SQL 不冲突）。
 *
 * 解决的痛点：之前龙虾（OpenClaw agent）回调平台接口用的 Bearer 令牌是写死在 `.env.local` 的
 * `SCHEDULE_API_TOKEN` / `CONTENT_INGEST_TOKEN` 环境变量。用户希望「龙虾要用的 key 从系统配置里
 * 读」，于是把令牌收编为「系统配置」里的一项，平台所有 agent 接口统一从本模块读取。
 *
 * 令牌同时镜像到 `data/.agent-token` 文件：龙虾的提示词里只需 `cat` 这个固定文件取令牌，比
 * 「grep + cut + tr .env.local」稳得多（模型复抄长随机串必错，已造成过 401）。
 */

const KV_TABLE = "PlatformConfig";
const AGENT_TOKEN_KEY = "agentToken";

/** 常驻连接（懒建）：聊天/入库等热路径每次都会读令牌，反复开库既慢也容易在并发下抢锁。 */
let cachedDb: DatabaseSync | null = null;
let cachedToken: string | null = null;

function getDb(): DatabaseSync {
  if (cachedDb) return cachedDb;
  const file = join(process.cwd(), "prisma", "dev.db");
  const db = new DatabaseSync(file);
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${KV_TABLE} (` +
      `key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT)`
  );
  cachedDb = db;
  return db;
}

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  try {
    return fn(db);
  } catch (error) {
    // 连接可能因外部写坏/HMR 失效：丢弃缓存，下次重连再试一次。
    try {
      cachedDb?.close();
    } catch {
      /* ignore */
    }
    cachedDb = null;
    throw error;
  }
}

function readKv(key: string): string | null {
  try {
    return withDb((db) => {
      const row = db
        .prepare(`SELECT value FROM ${KV_TABLE} WHERE key = ?`)
        .get(key) as { value: string } | null;
      return row?.value ?? null;
    });
  } catch (error) {
    console.error(`[platform-config] 读取 ${key} 失败：`, error);
    return null;
  }
}

function writeKv(key: string, value: string): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO ${KV_TABLE} (key, value, updatedAt) VALUES (?, ?, ?) ` +
        `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`
    ).run(key, value, new Date().toISOString());
  });
}

/** 令牌镜像文件路径（供龙虾 cat 取用）。 */
/** 令牌镜像文件路径（供龙虾 cat 取用）。导出是为了让 AGENTS.md 生成端共用同一路径，避免两处各拼一份。 */
export function agentTokenFilePath(): string {
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, ".agent-token");
}

/** 把令牌同步落到固定文件，供龙虾读取。 */
export function syncAgentTokenFile(token: string): void {
  try {
    writeFileSync(agentTokenFilePath(), token, { mode: 0o600 });
    cachedToken = token;
  } catch (error) {
    console.error("[platform-config] 写入 agent-token 文件失败：", error);
  }
}

/**
 * 取平台 Agent 令牌（龙虾回调平台接口的唯一鉴权凭据）。
 * 优先级：系统配置（DB） > 环境变量(SCHEDULE_API_TOKEN||CONTENT_INGEST_TOKEN) > 令牌文件。
 * 首次调用时会把「DB 或 env 里的现有值」回填到 DB，保证历史部署平滑迁移、token 不丢。
 */
export function getAgentToken(): string {
  const fromDb = readKv(AGENT_TOKEN_KEY);
  if (fromDb) {
    // 确保镜像文件存在且一致（文件可能被删）。
    ensureTokenFile(fromDb);
    return fromDb;
  }
  const fromEnv = (
    process.env.SCHEDULE_API_TOKEN ||
    process.env.CONTENT_INGEST_TOKEN ||
    ""
  ).trim();
  if (fromEnv) {
    // 自动迁移：把历史 env 里的令牌收编进系统配置，并落文件。
    writeKv(AGENT_TOKEN_KEY, fromEnv);
    syncAgentTokenFile(fromEnv);
    return fromEnv;
  }
  // 最后兜底：读文件（文件可能比 env 新，例如用户在系统配置里重设过）。
  try {
    const fromFile = readFileSync(agentTokenFilePath(), "utf8").trim();
    if (fromFile) return fromFile;
  } catch {
    /* 文件不存在 */
  }
  return "";
}

/** 仅确保镜像文件存在/一致，不修改 DB（供运行期读取路径调用）。 */
function ensureTokenFile(token: string): void {
  if (cachedToken === token) return;
  try {
    const p = agentTokenFilePath();
    let current = "";
    try {
      current = readFileSync(p, "utf8").trim();
    } catch {
      /* 不存在 */
    }
    if (current !== token) writeFileSync(p, token, { mode: 0o600 });
    cachedToken = token;
  } catch (error) {
    console.error("[platform-config] 同步 agent-token 文件失败：", error);
  }
}

/** 平台内部内容库令牌（入库/发布/查询等）。目前与 agent 令牌同源，统一从系统配置读取。 */
export function getIngestToken(): string {
  return getAgentToken();
}

/** 读 `.env.local` 里的 SCHEDULE_API_TOKEN / CONTENT_INGEST_TOKEN（OpenClaw 脚本仍从这里取令牌）。 */
function readEnvFileTokens(): string[] {
  const out: string[] = [];
  try {
    const text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const key of ["SCHEDULE_API_TOKEN", "CONTENT_INGEST_TOKEN"]) {
      const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\r\\n]+)"?`, "m"));
      const value = match?.[1]?.trim();
      if (value) out.push(value);
    }
  } catch {
    /* 文件不存在 */
  }
  return out;
}

/**
 * 校验调用方带来的令牌是否有效。
 *
 * 接受三个来源，任一命中即通过：
 * 1. 系统配置（DB）里的 agentToken —— 用户「系统配置 → 平台 Agent 令牌」设置的值，龙虾默认用这个；
 * 2. 环境变量 SCHEDULE_API_TOKEN / CONTENT_INGEST_TOKEN —— 兼容历史部署与 OpenClaw 内容库脚本
 *    （`ingest.mjs`/`publish.mjs` 仍从 .env.local 读 CONTENT_INGEST_TOKEN）；
 * 3. 镜像文件 data/.agent-token —— instrumentation 触发等场景。
 *
 * 这样「在系统配置里重设令牌」不会把正在用旧令牌的脚本/调度器一脚踢下线，链路始终通。
 */
export function isValidAgentToken(presented: string): boolean {
  const value = (presented || "").trim();
  if (!value) return false;
  const candidates = new Set<string>();
  try {
    const db = readKv(AGENT_TOKEN_KEY);
    if (db) candidates.add(db.trim());
  } catch {
    /* ignore */
  }
  const envSchedule = (process.env.SCHEDULE_API_TOKEN || "").trim();
  if (envSchedule) candidates.add(envSchedule);
  const envIngest = (process.env.CONTENT_INGEST_TOKEN || "").trim();
  if (envIngest) candidates.add(envIngest);
  // 还要认 `.env.local` 文件里的值：OpenClaw 的内容库脚本（ingest/publish.mjs）直接读这个文件，
  // 而系统配置里「重新生成令牌」会覆盖进程内 process.env —— 不认文件的话，一重设令牌脚本就 401。
  for (const value of readEnvFileTokens()) {
    if (value) candidates.add(value);
  }
  try {
    const fromFile = readFileSync(agentTokenFilePath(), "utf8").trim();
    if (fromFile) candidates.add(fromFile);
  } catch {
    /* ignore */
  }
  return candidates.has(value);
}

/**
 * 设置平台 Agent 令牌（系统配置 UI 保存时调用）。
 * 传入空串 -> 删除（接口停用）。写入后同步镜像文件。
 */
export function setAgentToken(token: string): void {
  const value = token.trim();
  if (!value) {
    withDb((db) => {
      db.prepare(`DELETE FROM ${KV_TABLE} WHERE key = ?`).run(AGENT_TOKEN_KEY);
    });
    cachedToken = null;
    return;
  }
  writeKv(AGENT_TOKEN_KEY, value);
  syncAgentTokenFile(value);
  // 让同进程内的 instrumentation（读 process.env 触发 tick）立刻跟上新令牌。
  process.env.SCHEDULE_API_TOKEN = value;
  process.env.CONTENT_INGEST_TOKEN = value;
}
