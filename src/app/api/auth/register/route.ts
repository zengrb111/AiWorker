import { Prisma } from "@/generated/prisma";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { hashPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/session";

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

    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: hashPassword(password),
        wechatBindings: {
          create: {
            status: "BOUND",
            ticketId,
            wechatNickname: binding.wechatNickname ?? "AI 员工指挥官",
            wechatOpenId: binding.wechatOpenId,
            wechatNo: binding.wechatNo,
            boundAt: new Date()
          }
        }
      },
      select: { id: true, phone: true }
    });

    await createSession(user.id);
    return jsonOk({ user });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return jsonError("该手机号已注册。", 409);
    }
    return jsonError(error instanceof Error ? error.message : "注册失败。", 500);
  }
}