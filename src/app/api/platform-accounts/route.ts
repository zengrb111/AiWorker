import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { encryptCredential, normalizeCookie } from "@/lib/platform-creds";
import { PLATFORM_META, inferSiteKind, verifyHealingCredential, verifyPlatformCredential, verifySiteCredential, type SiteKind } from "@/lib/platform-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/platform-accounts —— 当前登录用户的已授权账号列表（不回传凭据） */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const accounts = await prisma.platformAccount.findMany({
    where: { userId: user.id },
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

/** POST /api/platform-accounts —— 绑定/配置账号（按登录用户隔离）
 *  - site：官网域名 + 令牌，自动识别「好物推荐（和光万象）」/「心灵驿站」
 *  - healing：AI回忆录官网心灵驿站频道（域名 + 令牌），用于图文推送
 *  - xhs / toutiao：粘贴创作者后台 Cookie，真实验证后加密存储
 */
export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const platform = String(body?.platform || "").trim();

  if (platform === "site" || platform === "healing") {
    const domain = String(body?.domain || "").trim();
    const token = String(body?.token || "").trim();
    if (!domain || !token) {
      return NextResponse.json({ ok: false, message: "请填写官网域名与令牌" }, { status: 400 });
    }
    // 心灵驿站专用卡片只认心灵驿站接口；官网卡片两类官网自动识别
    const verified = platform === "healing"
      ? await verifyHealingCredential(domain, token)
      : await verifySiteCredential(domain, token);
    if (!verified.ok) {
      return NextResponse.json({ ok: false, message: verified.message }, { status: 400 });
    }
    const kind: SiteKind = platform === "healing" ? "healing" : verified.siteKind ?? inferSiteKind(domain);
    const credentialEnc = encryptCredential(JSON.stringify({ domain, token, kind }));
    const statusMsg = kind === "healing" ? "配置成功（心灵驿站 · 内容推送）" : "配置成功";
    const account = await prisma.platformAccount.upsert({
      where: { userId_platform: { userId: user.id, platform } },
      update: {
        displayName: verified.displayName,
        credentialEnc,
        status: "active",
        statusMsg,
        boundBy: user.phone || user.id,
        lastVerifyAt: new Date(),
      },
      create: {
        userId: user.id,
        platform,
        displayName: verified.displayName,
        credentialEnc,
        status: "active",
        statusMsg,
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
        kind,
      },
    });
  }

  if (!PLATFORM_META[platform] || (platform !== "xhs" && platform !== "toutiao")) {
    return NextResponse.json({ ok: false, message: "不支持的平台" }, { status: 400 });
  }
  const cookie = normalizeCookie(String(body?.cookie || ""));
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
    where: { userId_platform: { userId: user.id, platform } },
    update: {
      displayName: verified.displayName,
      externalId: verified.externalId,
      credentialEnc,
      status: "active",
      statusMsg: "绑定成功",
      boundBy: user.phone || user.id,
      lastVerifyAt: new Date(),
    },
    create: {
      userId: user.id,
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
