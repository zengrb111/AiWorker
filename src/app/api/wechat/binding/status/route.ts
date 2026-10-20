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

/**
 * 绑定成功但身份字段缺失时的兜底继承。
 *
 * 背景：微信服务端没有解绑接口，同一微信号再次扫码只会返回 binded_redirect
 * （不签发新凭据），此时 waitForWeixinLogin 拿不到 accountId/userId，
 * 落库的 BOUND 记录身份字段会是 null → 会话侧判定「尚未绑定微信」。
 * binded_redirect 意味着扫码的 bot 就是已绑过本网关的那个，所以从
 * **同一用户**的历史绑定记录继承身份是安全的；绝不跨用户继承。
 */
async function inheritIdentityFromHistory(
  userId: string
): Promise<{ wechatOpenId?: string; wechatNo?: string } | null> {
  if (!userId) return null;
  const candidates = await prisma.wechatBinding.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: { wechatOpenId: true, wechatNo: true }
  });
  for (const row of candidates) {
    const openId = (row.wechatOpenId || "").trim();
    const no = (row.wechatNo || "").trim();
    if (openId.endsWith("@im.bot") && no.endsWith("@im.wechat")) {
      return { wechatOpenId: openId, wechatNo: no };
    }
  }
  return null;
}

async function saveBinding(userId: string | null, body: Required<Pick<BindingStatusBody, "ticketId" | "status">> & BindingStatusBody) {
  if (!userId) {
    return;
  }

  // 绑定成功但网关没带回身份（binded_redirect 场景）时，从该用户历史绑定继承，
  // 避免 BOUND 记录身份为空导致会话/定时任务认为「未绑定微信」。
  let wechatOpenId = body.wechatOpenId;
  let wechatNo = body.wechatNo;
  if (body.status === "bound" && !wechatOpenId?.trim() && !wechatNo?.trim()) {
    const inherited = await inheritIdentityFromHistory(userId);
    if (inherited) {
      wechatOpenId = inherited.wechatOpenId;
      wechatNo = inherited.wechatNo;
    }
  }

  await prisma.wechatBinding.upsert({
    where: { ticketId: body.ticketId },
    create: {
      userId,
      ticketId: body.ticketId,
      status: toDbStatus(body.status),
      wechatNickname: body.wechatNickname,
      wechatOpenId,
      wechatNo,
      boundAt: body.status === "bound" ? new Date() : null
    },
    update: {
      userId,
      status: toDbStatus(body.status),
      wechatNickname: body.wechatNickname,
      wechatOpenId,
      wechatNo,
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
