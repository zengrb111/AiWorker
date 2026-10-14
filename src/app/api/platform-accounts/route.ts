import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { encryptCredential, normalizeCookie } from "@/lib/platform-creds";
import { PLATFORM_META, inferSiteKind, verifyHealingCredential, verifyPlatformCredential, verifySiteCredential, verifyFrontierCredential } from "@/lib/platform-sync";

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
 *  - aiworker：AI员工官网 AI最前沿频道（域名 + API Key），用于资讯推送
 *  - xhs / toutiao / wechat（公众号）/ channels（视频号）：粘贴后台 Cookie，真实验证后加密存储
 */
export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const platform = String(body?.platform || "").trim();

  if (platform === "site" || platform === "healing" || platform === "aiworker") {
    const domain = String(body?.domain || "").trim();
    const token = String(body?.token || "").trim();
    if (!domain || !token) {
      return NextResponse.json({ ok: false, message: "请填写官网域名与令牌" }, { status: 400 });
    }
    // 各官网卡片按平台走各自的接口校验
    const verified =
      platform === "healing"
        ? await verifyHealingCredential(domain, token)
        : platform === "aiworker"
          ? await verifyFrontierCredential(domain, token)
          : await verifySiteCredential(domain, token);
    if (!verified.ok) {
      return NextResponse.json({ ok: false, message: verified.message }, { status: 400 });
    }
    const kind: string =
      platform === "healing" ? "healing" : platform === "aiworker" ? "aiworker" : verified.siteKind ?? inferSiteKind(domain);
    const credentialEnc = encryptCredential(JSON.stringify({ domain, token, kind }));
    const statusMsg =
      kind === "healing"
        ? "配置成功（心灵驿站 · 内容推送）"
        : kind === "aiworker"
          ? "配置成功（AI最前沿 · 资讯推送）"
          : "配置成功";
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

  // Cookie 类平台：小红书 / 头条号 / 公众号 / 视频号
  const COOKIE_PLATFORMS = ["xhs", "toutiao", "wechat", "channels"];
  if (!PLATFORM_META[platform] || !COOKIE_PLATFORMS.includes(platform)) {
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
