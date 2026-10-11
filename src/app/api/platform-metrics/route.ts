import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { PLATFORM_META, loadSiteCredential } from "@/lib/platform-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 构造某条平台作品的「原文」链接（新标签页打开，查看实际发布的作品）。
 * - 小红书：笔记网页版 explore/{id}（标准链接）
 * - 头条号：toutiao.com/a{id}（文章/图文标准链接）
 * - 官网：需域名，{domain}/recommend/{id}（好物推荐条目页；格式待与官网对齐确认）
 */
function originalContentUrl(platform: string, contentKey: string, siteDomain?: string | null): string | null {
  if (platform === "xhs") return `https://www.xiaohongshu.com/explore/${contentKey}`;
  if (platform === "toutiao") return `https://www.toutiao.com/a${contentKey}`;
  if (platform === "site" && siteDomain) return `${siteDomain.replace(/\/+$/, "")}/recommend/${contentKey}`;
  return null;
}

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
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 20000,
  });
  // 官网内容原文链接需要域名（从授权凭据取）；小红书/头条号用各自标准作品页。
  const siteCred = await loadSiteCredential(user.id).catch(() => null);
  const siteDomain = siteCred?.credential?.domain ?? null;
  // ⚠️ 要取「最近 N 天」必须 desc + take 再翻回升序：
  // 直接 asc + take 拿到的是最旧的 N 天，天数一超上限「官网今日 PV/UV」就会停在旧日期上。
  const siteRecent = await prisma.platformSiteMetric.findMany({
    where: { userId: user.id },
    orderBy: { metricDate: "desc" },
    take: days,
  });
  const siteMetrics = siteRecent.reverse();
  const accounts = await prisma.platformAccount.findMany({
    where: { userId: user.id },
    select: { id: true, platform: true, displayName: true, status: true, lastSyncAt: true },
  });

  // 已抓到原文的内容（拆解必须基于原文，前端据此决定「拆解」按钮是否可用）
  const sources = await prisma.contentSource.findMany({ select: { platform: true, contentKey: true } });
  const withSource = new Set(sources.map((s) => `${s.platform}:${s.contentKey}`));

  // 各平台汇总（累计口径：取每个内容最新一天的值相加，避免多日重复累计）
  const latestByContent = new Map<string, (typeof metrics)[number]>();
  for (const m of metrics) {
    const key = `${m.platform}:${m.contentKey}`;
    const prev = latestByContent.get(key);
    if (!prev || m.metricDate > prev.metricDate) latestByContent.set(key, m);
  }
  const perPlatform: Record<
    string,
    { platform: string; name: string; contents: number; views: number; impressions: number; clicks: number; likes: number; comments: number; collects: number; shares: number }
  > = {};
  for (const m of latestByContent.values()) {
    const p = (perPlatform[m.platform] = perPlatform[m.platform] || {
      platform: m.platform,
      name: PLATFORM_META[m.platform]?.name || m.platform,
      contents: 0,
      views: 0,
      impressions: 0,
      clicks: 0,
      likes: 0,
      comments: 0,
      collects: 0,
      shares: 0,
    });
    p.contents += 1;
    p.views += m.views;
    p.impressions += m.impressions;
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
      impressions: m.impressions,
      clicks: m.clicks,
      likes: m.likes,
      comments: m.comments,
      collects: m.collects,
      shares: m.shares,
      hasSource: withSource.has(`${m.platform}:${m.contentKey}`),
      url: originalContentUrl(m.platform, m.contentKey, siteDomain),
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
