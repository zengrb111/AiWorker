import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/platform-metrics/ingest —— 本地采集器数据推送入口（Bearer CONTENT_INGEST_TOKEN）。
 * 小红书创作者中心接口有签名风控，数据由本地 CDP 采集器（scripts/xhs-collect.mjs）抓取；
 * 头条号 feed 接口服务端可直连，由 scripts/toutiao-collect.mjs 抓取。
 *
 * Body: { platform: "xhs" | "toutiao" | "wechat" | "channels", notes: [{ id, title, views,
 *         impressions, clicks, likes, comments, collects, shares, readers, wows,
 *         permissionCode, itemStatus }], fans?: number, fanTotal?: number,
 *         summary?: { reads, shares, likes, wows },
 *         regions?: [{ province: string, fans: number }] }
 *
 * fanTotal = 微信生态累计粉丝数快照（公众号/视频号后台「用户分析」可拉取）；
 * regions  = 粉丝按省份分布（微信生态「用户属性/地域分布」可拉取）。两者缺失时静默跳过。
 *
 * 只统计「当前公开可见」的内容：
 *   - 小红书 permissionCode !== 0（如 1「仅自己可见」）→ 丢弃
 *   - 头条号 itemStatus !== 20（草稿/审核未通过/已下架）→ 丢弃
 * 本次未出现的旧记录会被删除，避免已删除内容的效果数据残留虚高。
 *
 * 字段语义：impressions=展现量（头条号 showCount）；clicks=点击量（仅官网有真实统计，
 * 小红书/头条号平台不提供，恒为 0）；readers=阅读人数、wows=在看（公众号）；
 * fans=当日新增关注（公众号 / 视频号账号级涨粉）。
 */
const ALLOWED_PLATFORMS = new Set(["xhs", "toutiao", "wechat", "channels"]);

