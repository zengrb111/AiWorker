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
 * - 公众号：mp.weixin.qq.com/s/{sn}（公开文章短链）
 * - 视频号：无公开 Web 链接，返回 null
 */
function originalContentUrl(platform: string, contentKey: string, siteDomain?: string | null): string | null {
  if (platform === "xhs") return `https://www.xiaohongshu.com/explore/${contentKey}`;
  if (platform === "toutiao") return `https://www.toutiao.com/a${contentKey}`;
  if (platform === "wechat") return `https://mp.weixin.qq.com/s/${contentKey}`;
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
  // 官网内容原文链接需要域名（从授权凭据取）；小红书/头条号/公众号用各自标准作品页。
  const siteCred = await loadSiteCredential(user.id).catch(() => null);
  const siteDomain = siteCred?.credential?.domain ?? null;
  // ⚠️ 要取「最近 N 天」必须 desc + take 再翻回升序：
  // 直接 asc + take 拿到的是最旧的 N 天，天数一超上限「官网今日 PV/UV」就会停在旧日期上。
  const siteRecent = await prisma.platformSiteMetric.findMany({
    where: { userId: user.id, platform: "site" },
    orderBy: { metricDate: "desc" },
    take: days,
  });
  const siteMetrics = siteRecent.reverse();
  // 公众号 / 视频号的账号级日指标（涨粉）：单独取，前端「微信生态数据」与「用户维度」区块用。
  // 取足够长的历史，保证最近 30 天窗口聚合不缺数据。
  const dailyRecent = await prisma.platformSiteMetric.findMany({
    where: { userId: user.id, platform: { in: ["wechat", "channels"] } },
    orderBy: { metricDate: "desc" },
    take: Math.max(days * 2, 60),
  });
  // 用户维度「全渠道」粉丝行：公众号 / 视频号 / 小红书 / 头条号 的账号级粉丝快照
  // （不能复用 dailyRecent，它只查微信生态，且被流量矩阵的求和逻辑使用）
  const fanSiteRows = await prisma.platformSiteMetric.findMany({
    where: { userId: user.id, platform: { in: ["wechat", "channels", "xhs", "toutiao"] } },
    orderBy: { metricDate: "desc" },
    take: 800,
  });
  const accounts = await prisma.platformAccount.findMany({
    where: { userId: user.id },
    select: { id: true, platform: true, displayName: true, status: true, lastSyncAt: true },
  });
  // 只展示「已授权」的渠道（流量维度 / 用户维度都用这个集合过滤）。
  // 严格按 PlatformAccount 判定：没有授权记录的渠道一律不出现（含历史数据残留的渠道）。
  const authorizedPlatforms = new Set(accounts.map((a) => a.platform));

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
    { platform: string; name: string; contents: number; views: number; impressions: number; clicks: number; likes: number; comments: number; collects: number; shares: number; readers: number; wows: number }
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
      readers: 0,
      wows: 0,
    });
    p.contents += 1;
    p.views += m.views;
    p.impressions += m.impressions;
    p.clicks += m.clicks;
    p.likes += m.likes;
    p.comments += m.comments;
    p.collects += m.collects;
    p.shares += m.shares;
    p.readers += m.readers;
    p.wows += m.wows;
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
      readers: m.readers,
      wows: m.wows,
      hasSource: withSource.has(`${m.platform}:${m.contentKey}`),
      url: originalContentUrl(m.platform, m.contentKey, siteDomain),
    }));

  // ---------- 时间窗口聚合（昨日 / 最近7天 / 最近30天）----------
  // 各渠道流量矩阵：阅读 / 点赞❤️ / 微信点赞👍 / 评论 / 分享 / 收藏
  // 内容型平台（xhs/toutiao/site）存的是「累计快照」，窗口值 = 窗口内最新快照 − 窗口前最近快照；
  // 微信生态（wechat/channels）存的是「当日值」，窗口值 = 窗口内每日值求和。
  const WECHAT_PLATFORMS = new Set(["wechat", "channels"]);
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const shift = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d;
  };
  /** 对 yyyy-MM-dd 字符串加减天数 */
  const minusDays = (s: string, n: number) => {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1);
    dt.setDate(dt.getDate() - n);
    return ymd(dt);
  };
  const todayStr = ymd(shift(0));
  const windowsDef = [
    { key: "yesterday", start: ymd(shift(-1)), end: ymd(shift(-1)) },
    { key: "last7", start: ymd(shift(-6)), end: todayStr },
    { key: "last30", start: ymd(shift(-29)), end: todayStr },
  ] as const;

  const emptyVec = () => ({ views: 0, likes: 0, wechatLikes: 0, comments: 0, shares: 0, collects: 0 });
  type Vec = ReturnType<typeof emptyVec>;
  const addVec = (a: Vec, b: Partial<Vec>) => {
    a.views += b.views ?? 0;
    a.likes += b.likes ?? 0;
    a.wechatLikes += b.wechatLikes ?? 0;
    a.comments += b.comments ?? 0;
    a.shares += b.shares ?? 0;
    a.collects += b.collects ?? 0;
    return a;
  };

  const windows: Record<string, Record<string, Vec & { name: string }>> = { yesterday: {}, last7: {}, last30: {}, cumulative: {} };

  // 内容型平台：按内容分组累计快照，算窗口增量
  // detailByWindow[window][`platform:contentKey`] = 该内容在该窗口的增量（供「内容效果明细」联动）
  const detailByWindow: Record<string, Record<string, Vec & { metricDate: string }>> = {
    yesterday: {},
    last7: {},
    last30: {},
    cumulative: {},
  };
  const contentByKey = new Map<string, any[]>();
  for (const m of metrics) {
    const k = `${m.platform}:${m.contentKey}`;
    if (!contentByKey.has(k)) contentByKey.set(k, []);
    contentByKey.get(k)!.push(m);
  }
  for (const arr of contentByKey.values()) {
    const platform = arr[0].platform;
    if (WECHAT_PLATFORMS.has(platform)) continue; // 微信生态走站点表
    arr.sort((a, b) => (a.metricDate < b.metricDate ? -1 : a.metricDate > b.metricDate ? 1 : 0));
    for (const w of windowsDef) {
      let end: any = null;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].metricDate <= w.end) {
          end = arr[i];
          break;
        }
      }
      if (!end || end.metricDate < w.start) continue; // 窗口内无数据
      // 基准快照：窗口开始前最近的一次采集。
      // 旧逻辑要求「窗口开始前 3 天内必须有基准」，否则整段窗口跳过——但小红书/头条号
      // 这类低频、断档采集的渠道经常不满足，导致阅读增量被整块吞掉、平台上看不到数据。
      // 现改为：只要有窗口前的基准就照常算增量（明细里会标出真实数据日期，不会误导）。
      let base: any = null;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].metricDate < w.start) {
          base = arr[i];
          break;
        }
      }
      if (!base) continue; // 窗口前完全没有任何基准快照，无法算增量（累计视图会兜底展示）
      const v = emptyVec();
      // 累计快照可能因取消赞/删评而下降，窗口增量按 0 兜底，避免出现负数
      v.views = Math.max(0, end.views - (base?.views ?? 0));
      v.likes = Math.max(0, end.likes - (base?.likes ?? 0));
      v.comments = Math.max(0, end.comments - (base?.comments ?? 0));
      v.shares = Math.max(0, end.shares - (base?.shares ?? 0));
      v.collects = Math.max(0, end.collects - (base?.collects ?? 0));
      const acc = (windows[w.key][platform] =
        windows[w.key][platform] || { ...emptyVec(), name: PLATFORM_META[platform]?.name || platform });
      addVec(acc, v);
      detailByWindow[w.key][`${platform}:${end.contentKey}`] = { ...v, metricDate: end.metricDate };
    }
  }

  // 累计视图：每个内容取「最新快照」的累计值。
  // 小红书 / 头条号这类低频、断档采集的渠道，窗口增量常常算不出（前后快照间隔远超窗口），
  // 累计视图保证「观看数 / 阅读数」本身始终可见，不被窗口算法整块吞掉。
  const cumulativeByPlatform: Record<string, Vec & { name: string }> = {};
  for (const arr of contentByKey.values()) {
    const platform = arr[0].platform;
    if (WECHAT_PLATFORMS.has(platform)) continue; // 微信生态无内容级快照，下方单独处理
    const latest = [...arr].sort((a, b) => (a.metricDate < b.metricDate ? 1 : a.metricDate > b.metricDate ? -1 : 0))[0];
    const acc = (cumulativeByPlatform[platform] =
      cumulativeByPlatform[platform] || { ...emptyVec(), name: PLATFORM_META[platform]?.name || platform });
    addVec(acc, { views: latest.views, likes: latest.likes, comments: latest.comments, shares: latest.shares, collects: latest.collects });
    detailByWindow.cumulative[`${platform}:${latest.contentKey}`] = {
      views: latest.views,
      likes: latest.likes,
      comments: latest.comments,
      shares: latest.shares,
      collects: latest.collects,
      metricDate: latest.metricDate,
    };
  }
  // 微信生态（公众号 / 视频号）：用各平台最新一日的账号级值作为累计（views=阅读数 reads、微信点赞=在看 wows）
  {
    const latestDaily = new Map<string, any>();
    for (const d of dailyRecent) {
      const cur = latestDaily.get(d.platform);
      if (!cur || d.metricDate > cur.metricDate) latestDaily.set(d.platform, d);
    }
    for (const [platform, d] of latestDaily) {
      if (!cumulativeByPlatform[platform]) cumulativeByPlatform[platform] = { ...emptyVec(), name: PLATFORM_META[platform]?.name || platform };
      addVec(cumulativeByPlatform[platform], { views: d.reads, wechatLikes: d.wows, shares: d.shares });
    }
  }
  windows.cumulative = cumulativeByPlatform;

  // 微信生态：PlatformSiteMetric 当日值求和（views 用 reads，微信点赞👍 用 wows/在看）
  for (const w of windowsDef) {
    for (const d of dailyRecent) {
      if (d.metricDate < w.start || d.metricDate > w.end) continue;
      const acc = (windows[w.key][d.platform] =
        windows[w.key][d.platform] || { ...emptyVec(), name: PLATFORM_META[d.platform]?.name || d.platform });
      addVec(acc, { views: d.reads, likes: d.likes, wechatLikes: d.wows, shares: d.shares });
    }
  }

  // 平台自带的窗口总计（微信后台「近7天/近30天」是现成汇总，不是按天数据）：
  // 有 windowsJson 时直接覆盖「按天累加」的结果，避免只有一两天数据时近7天显示成很小的值。
  const winJsonByPlatform = new Map<string, any>();
  for (const d of fanSiteRows) {
    const raw = (d as any).windowsJson;
    if (!raw || winJsonByPlatform.has(d.platform)) continue;
    try {
      winJsonByPlatform.set(d.platform, JSON.parse(raw));
    } catch {
      /* 忽略脏数据 */
    }
  }
  for (const [p, wj] of winJsonByPlatform) {
    const applyWin = (key: "last7" | "last30", src: any) => {
      if (!src) return;
      const cur = windows[key][p] || { ...emptyVec(), name: PLATFORM_META[p]?.name || p };
      windows[key][p] = {
        ...cur,
        views: src.reads ?? cur.views,
        likes: src.likes ?? cur.likes,
        wechatLikes: src.wows ?? cur.wechatLikes,
        shares: src.shares ?? cur.shares,
        comments: src.comments ?? cur.comments,
      };
    };
    applyWin("last7", wj["7"]);
    applyWin("last30", wj["30"]);
    // 平台只给窗口汇总：缺少某个窗口的数据时，不要用「按天累加」冒充（会算小/算错）
    if (!wj["7"]) delete windows.last7[p];
    if (!wj["30"]) delete windows.last30[p];
  }

  // ---------- 粉丝维度（用户维度 tab）----------
  // 全渠道：公众号 / 视频号 / 小红书 / 头条号 都可能有粉丝数据。
  // 有逐日新增（fans）的平台直接求和；只有累计快照（fansTotal）的平台用「窗口末累计 − 窗口前累计」推算。
  const FAN_PLATFORMS = ["wechat", "channels", "xhs", "toutiao"];
  const fanStats = { byPlatform: [] as any[], regions: [] as any[] };
  // 用户维度同样只看已授权渠道（未授权的历史数据不再展示）
  const fanPlatformSet = new Set<string>();
  for (const p of authorizedPlatforms) if (FAN_PLATFORMS.includes(p)) fanPlatformSet.add(p);

  const yStart = ymd(shift(-1));
  const w7Start = ymd(shift(-6));
  const w30Start = ymd(shift(-29));

  for (const p of [...fanPlatformSet].sort()) {
    const recs = fanSiteRows
      .filter((d) => d.platform === p)
      .sort((a, b) => (a.metricDate < b.metricDate ? -1 : 1));
    if (recs.length === 0) {
      // 已授权但还没采到粉丝数据
      fanStats.byPlatform.push({
        platform: p,
        name: PLATFORM_META[p]?.name || p,
        newFansYesterday: 0,
        newFans7: 0,
        newFans30: 0,
        fansTotal: 0,
        hasData: false,
      });
      continue;
    }
    const hasDailyFans = recs.some((d) => d.fans > 0);
    const sumFans = (start: string) =>
      recs.filter((d) => d.metricDate >= start && d.metricDate <= todayStr).reduce((s, d) => s + d.fans, 0);
    // 用累计快照推算窗口新增：窗口内最新快照 − 窗口开始前的最近快照
    const deltaFromTotal = (start: string) => {
      const inWin = recs.filter((d) => d.metricDate >= start && d.metricDate <= todayStr);
      const end = inWin[inWin.length - 1];
      if (!end || end.fansTotal <= 0) return 0;
      const before = recs.filter((d) => d.metricDate < start);
      const base = before[before.length - 1];
      if (!base || base.fansTotal <= 0) return 0; // 缺窗口前基准，无法推算
      return Math.max(0, end.fansTotal - base.fansTotal);
    };
    const newFans = (start: string) => (hasDailyFans ? sumFans(start) : deltaFromTotal(start));
    const latest = recs[recs.length - 1];
    fanStats.byPlatform.push({
      platform: p,
      name: PLATFORM_META[p]?.name || p,
      newFansYesterday: newFans(yStart),
      newFans7: newFans(w7Start),
      newFans30: newFans(w30Start),
      fansTotal: latest?.fansTotal ?? 0,
      hasData: true,
    });
  }
  // 粉丝地域分布：取每个平台最新一天的快照
  const fanRegions = await prisma.platformFanRegion.findMany({
    where: { userId: user.id },
    orderBy: { metricDate: "desc" },
  });
  const regionPlatforms = [...new Set(fanRegions.map((r) => r.platform))];
  for (const p of regionPlatforms) {
    const recs = fanRegions.filter((r) => r.platform === p);
    if (recs.length === 0) continue;
    const latestDate = recs[0].metricDate;
    const provinces = recs
      .filter((r) => r.metricDate === latestDate)
      .map((r) => ({ province: r.province, fans: r.fans }))
      .sort((a, b) => b.fans - a.fans);
    fanStats.regions.push({ platform: p, name: PLATFORM_META[p]?.name || p, metricDate: latestDate, provinces });
  }

  // 内容明细挂上各窗口增量（内容型平台才有；微信生态无内容级数据 → null）
  const itemsWithWindow = items
    .filter((it) => authorizedPlatforms.has(it.platform))
    .map((it) => ({
    ...it,
    byWindow: {
      yesterday: detailByWindow.yesterday[`${it.platform}:${it.contentKey}`] || null,
      last7: detailByWindow.last7[`${it.platform}:${it.contentKey}`] || null,
      last30: detailByWindow.last30[`${it.platform}:${it.contentKey}`] || null,
      cumulative: detailByWindow.cumulative[`${it.platform}:${it.contentKey}`] || null,
    },
  }));

  return NextResponse.json({
    ok: true,
    perPlatform: Object.values(perPlatform),
    siteDays,
    authorizedPlatforms: [...authorizedPlatforms],
    items: itemsWithWindow,
    windows,
    fanStats,
    dailyMetrics: dailyRecent
      .slice()
      .reverse()
      .map((d) => ({
        platform: d.platform,
        metricDate: d.metricDate,
        pv: d.pv,
        uv: d.uv,
        fans: d.fans,
        reads: d.reads,
        shares: d.shares,
        likes: d.likes,
        wows: d.wows,
      })),
    accounts,
    syncedAt: metrics[0]?.updatedAt ?? null,
  });
}
