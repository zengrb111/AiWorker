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
    if (!binding.wechatOpenId) {
      return jsonError("当前绑定缺少 OpenClaw 微信 openId，无法解绑。");
    }

    await openClawClient.unbindWechat(binding.wechatOpenId);
    await prisma.wechatBinding.update({
      where: { id: binding.id },
      data: { status: "UNBOUND", boundAt: null }
    });

    return jsonOk({ unbound: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "解除微信绑定失败。", 502);
  }
}
