import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/platform-accounts/[id] —— 解绑（凭据随记录删除） */
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const account = await prisma.platformAccount.findUnique({ where: { id: params.id } });
  if (!account) return NextResponse.json({ ok: false, message: "账号不存在" }, { status: 404 });
  await prisma.platformAccount.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
