import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { prisma } from "./prisma";
import { listLocalWeixinAccountIds, normalizeBotId } from "./weixin-bindings";
import { resolveOpenClawConfigPath, userAgentId } from "./openclaw-user-agent";

/**
 * 微信通道「真通」校验。
 *
 * 为什么需要：绑定接口过去只凭网关回一句 `connected` 就落 BOUND。但「网关说连上了」
 * 与「这条通道以后真能收发」是两件事 —— 实测出现过两种情况：
 *
 *  1. binded_redirect：同一微信号已绑过本网关，微信服务端不签发新凭据，
 *     平台落了一条身份齐全的 BOUND，本机却从来没有这个 bot 的 token；
 *  2. 凭据被插件清理：`accounts.json` 只保留活跃账号，历史 bot 的凭据会消失，
 *     路由表随之跳过它（`refreshWeixinAgentBindings` 明确只路由本机有凭据的 bot）。
 *
 * 两种情况的共同后果：平台显示「已绑定」，用户在微信里问什么 agent 都收不到，
 * 或者消息落到别的账号的 bot 上（同一微信号被两个平台账号绑过时）。
 * 用户体感就是「微信里问出来的和会话里不一样」。
 *
 * 所以绑定必须过四道：凭据在、索引在、路由指向本人、本人 agent 已装配。
 * 四项全真才算 BOUND；任何一项缺失都如实降级并给出可执行的原因。
 */

const OPENCLAW_WEIXIN_DIR =
  process.env.OPENCLAW_WEIXIN_DIR?.trim() || path.join(homedir(), ".openclaw", "openclaw-weixin");

/** 平台侧凭据备份目录：插件清理 `accounts.json` 后靠它把通道拉回来。 */
export const CREDENTIAL_BACKUP_DIR = path.join(process.cwd(), "data", "weixin-credentials");

const BOT_SUFFIX = "@im.bot";
const USER_SUFFIX = "@im.wechat";

export type CredentialBackup = {
  accountId: string;
  token: string;
  baseUrl?: string;
  userId?: string;
  savedAt: number;
};

/**
 * 把一份凭据另存到平台自己的目录。
 *
 * 插件只维护「活跃账号」的凭据，历史 bot 会被清掉；清掉之后 token 再也拿不回来
 * （微信服务端没有重新签发的接口）。这里是唯一一份可恢复的副本，所以每次绑定
 * 成功都要写，写失败也不能影响绑定主流程。
 */
export function saveCredentialBackup(input: {
  accountId: string;
  token?: string;
  baseUrl?: string;
  userId?: string;
}): boolean {
  const accountId = (input.accountId || "").trim();
  const token = (input.token || "").trim();
  if (!accountId || !token) return false;
  try {
    mkdirSync(CREDENTIAL_BACKUP_DIR, { recursive: true });
    const file = path.join(CREDENTIAL_BACKUP_DIR, `${accountId}.json`);
    const payload: CredentialBackup = {
      accountId,
      token,
      baseUrl: input.baseUrl,
      userId: input.userId,
      savedAt: Date.now()
    };
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, file);
    return true;
  } catch (error) {
    console.warn("[weixin-health] 备份微信凭据失败：", (error as Error).message);
    return false;
  }
}

