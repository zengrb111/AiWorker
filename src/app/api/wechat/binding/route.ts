import { jsonError, jsonOk } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export async function DELETE() {
  try {
    const user = await requireUser();
    if (!user) {
      return jsonError("未登录。", 401);
    }

    const binding = await prisma.wechatBinding.findFirst({
      where: { userId: user.id, status: "BOUND" },
      orderBy: { updatedAt: "desc" }
    });

    if (!binding) {
      return jsonError("当前没有已绑定的微信通道。");
    }

    // 历史数据的 wechatOpenId 可能为空，退回用 wechatNo（微信 userId）反查本地账号。
    const accountRef = binding.wechatOpenId?.trim() || binding.wechatNo?.trim() || "";

    if (accountRef) {
      // 停止通道 + 清理本地凭据；失败时直接返回错误，避免"界面显示已解绑、微信其实还能用"。
      await openClawClient.unbindWechat(accountRef);
    }

    await prisma.wechatBinding.update({
      where: { id: binding.id },
      data: { status: "UNBOUND", boundAt: null }
    });

    /**
     * 兜底：清理不再被任何活跃绑定引用的残留通道。
     * 历史上 wechatOpenId 为空的绑定解绑时定位不到具体通道，通道会留在网关里
     * 持续长轮询（token 过期的还会反复重试），最终拖死网关事件循环导致反复重启。
     * 注意必须放在状态改成 UNBOUND 之后执行，否则本通道仍会被判为活跃。
     */
    const prunedOrphans = await openClawClient
      .pruneOrphanWechatAccounts()
      .catch((error) => {
        console.warn(
          `[wechat/binding] 孤儿通道清理失败（不影响解绑结果）：${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return [] as string[];
      });

    return jsonOk({ unbound: true, prunedOrphans });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "解除微信绑定失败。", 502);
  }
}
