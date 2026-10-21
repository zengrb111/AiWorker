import { Prisma } from "@/generated/prisma";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { ensureUserAgent } from "@/lib/openclaw-user-agent";
import { hashPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/session";
import { refreshWeixinAgentBindings } from "@/lib/weixin-bindings";

type RegisterBody = {
  phone?: string;
  password?: string;
  ticketId?: string;
  binding?: {
    status?: "pending" | "bound" | "unbound";
    ticketId?: string;
    wechatNickname?: string;
    wechatOpenId?: string;
    wechatNo?: string;
  };
};

class BindingConflictError extends Error {}

export async function POST(request: Request) {
  try {
    const body = await readJson<RegisterBody>(request);
    const phone = body.phone?.trim() ?? "";
    const password = body.password ?? "";
    const binding = body.binding;
    const ticketId = (body.ticketId ?? binding?.ticketId ?? "").trim();

    if (!/^1\d{10}$/.test(phone)) {
      return jsonError("请输入 11 位中国大陆手机号。");
    }
    if (password.length < 6) {
      return jsonError("密码至少需要 6 位。");
    }
    if (!ticketId || binding?.status !== "bound") {
      return jsonError("请先扫码绑定 AI 员工通道。");
    }

    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          phone,
          passwordHash: hashPassword(password)
        },
        select: { id: true, phone: true }
      });

      const existingBinding = await tx.wechatBinding.findUnique({
        where: { ticketId },
        select: { userId: true }
      });

      if (existingBinding?.userId && existingBinding.userId !== createdUser.id) {
        throw new BindingConflictError("该微信通道已绑定其他账号，请重新扫码注册。");
      }

      await tx.wechatBinding.upsert({
        where: { ticketId },
        create: {
          userId: createdUser.id,
          status: "BOUND",
          ticketId,
          wechatNickname: binding.wechatNickname ?? "AI 员工指挥官",
          wechatOpenId: binding.wechatOpenId,
          wechatNo: binding.wechatNo,
          boundAt: new Date()
        },
        update: {
          userId: createdUser.id,
          status: "BOUND",
          wechatNickname: binding.wechatNickname ?? "AI 员工指挥官",
          wechatOpenId: binding.wechatOpenId,
          wechatNo: binding.wechatNo,
          boundAt: new Date()
        }
      });

      return createdUser;
    });

    // 装配该用户的专属 OpenClaw agent（独立 workspace / 记忆 / 会话库）。
    // 注册成功但装配失败时不能让用户重试注册（手机号已占用），所以只记日志、
    // 仍返回成功；聊天链路 sendTask 会再兜一层 ensureUserAgent。
    try {
      await ensureUserAgent({ userId: user.id, phone: user.phone });
    } catch (error) {
      console.error(`[register] 装配用户 agent 失败（user=${user.id}）：`, error);
    }

    // 该用户扫码绑定的 bot 需要把入站消息路由到他的专属 agent（而不是 main）。
    // 注册接口是绑定记录落库后的第一个确定性时点，这里重建一次 bindings。
    void refreshWeixinAgentBindings().catch((error) => {
      console.error(`[register] 刷新微信入站分流失败（user=${user.id}）：`, error);
    });

    await createSession(user.id);
    return jsonOk({ user });
  } catch (error) {
    if (error instanceof BindingConflictError) {
      return jsonError(error.message, 409);
    }
    // 优先用 instanceof，fallback 用 duck-type 检查 code（事务内 error 可能被包装）
    const prismaErr = error as { code?: string; meta?: { target?: string[] } };
    const isP2002 = (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      || prismaErr.code === "P2002";
    if (isP2002) {
      const target = Array.isArray(prismaErr.meta?.target) ? prismaErr.meta!.target! : [];
      if (target.includes("phone")) {
        return jsonError("该手机号已注册，请直接登录或更换手机号。", 409);
      }
      if (target.includes("ticketId")) {
        return jsonError("该微信通道已被使用，请重新扫码注册。", 409);
      }
    }
    // 最终兜底：error message 含 phone unique constraint 也归为手机号重复
    const errMsg = error instanceof Error ? error.message : "";
    if (errMsg.includes("Unique constraint failed") && errMsg.includes("phone")) {
      return jsonError("该手机号已注册，请直接登录或更换手机号。", 409);
    }
    return jsonError("注册失败，请稍后重试。", 500);
  }
}