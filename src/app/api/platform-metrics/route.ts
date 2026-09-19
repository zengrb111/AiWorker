import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { PLATFORM_META } from "@/lib/platform-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/platform-metrics —— 效果分析聚合数据
 * 返回：各平台汇总（浏览/点击/互动）、站点 PV/UV 近 N 天、内容明细。
 */
export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const days = Math.min(Number(url.searchParams.get("days")) || 14, 90);

  // 全量取回做「每内容最新一天」聚合（当前库量千级，安全；明细单独截 Top 100）
  const metrics = await prisma.platformContentMetric.findMany({
    orderBy: { updatedAt: "desc" },
    take: 20000,
  });
  const siteMetrics = await prisma.platformSiteMetric.findMany({
    orderBy: { metricDate: "asc" },
    take: days,
  });
  const accounts = await prisma.platformAccount.findMany({
    select: { id: true, platform: true, displayName: true, status: true, lastSyncAt: true },
  });

  // 各平台汇总（累计口径：取每个内容最新一天的值相加，避免多日重复累计）
  const latestByContent = new Map<string, (typeof metrics)[number]>();
  for (const m of metrics) {
    const key = `${m.platform}:${m.contentKey}`;
    const prev = latestByContent.get(key);
    if (!prev || m.metricDate > prev.metricDate) latestByContent.set(key, m);
  }
  const perPlatform: Record<
    string,
    { platform: string; name: string; contents: number; views: number; clicks: number; likes: number; comments: number; collects: number; shares: number }
  > = {};
  for (const m of latestByContent.values()) {
    const p = (perPlatform[m.platform] = perPlatform[m.platform] || {
      platform: m.platform,
      name: PLATFORM_META[m.platform]?.name || m.platform,
      contents: 0,
      views: 0,
      clicks: 0,
      likes: 0,
      comments: 0,
      collects: 0,
      shares: 0,
    });
    p.contents += 1;
    p.views += m.views;
    p.clicks += m.clicks;
    p.likes += m.likes;
    p.comments += m.comments;
    p.collects += m.collects;
    p.shares += m.shares;
  }

  // 官网站点 PV/UV 天序列
  const siteDays = siteMetrics.map((s) => ({ date: s.metricDate, pv: s.pv, uv: s.uv }));

  // 内容明细（最新一天快照，全量返回；前端做渠道筛选/搜索/分页展示）
  const items = [...latestByContent.values()]
    .sort((a, b) => b.views - a.views)
    .map((m) => ({
      platform: m.platform,
      platformName: PLATFORM_META[m.platform]?.name || m.platform,
      contentKey: m.contentKey,
      title: m.title,
      category: m.category,
      metricDate: m.metricDate,
      views: m.views,
      clicks: m.clicks,
      likes: m.likes,
      comments: m.comments,
      collects: m.collects,
      shares: m.shares,
    }));

  return NextResponse.json({
    ok: true,
    perPlatform: Object.values(perPlatform),
    siteDays,
    items,
    accounts,
    syncedAt: metrics[0]?.updatedAt ?? null,
  });
}
