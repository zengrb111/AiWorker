import { jsonError, jsonOk, readJson } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { prisma } from "@/lib/prisma";
import { readSessionUserId } from "@/lib/session";

type BindingStatusValue = "pending" | "bound" | "unbound";

type BindingStatusBody = {
  ticketId?: string;
  status?: BindingStatusValue;
  wechatNickname?: string;
  wechatOpenId?: string;
  wechatNo?: string;
};

function toDbStatus(status: BindingStatusValue) {
  return status === "bound" ? "BOUND" : status === "unbound" ? "UNBOUND" : "PENDING";
}

async function saveBinding(userId: string | null, body: Required<Pick<BindingStatusBody, "ticketId" | "status">> & BindingStatusBody) {
  if (!userId) {
    return;
  }

  await prisma.wechatBinding.upsert({
    where: { ticketId: body.ticketId },
    create: {
      userId,
      ticketId: body.ticketId,
      status: toDbStatus(body.status),
      wechatNickname: body.wechatNickname,
      wechatOpenId: body.wechatOpenId,
      wechatNo: body.wechatNo,
      boundAt: body.status === "bound" ? new Date() : null
    },
    update: {
      userId,
      status: toDbStatus(body.status),
      wechatNickname: body.wechatNickname,
      wechatOpenId: body.wechatOpenId,
      wechatNo: body.wechatNo,
      boundAt: body.status === "bound" ? new Date() : null
    }
  });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const ticketId = url.searchParams.get("ticketId")?.trim();
    if (!ticketId) {
      return jsonError("缺少 ticketId。");
    }

    const status = await openClawClient.getWechatBindingStatus(ticketId);
    await saveBinding(readSessionUserId(), {
      ticketId,
      status: status.status,
      wechatNickname: status.wechatNickname,
      wechatOpenId: status.wechatOpenId,
      wechatNo: status.wechatNo
    });

    return jsonOk(status);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "查询微信绑定状态失败。", 502);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJson<BindingStatusBody>(request);
    const ticketId = body.ticketId?.trim();
    const status = body.status;
    if (!ticketId) {
      return jsonError("缺少 ticketId。");
    }
    if (!status) {
      return jsonError("缺少绑定状态。");
    }

    await saveBinding(readSessionUserId(), {
      ticketId,
      status,
      wechatNickname: body.wechatNickname,
      wechatOpenId: body.wechatOpenId,
      wechatNo: body.wechatNo
    });

    return jsonOk({
      ticketId,
      status,
      wechatNickname: body.wechatNickname,
      wechatOpenId: body.wechatOpenId,
      wechatNo: body.wechatNo
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "保存微信绑定状态失败。", 500);
  }
}
