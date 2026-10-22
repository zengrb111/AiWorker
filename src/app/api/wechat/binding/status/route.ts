import { jsonError, jsonOk, readJson } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { prisma } from "@/lib/prisma";
import { readSessionUserId } from "@/lib/session";
import { refreshWeixinAgentBindings } from "@/lib/weixin-bindings";
import { checkUserChannel, findOtherOwnersOfWechatNo } from "@/lib/weixin-channel-health";

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

/**
 * 落库前先确认「这条通道以后真能收发」，通了才写 BOUND。
 *
 * 只凭网关一句 `connected` 会造出假绑定（binded_redirect / 凭据已被插件清理 /
 * 同一微信号被别的账号先绑走），用户体感就是「微信里问出来的和会话里不一样」。
 * 所以这里强制走一遍四道校验，任何一道不过就把状态降回 UNBOUND 并如实报错，
 * 前端才会显示「未绑定、需处理」，而不是一个永远收不到消息的绿灯。
 */
async function commitBound(
  userId: string,
  ticketId: string,
  body: BindingStatusBody
): Promise<void> {
  const wechatNo = (body.wechatNo || "").trim();
  const wechatOpenId = (body.wechatOpenId || "").trim();

  await saveBinding(userId, { ...body, ticketId, status: "bound" });

  const problems: string[] = [];

  // 1) 串号拦截：一个微信号只有一个微信会话窗口，只能连一个 bot。
  //    被别的账号先绑走时，这个账号拿不到凭据，消息永远进不来。
  if (wechatNo) {
    const others = await findOtherOwnersOfWechatNo(wechatNo, userId);
    if (others.length) {
      problems.push(
        `这个微信号已绑定其他平台账号（${others
          .map((o) => o.phone || o.userId.slice(-6))
          .join("、")}）。同一个微信号同一时间只能服务一个账号，请换一个微信号重新绑定。`
      );
    }
  }

  // 2) 通道四道校验：凭据在、索引在、路由指向本人、本人 agent 已装配。
  if (!problems.length) {
    try {
      // 先同步刷新路由（必须 await，下面要读它），再核对。
      await refreshWeixinAgentBindings();
      let health = await checkUserChannel(userId);

      // 凭据被插件清理，但平台侧留过备份 → 先拉回来再判，别把能救的判成死。
      if (!health.ok && health.accountId && !health.checks.credential) {
        const restored = await openClawClient.restoreWeixinChannelFromStoredAccount({
          wechatOpenId,
          wechatNo
        });
        if (restored) {
          console.log(`[wechat-binding] 已从平台备份恢复通道凭据（${restored.accountId}）`);
          await refreshWeixinAgentBindings();
          health = await checkUserChannel(userId);
        }
      }

      if (!health.ok) problems.push(...health.problems);
    } catch (error) {
      problems.push(`刷新微信路由失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!problems.length) {
    console.log(`[wechat-binding] 绑定闭环校验通过（user=${userId}, bot=${wechatOpenId || "-"}）`);
    return;
  }

  // 不通过：如实降级，保留历史记录供排查，但不留假绿灯。
  await saveBinding(userId, { ...body, ticketId, status: "unbound" });
  throw new Error(`微信通道没有真正建立，绑定未生效。${problems.join(" ")}`);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const ticketId = url.searchParams.get("ticketId")?.trim();
    if (!ticketId) {
      return jsonError("缺少 ticketId。");
    }

    const userId = readSessionUserId();
    const status = await openClawClient.getWechatBindingStatus(ticketId);

    let wechatOpenId = status.wechatOpenId;
    let wechatNo = status.wechatNo;

    // 网关说「连上了」但**没有签发凭据** —— binded_redirect：该微信号之前已绑过
    // 本网关，而微信服务端没有解绑接口。此时通道凭据只能靠本机已有记录恢复；
    // 恢复不了就必须**如实报错**，绝不能谎报绑定成功（那会导致通道其实没起
    // 来，用户从微信发消息永远没回复）。
    if (status.status === "bound" && status.credentialsIssued === false) {
      const inherited = userId ? await inheritIdentityFromHistory(userId) : null;
      const restored = inherited
        ? await openClawClient.restoreWeixinChannelFromStoredAccount(inherited)
        : null;
      if (restored && inherited) {
        wechatOpenId = inherited.wechatOpenId;
        wechatNo = inherited.wechatNo;
      } else {
        throw new Error(
          "微信服务端没有为该微信号签发新凭据（它此前已绑定过本网关），本机也没有可复用的通道凭据，" +
            "网关无法启动微信通道。请在微信侧的 ClawBot 设置里解除绑定后，重新扫码绑定。"
        );
      }
    }

    const identity = {
      wechatNickname: status.wechatNickname,
      wechatOpenId,
      wechatNo
    };

    // 绑定成功不再「先写 BOUND 再补路由」，而是校验通过才成立：
    // 任何一项不过都会降级为 UNBOUND 并抛出可执行的原因。
    if (status.status === "bound" && userId) {
      await commitBound(userId, ticketId, identity);
    } else {
      await saveBinding(userId, { ...identity, ticketId, status: status.status });
    }

    return jsonOk({ ...status, wechatOpenId, wechatNo });
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

    const userId = readSessionUserId();
    const identity = {
      wechatNickname: body.wechatNickname,
      wechatOpenId: body.wechatOpenId,
      wechatNo: body.wechatNo
    };

    // 前端上报的 bound 同样要过闭环校验，否则绕过 GET 就能造出假绑定。
    if (status === "bound" && userId) {
      await commitBound(userId, ticketId, identity);
    } else {
      await saveBinding(userId, { ...identity, ticketId, status });
    }

    return jsonOk({ ticketId, status, ...identity });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "保存微信绑定状态失败。", 500);
  }
}