export function readCredentialBackup(accountId: string): CredentialBackup | null {
  const id = (accountId || "").trim();
  if (!id) return null;
  try {
    const file = path.join(CREDENTIAL_BACKUP_DIR, `${id}.json`);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CredentialBackup;
    if (!parsed?.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 本机凭据文件里是否真有 token（`listLocalWeixinAccountIds` 只看得到 id）。 */
function hasLocalToken(accountId: string): boolean {
  try {
    const file = path.join(OPENCLAW_WEIXIN_DIR, "accounts", `${accountId}.json`);
    if (!existsSync(file)) return false;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { token?: string };
    return Boolean(parsed?.token && parsed.token.trim());
  } catch {
    return false;
  }
}

type OpenClawRoutingConfig = {
  agents?: { entries?: Record<string, { workspace?: string }> };
  bindings?: Array<{ agentId?: string; match?: { channel?: string; accountId?: string } }>;
};

function readRoutingConfig(): OpenClawRoutingConfig {
  try {
    return JSON.parse(readFileSync(resolveOpenClawConfigPath(), "utf8")) as OpenClawRoutingConfig;
  } catch {
    return {};
  }
}

export type ChannelHealth = {
  ok: boolean;
  userId: string;
  botId: string | null;
  accountId: string | null;
  wechatNo: string | null;
  checks: {
    identity: boolean;
    credential: boolean;
    indexed: boolean;
    routed: boolean;
    agentReady: boolean;
  };
  problems: string[];
};

const PROBLEM_TEXT: Record<string, string> = {
  identity: "绑定记录缺少机器人身份（bot id / 微信号），无法确定路由目标。",
  credential: "本机没有这个机器人的通道凭据，微信消息收发不通。",
  indexed: "机器人未登记进账号索引，网关重启后不会加载这条通道。",
  routed: "网关路由没有把这个机器人指向你本人的 agent，消息会落到别处。",
  agentReady: "你本人的 agent 还没装配，微信消息没有可用的处理者。"
};

/**
 * 核对某个用户的微信通道是否真通。
 *
 * 只读，不修改任何状态；调用方根据 `ok` 决定落 BOUND 还是降级。
 */
export async function checkUserChannel(userId: string): Promise<ChannelHealth> {
  const empty: ChannelHealth = {
    ok: false,
    userId,
    botId: null,
    accountId: null,
    wechatNo: null,
    checks: { identity: false, credential: false, indexed: false, routed: false, agentReady: false },
    problems: []
  };
  if (!userId) {
    empty.problems.push("缺少 userId。");
    return empty;
  }

  const row = await prisma.wechatBinding.findFirst({
    where: { userId, status: "BOUND" },
    orderBy: [{ boundAt: "desc" }, { updatedAt: "desc" }],
    select: { wechatOpenId: true, wechatNo: true }
  });
  if (!row) {
    empty.problems.push("这个账号还没有生效中的微信绑定。");
    return empty;
  }

  const botRaw = (row.wechatOpenId || "").trim();
  const wechatNo = (row.wechatNo || "").trim();
  const botId = normalizeBotId(botRaw);
  const accountId = botId ? `${botId}-im-bot` : null;

  const identity = Boolean(botId && wechatNo.endsWith(USER_SUFFIX));
  const credential = accountId ? hasLocalToken(accountId) : false;
  const indexed = accountId ? listLocalWeixinAccountIds().has(accountId) : false;

  const cfg = readRoutingConfig();
  const expectedAgent = userAgentId(userId);
  const routed =
    Boolean(accountId) &&
    (cfg.bindings ?? []).some(
      (b) =>
        b?.match?.channel === "openclaw-weixin" &&
        b.match.accountId === accountId &&
        b.agentId === expectedAgent
    );
  const agentReady = Boolean(cfg.agents?.entries?.[expectedAgent]);

  const checks = { identity, credential, indexed, routed, agentReady };
  const problems = (Object.keys(checks) as Array<keyof typeof checks>)
    .filter((key) => !checks[key])
    .map((key) => PROBLEM_TEXT[key]);

  return {
    ok: problems.length === 0,
    userId,
    botId: botId || null,
    accountId,
    wechatNo: wechatNo || null,
    checks,
    problems
  };
}

export type ChannelAuditEntry = ChannelHealth & {
  phone: string | null;
  /** 历史绑定里同一个微信号被别的账号也绑过 —— 这类账号的微信消息必然串号。 */
  sharedWechatNoWith: string[];
};

/**
 * 全量巡检：把所有 BOUND 记录按「真通」标准过一遍。
 *
 * 也检查「同一微信号被多个账号绑定」——微信一个号只有一个会话窗口，物理上
 * 只能连一个 bot，第二个账号必然拿不到凭据，即使平台记成 BOUND 也是空的。
 */
export async function auditChannels(): Promise<{
  total: number;
  healthy: number;
  broken: ChannelAuditEntry[];
  entries: ChannelAuditEntry[];
}> {
  const rows = await prisma.wechatBinding.findMany({
    where: { status: "BOUND" },
    orderBy: [{ boundAt: "desc" }, { updatedAt: "desc" }],
    select: { userId: true, wechatNo: true, wechatOpenId: true }
  });

  // 每个用户只保留一条（最新），同时统计微信号被哪些用户占过。
  const seenUser = new Set<string>();
  const noToUsers = new Map<string, Set<string>>();
  for (const row of rows) {
    const uid = (row.userId || "").trim();
    const no = (row.wechatNo || "").trim();
    if (!uid || !no) continue;
    if (!noToUsers.has(no)) noToUsers.set(no, new Set());
    noToUsers.get(no)!.add(uid);
  }

  const entries: ChannelAuditEntry[] = [];
  const healthByUser = new Map<string, ChannelHealth>();
  for (const row of rows) {
    const uid = (row.userId || "").trim();
    if (!uid || seenUser.has(uid)) continue;
    seenUser.add(uid);
    const health = await checkUserChannel(uid);
    healthByUser.set(uid, health);
    entries.push({ ...health, phone: null, sharedWechatNoWith: [] });
  }

  // 共号只在「对端通道真的活着」时才算串号。对端凭据早就没了的话它并不占着
  // 这个微信号，标出来只会误导排查。
  for (const entry of entries) {
    const no = (entry.wechatNo || "").trim();
    if (!no) continue;
    entry.sharedWechatNoWith = [...(noToUsers.get(no) ?? [])].filter(
      (id) => id !== entry.userId && healthByUser.get(id)?.ok === true
    );
  }

  const userIds = entries.map((e) => e.userId);
  if (userIds.length) {
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, phone: true }
    });
    const phoneById = new Map(users.map((u) => [u.id, u.phone]));
    for (const entry of entries) entry.phone = phoneById.get(entry.userId) ?? null;
  }

  // 只有「自己不通」才算坏。共号只是线索：对端可能早就没凭据了（此时它并不
  // 真的占着这个微信号），所以不能单凭 sharedWechatNoWith 判坏，否则健康账号
  // 会被历史脏数据跟着标红。
  const broken = entries.filter((e) => !e.ok);
  return { total: entries.length, healthy: entries.length - broken.length, broken, entries };
}

