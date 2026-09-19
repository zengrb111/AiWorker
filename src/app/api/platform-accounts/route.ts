import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { encryptCredential, normalizeCookie } from "@/lib/platform-creds";
import { PLATFORM_META, verifyPlatformCredential } from "@/lib/platform-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/platform-accounts —— 已授权账号列表（不回传凭据） */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const accounts = await prisma.platformAccount.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      platform: true,
      displayName: true,
      externalId: true,
      status: true,
      statusMsg: true,
      boundBy: true,
      lastSyncAt: true,
      lastVerifyAt: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ ok: true, accounts, meta: PLATFORM_META });
}

/** POST /api/platform-accounts —— 绑定账号（真实校验平台 Cookie 后加密落库） */
export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const platform = String(body?.platform || "").trim();
  const cookie = normalizeCookie(String(body?.cookie || ""));
  if (!PLATFORM_META[platform] || platform === "site") {
    return NextResponse.json({ ok: false, message: "该平台不需要（或暂不支持）Cookie 授权" }, { status: 400 });
  }
  if (cookie.length < 20) {
    return NextResponse.json({ ok: false, message: "请粘贴完整的平台 Cookie" }, { status: 400 });
  }

  // 真实请求平台接口验证凭据有效性
  const verified = await verifyPlatformCredential(platform, cookie);
  if (!verified.ok) {
    return NextResponse.json({ ok: false, message: verified.message }, { status: 400 });
  }

  const credentialEnc = encryptCredential(cookie);
  const account = await prisma.platformAccount.upsert({
    where: { platform_externalId: { platform, externalId: verified.externalId } },
    update: {
      displayName: verified.displayName,
      credentialEnc,
      status: "active",
      statusMsg: "绑定成功",
      boundBy: user.phone || user.id,
      lastVerifyAt: new Date(),
    },
    create: {
      platform,
      displayName: verified.displayName,
      externalId: verified.externalId,
      credentialEnc,
      status: "active",
      statusMsg: "绑定成功",
      boundBy: user.phone || user.id,
      lastVerifyAt: new Date(),
    },
  });
  return NextResponse.json({
    ok: true,
    account: {
      id: account.id,
      platform: account.platform,
      displayName: account.displayName,
      status: account.status,
    },
  });
}
