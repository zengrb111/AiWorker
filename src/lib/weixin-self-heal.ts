import { prisma } from "./prisma";
import { openClawClient } from "./openclaw";
import { backupLocalCredentials } from "./weixin-channel-health";
import { normalizeBotId, refreshWeixinAgentBindings } from "./weixin-bindings";

/**
 * 微信通道自愈（重启后自动恢复）。
 *
 * 为什么需要：
 *  - 微信插件只保留「最近活跃」的账号凭据（`accounts.json` ≈3 个），历史 bot 会被清掉；
 *  - 网关重启后只给「索引里还有凭据」的 bot 拉起通道，被清掉的 bot 直接起不来；
 *  - 即便配置还在，网关重启也会把到微信服务端的长连接打断，需要重新加载通道才会重连。
 *
 * 于是「昨天正常、今天重启后微信显示暂无法连接」反复出现。本函数在平台启动后
 * 自动跑一遍，把三件事一次做掉：
 *   1. 先把本机还活着的凭据抄到平台备份目录（丢了就永远补不回来）；
 *   2. 对每条 BOUND 绑定，从「本机凭据」或「平台备份」恢复通道并触发网关重载（重连微信）；
 *   3. 重建路由，确保每个活 bot 指向本人 agent（并顺手装配缺失的 agent）。
 *
 * 注意边界：微信服务端没有重新签发接口，若某 bot 的凭据「本机与备份都没有」，
 * 自愈无能为力，只能如实上报「需重新扫码」，绝不谎报恢复成功。
 */

export type SelfHealResult = {
  scanned: number;
  restored: string[];
  failed: Array<{ userId: string | null; botId: string | null; reason: string }>;
  routing: { mappings: number; users: number; changed: boolean; skipped: string[] } | null;
  backup: { scanned: number; saved: number; skipped: number };
  durationMs: number;
};

let running = false;

export async function healWeixinChannels(): Promise<SelfHealResult> {
  // 防重入：启动自愈与手动触发可能同时发生，串行化避免并发写 openclaw.json。
  if (running) {
    return {
      scanned: 0,
      restored: [],
      failed: [],
      routing: null,
      backup: { scanned: 0, saved: 0, skipped: 0 },
      durationMs: 0
    };
  }
  running = true;
  const startedAt = Date.now();
  try {
    // 1) 先抄一份本机活跃凭据 —— 插件会清理非活跃账号，丢了就再也补不回来。
    const backup = backupLocalCredentials();

    // 2) 逐个 BOUND 绑定做「凭据恢复 + 通道重载」
    const rows = await prisma.wechatBinding.findMany({
      where: { status: "BOUND" },
      orderBy: { boundAt: "desc" },
      select: { userId: true, wechatOpenId: true, wechatNo: true }
    });

    const seenBots = new Set<string>();
    const restored: string[] = [];
    const failed: SelfHealResult["failed"] = [];

    for (const row of rows) {
      const botRaw = (row.wechatOpenId || "").trim();
      const botId = normalizeBotId(botRaw);
      if (!botId) {
        failed.push({ userId: row.userId, botId: null, reason: "绑定缺少机器人身份（bot id）" });
        continue;
      }
      if (seenBots.has(botId)) continue;
      seenBots.add(botId);

      try {
        const r = await openClawClient.restoreWeixinChannelFromStoredAccount({ wechatOpenId: botRaw });
        if (r?.accountId) {
          restored.push(botId);
        } else {
          failed.push({
            userId: row.userId,
            botId,
            reason: "本机与备份均无可用凭据（微信服务端不再签发，需重新扫码绑定）"
          });
        }
      } catch (error) {
        failed.push({
          userId: row.userId,
          botId,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // 3) 重建路由：确保每个活 bot 指向本人 agent（并顺手装配缺失的 agent）。
    let routing: SelfHealResult["routing"] = null;
    try {
      const rr = await refreshWeixinAgentBindings();
      routing = {
        mappings: rr.mappings,
        users: rr.users,
        changed: rr.changed,
        skipped: rr.skippedNoCredential
      };
    } catch (error) {
      console.warn("[self-heal] 重建微信路由失败：", (error as Error).message);
    }

    const result: SelfHealResult = {
      scanned: rows.length,
      restored,
      failed,
      routing,
      backup,
      durationMs: Date.now() - startedAt
    };
    console.log(
      `[self-heal] 扫描 ${result.scanned} 条 BOUND，恢复 ${restored.length} 个通道，失败 ${failed.length} 个，路由 ${routing?.mappings ?? 0} 条，用时 ${result.durationMs}ms`
    );
    return result;
  } finally {
    running = false;
  }
}