/**
 * 这个微信号是否被**仍在正常工作**的别的账号占着（用于绑定时拦截串号）。
 *
 * 只看 BOUND 不够：同一微信号被绑过多次时，早先那些账号的凭据往往已经失效，
 * 它们并不真的占用通道。按「通道真通」过滤，才不会把健康用户的重绑拦掉。
 */
export async function findOtherOwnersOfWechatNo(
  wechatNo: string,
  selfUserId: string
): Promise<Array<{ userId: string; phone: string | null }>> {
  const no = (wechatNo || "").trim();
  if (!no) return [];
  const rows = await prisma.wechatBinding.findMany({
    where: { status: "BOUND", wechatNo: no },
    select: { userId: true }
  });
  const ids = [...new Set(rows.map((r) => r.userId).filter((id): id is string => Boolean(id)))].filter(
    (id) => id !== selfUserId
  );
  if (!ids.length) return [];

  const alive: string[] = [];
  for (const id of ids) {
    const health = await checkUserChannel(id);
    if (health.ok) alive.push(id);
  }
  if (!alive.length) return [];

  const users = await prisma.user.findMany({ where: { id: { in: alive } }, select: { id: true, phone: true } });
  const phoneById = new Map(users.map((u) => [u.id, u.phone]));
  return alive.map((id) => ({ userId: id, phone: phoneById.get(id) ?? null }));
}

/** 备份目录里现有多少个可恢复的机器人凭据（运维用）。 */
export function countCredentialBackups(): number {
  try {
    if (!existsSync(CREDENTIAL_BACKUP_DIR)) return 0;
    return readdirSync(CREDENTIAL_BACKUP_DIR).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/**
 * 把本机所有还在的凭据抄一份到平台备份目录。
 *
 * 插件只保留活跃账号的凭据，历史 bot 会被清掉且微信服务端不再签发 —— 所以
 * 「能备份的时候不备份，等丢了就永远补不回来」。巡检时顺手跑一次，成本是
 * 读几个小 json。
 */
export function backupLocalCredentials(): { scanned: number; saved: number; skipped: number } {
  let scanned = 0;
  let saved = 0;
  let skipped = 0;
  try {
    const dir = path.join(OPENCLAW_WEIXIN_DIR, "accounts");
    if (!existsSync(dir)) return { scanned, saved, skipped };
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      if (name.endsWith(".context-tokens.json") || name.endsWith(".sync.json")) continue;
      scanned += 1;
      const accountId = name.slice(0, -".json".length);
      // 已有备份就不覆盖：备份里那份可能比现在更完整（含 userId）。
      if (existsSync(path.join(CREDENTIAL_BACKUP_DIR, `${accountId}.json`))) {
        skipped += 1;
        continue;
      }
      try {
        const data = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as {
          token?: string;
          baseUrl?: string;
          userId?: string;
        };
        if (saveCredentialBackup({ accountId, ...data })) saved += 1;
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
  } catch (error) {
    console.warn("[weixin-health] 批量备份凭据失败：", (error as Error).message);
  }
  return { scanned, saved, skipped };
}

export { BOT_SUFFIX, USER_SUFFIX };
