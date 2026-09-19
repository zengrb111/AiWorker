import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/platform-metrics/ingest —— 本地采集器数据推送入口（Bearer CONTENT_INGEST_TOKEN）。
 * 小红书创作者中心接口有签名风控，数据由本地 CDP 采集器（scripts/xhs-collect.mjs）抓取；
 * 头条号 feed 接口服务端可直连，由 scripts/toutiao-collect.mjs 抓取。
 * Body: { platform: "xhs" | "toutiao", notes: [{ id, title, time, type, views, clicks, likes, comments, collects, shares }] }
 * 头条号字段映射：views=阅读+播放，clicks=展现（showCount）
 */
const ALLOWED_PLATFORMS = new Set(["xhs", "toutiao"]);

export async function POST(req: Request) {
  const token = process.env.CONTENT_INGEST_TOKEN || "";
  const auth = req.headers.get("authorization") || "";
  if (!token || auth !== `Bearer ${token}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const platform = String(body?.platform || "").trim();
  const notes: any[] = Array.isArray(body?.notes) ? body.notes : [];
  if (!ALLOWED_PLATFORMS.has(platform) || notes.length === 0) {
    return NextResponse.json({ ok: false, message: "参数错误：需要 platform（xhs/toutiao）和非空 notes" }, { status: 400 });
  }

  const account = await prisma.platformAccount.findFirst({ where: { platform, status: { not: "expired" } } });
  if (!account) {
    return NextResponse.json({ ok: false, message: "平台尚未授权，请先在「平台授权管理」完成绑定" }, { status: 400 });
  }

  const metricDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  let saved = 0;
  let totalViews = 0;
  for (const n of notes) {
    const contentKey = String(n?.id || "").trim();
    if (!contentKey) continue;
    const row = {
      title: String(n.title || "未命名笔记").slice(0, 500),
      views: Number(n.views) || 0,
      clicks: Number(n.clicks) || 0,
      likes: Number(n.likes) || 0,
      comments: Number(n.comments) || 0,
      collects: Number(n.collects) || 0,
      shares: Number(n.shares) || 0,
    };
    totalViews += row.views;
    await prisma.platformContentMetric.upsert({
      where: { platform_contentKey_metricDate: { platform, contentKey, metricDate } },
      update: { ...row, accountId: account.id },
      create: { platform, contentKey, metricDate, accountId: account.id, ...row },
    });
    saved++;
  }

  await prisma.platformAccount.update({
    where: { id: account.id },
    data: { lastSyncAt: new Date(), status: "active", statusMsg: `同步成功（${saved} 篇笔记，累计曝光 ${totalViews}）` },
  });

  return NextResponse.json({ ok: true, data: { savedCount: saved, totalViews } });
}
