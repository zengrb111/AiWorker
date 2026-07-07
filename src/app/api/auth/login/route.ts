import { jsonError, jsonOk, readJson } from "@/lib/http";
import { verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/session";

type LoginBody = {
  phone?: string;
  password?: string;
};

export async function POST(request: Request) {
  try {
    const body = await readJson<LoginBody>(request);
    const phone = body.phone?.trim() ?? "";
    const password = body.password ?? "";

    const user = await prisma.user.findUnique({
      where: { phone },
      select: { id: true, phone: true, passwordHash: true }
    });

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return jsonError("手机号或密码不正确。", 401);
    }

    await createSession(user.id);
    return jsonOk({ user: { id: user.id, phone: user.phone } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "登录失败。", 500);
  }
}
