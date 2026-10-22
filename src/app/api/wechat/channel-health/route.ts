import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { readSessionUserId } from "@/lib/session";
import { refreshWeixinAgentBindings } from "@/lib/weixin-bindings";
import { auditChannels, backupLocalCredentials, checkUserChannel, countCredentialBackups } from "@/lib/weixin-channel-health";

/**
 * 微信通道体检。
 *
 * GET  ：只看当前登录用户 —— 绑定到底真通还是假通，不通给原因。
 * POST ：全量巡检所有 BOUND 记录；`?fix=1` 时把确认不通的降级为 UNBOUND，
 *        并重建路由（否则失效 bot 的映射会一直留在 bindings 里）。
 *
 * 存在的理由：绑定接口现在会在成功时校验一次，但凭据会被微信插件清理，
 * 校验通过不代表永远通。需要有个随时能跑的核对入口，把「平台绿、微信不通」
 * 这种静默故障暴露出来。
 */
export async function GET() {
  try {
    const userId = readSessionUserId();
    if (!userId) return jsonError("未登录。", 401);
    const health = await checkUserChannel(userId);
    return jsonOk({ ...health, credentialBackups: countCredentialBackups() });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "检查微信通道失败。", 500);
  }
}

export async function POST(request: Request) {
  try {
    const fix = new URL(request.url).searchParams.get("fix") === "1";
    // 先抄一份凭据：插件会清理非活跃账号，丢了就再也拿不回来。
    const backup = backupLocalCredentials();
    const audit = await auditChannels();

    const downgraded: Array<{ userId: string; phone: string | null; reason: string }> = [];
    if (fix) {
      for (const entry of audit.broken) {
        // 串号优先级最高：同一个微信号被两个账号绑，后绑的那个必然没凭据。
        const reason = entry.sharedWechatNoWith.length
          ? `微信号被 ${entry.sharedWechatNoWith.length} 个其他账号同时绑定`
          : entry.problems.join(" ");
        const rows = await prisma.wechatBinding.findMany({
          where: { userId: entry.userId, status: "BOUND" },
          select: { id: true }
        });
        if (!rows.length) continue;
        await prisma.wechatBinding.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { status: "UNBOUND", boundAt: null }
        });
        downgraded.push({ userId: entry.userId, phone: entry.phone, reason });
      }
      if (downgraded.length) {
        // 摘掉已失效 bot 的入站映射，避免消息落到永远没内容的 agent 上。
        await refreshWeixinAgentBindings();
      }
    }

    return jsonOk({
      total: audit.total,
      healthy: audit.healthy,
      broken: audit.broken.map((e) => ({
        userId: e.userId,
        phone: e.phone,
        botId: e.botId,
        checks: e.checks,
        problems: e.problems,
        sharedWechatNoWith: e.sharedWechatNoWith
      })),
      downgraded,
      backup,
      fixed: fix
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "巡检微信通道失败。", 500);
  }
}
