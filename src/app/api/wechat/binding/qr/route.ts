import { jsonError, jsonOk } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { prisma } from "@/lib/prisma";
import { readSessionUserId } from "@/lib/session";

export async function POST() {
  try {
    const qr = await openClawClient.createWechatBindingQr();
    const userId = readSessionUserId();

    if (userId) {
      await prisma.wechatBinding.create({
        data: {
          userId,
          status: "PENDING",
          ticketId: qr.ticketId,
          qrCodeUrl: qr.qrCodeUrl ?? qr.qrCodeText
        }
      });
    }

    return jsonOk(qr);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "生成微信绑定二维码失败。", 502);
  }
}
