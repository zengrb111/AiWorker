import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { prisma } from "./prisma";
import { ensureUserAgent, syncWeixinAgentBindings, userAgentId } from "./openclaw-user-agent";

/**
 * 微信入站消息 → 用户专属 agent 的分流。
 *
 * 为什么需要：`bindings` 若只把 `openclaw-weixin` 整体绑到 `main`，所有微信用户
 * 的对话都会由 main agent 处理 —— 会话按 openid 分开，但 workspace / USER.md /
 * MEMORY.md 是 main 的（平台运营者本人的档案），存在跨用户记忆泄露。
 *
 * 每个用户绑定的 bot 账号互不相同，所以按 `accountId` 精确路由即可。
 *
 * 只路由「本机仍有通道凭据」的 bot：凭据没了的 bot 既发不出也收不到，
 * 路由过去只会让会话落在一个永远不会有消息的 agent 上。
 */

const OPENCLAW_WEIXIN_DIR =
  process.env.OPENCLAW_WEIXIN_DIR?.trim() || path.join(homedir(), ".openclaw", "openclaw-weixin");

const BOT_SUFFIX = "@im.bot";
const USER_SUFFIX = "@im.wechat";

/** 本机现有凭据的 bot 账号 id（形如 `fc6ece3ec1ea-im-bot`）。 */
export function listLocalWeixinAccountIds(): Set<string> {
  const ids = new Set<string>();
  try {
    const indexPath = path.join(OPENCLAW_WEIXIN_DIR, "accounts.json");
    if (existsSync(indexPath)) {
      const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string" && item.trim()) ids.add(item.trim());
        }
      }
    }
  } catch (error) {
    console.warn("[weixin-bindings] 读取 accounts.json 失败：", (error as Error).message);
  }
  try {
    const dir = path.join(OPENCLAW_WEIXIN_DIR, "accounts");
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        if (name.endsWith(".context-tokens.json") || name.endsWith(".sync.json")) continue;
        ids.add(name.slice(0, -".json".length));
      }
    }
  } catch {
    // 忽略：索引已能覆盖绝大多数情况
  }
  return ids;
}

/** 把 `xxx@im.bot` / `xxx-im-bot` / `xxx` 统一成 `xxx`。 */
export function normalizeBotId(raw: string): string {
  const value = (raw || "").trim();
  if (!value) return "";
  if (value.endsWith(BOT_SUFFIX)) return value.slice(0, -BOT_SUFFIX.length);
  if (value.endsWith("-im-bot")) return value.slice(0, -"-im-bot".length);
  return value;
}

export type WeixinBindingSyncResult = {
  mappings: number;
  users: number;
  skippedNoCredential: string[];
  changed: boolean;
};

/**
 * 重建 bindings：每个「本机有凭据的 bot」→ 绑定它的那个用户的 `u-<id>` agent。
 *
 * 幂等：配置没变化时不写文件。可在绑定成功 / 用户注册后随时调用。
 */
export async function refreshWeixinAgentBindings(): Promise<WeixinBindingSyncResult> {
  const rows = await prisma.wechatBinding.findMany({
    where: { status: "BOUND" },
    orderBy: { boundAt: "desc" },
    select: { userId: true, wechatNo: true, wechatOpenId: true }
  });

  const local = listLocalWeixinAccountIds();
  const botToUser = new Map<string, string>();
  const seenBotIds = new Set<string>();
  const skippedNoCredential: string[] = [];

  for (const row of rows) {
    const bot = (row.wechatOpenId ?? "").trim();
    const to = (row.wechatNo ?? "").trim();
    if (!bot.endsWith(BOT_SUFFIX) || !to.endsWith(USER_SUFFIX)) continue;
    const botId = normalizeBotId(bot);
    if (!botId || !row.userId) continue;
    // 同一 bot 被多个用户绑过时，按 boundAt desc 取最新那条（循环首个即最新）。
    if (seenBotIds.has(botId)) continue;
    seenBotIds.add(botId);

    // 🔴 accountId 必须用渠道里**完整的账号 id**（`<botId>-im-bot`，与入站会话 key
    // 中间那段、`openclaw channels status` 报的一致）。只写 botId 匹配不上，
    // 消息会静默落回 `accountId:"*"` → main。
    const accountId = local.has(`${botId}-im-bot`)
      ? `${botId}-im-bot`
      : local.has(botId)
        ? botId
        : "";
    if (!accountId) {
      skippedNoCredential.push(`${botId}(${to})`);
      continue;
    }
    botToUser.set(accountId, row.userId);
  }

  // 先确保对应用户的 agent 存在，否则绑过去也跑不起来。
  for (const userId of new Set(botToUser.values())) {
    try {
      await ensureUserAgent({ userId });
    } catch (error) {
      console.error(`[weixin-bindings] 装配 agent 失败（user=${userId}）：`, error);
    }
  }

  const mappings = [...botToUser.entries()].map(([accountId, userId]) => ({
    agentId: userAgentId(userId),
    accountId
  }));
  const result = await syncWeixinAgentBindings(mappings);

  return {
    mappings: mappings.length,
    users: botToUser.size,
    skippedNoCredential,
    changed: result.changed
  };
}