export async function POST(req: Request) {
  const token = process.env.CONTENT_INGEST_TOKEN || "";
  const auth = req.headers.get("authorization") || "";
  if (!token || auth !== `Bearer ${token}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const platform = String(body?.platform || "").trim();
  const notes: any[] = Array.isArray(body?.notes) ? body.notes : [];
  const bodies: any[] = Array.isArray(body?.bodies) ? body.bodies : [];
  // 视频号等平台只有账号级汇总（无内容级数据），允许 notes 为空、只传 summary
  const hasSummary =
    !!body?.summary ||
    Number.isFinite(Number(body?.fanTotal)) ||
    Number.isFinite(Number(body?.fans));
  if (!ALLOWED_PLATFORMS.has(platform) || (notes.length === 0 && !hasSummary)) {
    return NextResponse.json(
      { ok: false, message: "参数错误：需要 platform，且 notes 与 summary 至少提供一个" },
      { status: 400 }
    );
  }

  const accountId = String(body?.accountId || "").trim();
  const account = await prisma.platformAccount.findFirst({
    where: accountId ? { id: accountId } : { platform, status: { not: "expired" } },
  });
  if (!account) {
    return NextResponse.json({ ok: false, message: "平台尚未授权，请先在「平台授权管理」完成绑定" }, { status: 400 });
  }
  const userId = account.userId;

  const metricDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  // 账号级汇总（阅读/分享/点赞/在看、粉丝快照）的归属日。
  // 微信「内容分析」的 data_range_type=1 对应的是**昨日**（今日数据未跑完），
  // 采集器通过 metricDate 显式传昨天，避免把昨天的数据记到今天。
  const summaryDate = (() => {
    const v = String(body?.metricDate || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : metricDate;
  })();

  let saved = 0;
  let skippedNotPublic = 0;
  let totalViews = 0;
  const liveKeys: string[] = [];
  for (const n of notes) {
    const contentKey = String(n?.id || "").trim();
    if (!contentKey) continue;
    // 可见性过滤：小红书 permission_code=0 才是公开可见；头条号 itemStatus=20 才是已发布
    if (platform === "xhs" && Number(n?.permissionCode ?? 0) !== 0) {
      skippedNotPublic++;
      continue;
    }
    if (platform === "toutiao" && Number(n?.itemStatus ?? 20) !== 20) {
      skippedNotPublic++;
      continue;
    }
    const row = {
      title: String(n.title || "未命名笔记").slice(0, 500),
      views: Number(n.views) || 0,
      impressions: Number(n.impressions) || 0,
      clicks: Number(n.clicks) || 0,
      likes: Number(n.likes) || 0,
      comments: Number(n.comments) || 0,
      collects: Number(n.collects) || 0,
      shares: Number(n.shares) || 0,
      readers: Number(n.readers) || 0,
      wows: Number(n.wows) || 0,
      visible: true,
    };
    totalViews += row.views;
    await prisma.platformContentMetric.upsert({
      where: { userId_platform_contentKey_metricDate: { userId, platform, contentKey, metricDate } },
      update: { ...row, accountId: account.id },
      create: { userId, platform, contentKey, metricDate, accountId: account.id, ...row },
    });
    saved++;
    liveKeys.push(contentKey);
  }

  // 原文入库：拆解必须基于真实原文，这里把采集器抓到的图文正文存进 ContentSource
  let bodiesSaved = 0;
  for (const b of bodies) {
    const contentKey = String(b?.id || "").trim();
    const text = String(b?.body || "").trim();
    if (!contentKey || !text) continue;
    const row = {
      title: String(b.title || "").slice(0, 500),
      body: text,
      topics: b.topics ? String(b.topics).slice(0, 500) : null,
      author: b.author ? String(b.author).slice(0, 200) : null,
      source: "collector",
      fetchedAt: new Date(),
    };
    await prisma.contentSource.upsert({
      where: { platform_contentKey: { platform, contentKey } },
      update: row,
      create: { platform, contentKey, ...row },
    });
    bodiesSaved++;
  }

  // 本次公开列表里没有的旧记录 = 已删除/下架/设为私密，清理掉
  let removed = 0;
  const live = new Set(liveKeys);
  if (live.size > 0) {
    const existing = await prisma.platformContentMetric.findMany({
      where: { userId, platform, accountId: account.id },
      select: { contentKey: true },
      distinct: ["contentKey"],
    });
    // 先算差集再用 in 分块删（对 notIn 分块会误删其他块里仍有效的数据）
    const stale = existing.map((r) => r.contentKey).filter((k) => !live.has(k));
    for (let i = 0; i < stale.length; i += 400) {
      const keys = stale.slice(i, i + 400);
      const r = await prisma.platformContentMetric.deleteMany({
        where: { userId, platform, accountId: account.id, contentKey: { in: keys } },
      });
      removed += r.count;
    }
  }

  // 账号级指标：公众号 / 视频号的新增关注（涨粉）、累计粉丝数快照与互动汇总
  // （这些平台后台只提供账号级汇总，不提供内容级明细，由采集器在 body.summary 里带过来）
  const fans = Number(body?.fans);
  const fanTotal = Number(body?.fanTotal);
  const sm = body?.summary;
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  const summaryPayload: Record<string, number> = {
    ...(Number.isFinite(fans) ? { fans } : {}),
    ...(Number.isFinite(fanTotal) ? { fansTotal: fanTotal } : {}),
    ...(num(sm?.reads) !== undefined ? { reads: num(sm?.reads) } : {}),
    ...(num(sm?.shares) !== undefined ? { shares: num(sm?.shares) } : {}),
    ...(num(sm?.likes) !== undefined ? { likes: num(sm?.likes) } : {}),
    ...(num(sm?.wows) !== undefined ? { wows: num(sm?.wows) } : {}),
  };
  // 平台自带的窗口总计（近7天/近30天）：微信后台给的是现成汇总，不是按天数据，
  // 存成 windowsJson 供流量矩阵直接取用（否则近7天只能累加我们残缺的日行）。
  const normWin = (o: any) => {
    if (!o || typeof o !== "object") return null;
    const out: Record<string, number> = {};
    for (const k of ["reads", "likes", "shares", "wows", "comments"]) {
      const n = Number(o[k]);
      if (Number.isFinite(n)) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  };
  const w7 = normWin(body?.summary7);
  const w30 = normWin(body?.summary30);
  const winObj: Record<string, Record<string, number>> = {};
  if (w7) winObj["7"] = w7;
  if (w30) winObj["30"] = w30;
  const windowsJson = Object.keys(winObj).length ? JSON.stringify(winObj) : null;

  if (Object.keys(summaryPayload).length > 0 || windowsJson) {
    const siteData: any = { ...summaryPayload };
    if (windowsJson) siteData.windowsJson = windowsJson;
    const upsertSite = (data: any) =>
      prisma.platformSiteMetric.upsert({
        where: { userId_platform_metricDate: { userId, platform, metricDate: summaryDate } },
        update: data,
        create: { userId, platform, metricDate: summaryDate, ...data },
      });
    try {
      await upsertSite(siteData);
    } catch {
      // 旧 Prisma client 还不认识 windowsJson（未重新 generate）时降级
      const { windowsJson: _drop, ...rest } = siteData;
      await upsertSite(rest);
    }
  }

  // 粉丝按区域分布（微信生态「用户属性/地域分布」）：批量 upsert 到 PlatformFanRegion
  // 以本次抓到的省份集合为准覆盖当天快照（缺省省份视为 0，当次不写脏数据）。
  let regionRows = 0;
  const regions: any[] = Array.isArray(body?.regions) ? body.regions : [];
  if (regions.length > 0) {
    for (const r of regions) {
      const province = String(r?.province || "").trim();
      const rfans = Number(r?.fans);
      if (!province || !Number.isFinite(rfans)) continue;
      await prisma.platformFanRegion.upsert({
        where: {
          userId_platform_metricDate_province: { userId, platform, metricDate: summaryDate, province },
        },
        update: { fans: rfans },
        create: { userId, platform, metricDate: summaryDate, province, fans: rfans },
      });
      regionRows++;
    }
  }

  // 粉丝逐日增长（微信「用户增长」按天序列）：每天一行，供用户维度按时间窗口统计新增粉丝。
  // fanDays: [{ date: "yyyy-MM-dd", newFans: number, cumulate?: number }]
  let fanDayRows = 0;
  const fanDays: any[] = Array.isArray(body?.fanDays) ? body.fanDays : [];
  for (const d of fanDays) {
    const date = String(d?.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const newFans = Number(d?.newFans);
    const cum = Number(d?.cumulate);
    const payload: Record<string, number> = {};
    if (Number.isFinite(newFans)) payload.fans = Math.max(0, newFans);
    if (Number.isFinite(cum) && cum > 0) payload.fansTotal = cum;
    if (Object.keys(payload).length === 0) continue;
    await prisma.platformSiteMetric.upsert({
      where: { userId_platform_metricDate: { userId, platform, metricDate: date } },
      update: payload,
      create: { userId, platform, metricDate: date, ...payload },
    });
    fanDayRows++;
  }

  const extra = [
    bodiesSaved > 0 ? `原文 ${bodiesSaved} 篇` : "",
    skippedNotPublic > 0 ? `已排除 ${skippedNotPublic} 条非公开内容` : "",
    removed > 0 ? `清理 ${removed} 条不可见残留` : "",
    Number.isFinite(fans) ? `新增关注 ${fans}` : "",
    Number.isFinite(fanTotal) ? `累计粉丝 ${fanTotal}` : "",
    fanDayRows > 0 ? `粉丝逐日 ${fanDayRows} 天` : "",
    regionRows > 0 ? `粉丝地域 ${regionRows} 省` : "",
    num(sm?.reads) !== undefined ? `阅读 ${num(sm?.reads)}` : "",
  ].filter(Boolean).join("；");
  await prisma.platformAccount.update({
    where: { id: account.id },
    data: {
      lastSyncAt: new Date(),
      status: "active",
      statusMsg: `同步成功（${saved} 篇公开笔记，累计浏览 ${totalViews}）${extra ? "；" + extra : ""}`,
    },
  });

  return NextResponse.json({ ok: true, data: { savedCount: saved, bodiesSaved, totalViews, skippedNotPublic, removed } });
}
