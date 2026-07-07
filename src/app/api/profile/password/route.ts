import { jsonError, jsonOk, readJson } from "@/lib/http";
import { hashPassword, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

type PasswordBody = {
  oldPassword?: string;
  newPassword?: string;
};

export async function PATCH(request: Request) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const body = await readJson<PasswordBody>(request);
  if (!verifyPassword(body.oldPassword ?? "", user.passwordHash)) {
    return jsonError("当前密码不正确。");
  }
  if ((body.newPassword ?? "").length < 6) {
    return jsonError("新密码至少需要 6 位。");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: hashPassword(body.newPassword ?? "") }
  });
  return jsonOk({ updated: true });
}
