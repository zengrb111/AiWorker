import { prisma } from "./prisma";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { decryptCredential } from "./platform-creds";

/**
 * 平台效果数据同步器（按登录用户隔离）。
 * - 官网(site)：每个用户各自在「平台授权管理」配置自己的官网域名 + 令牌，
 *   同步时用该用户的凭据拉官网统计接口（/api/stats）。
 * - 小红书(xhs) / 头条号(toutiao)：无个人可申请的内容数据开放 API，
 *   采用创作者后台 Cookie 授权（业界通行做法），凭据加密存储后真实请求平台接口。
 *   平台接口有签名/风控不确定性，验证器按候选端点轮询，失败如实记录到账号状态。
 */

export const PLATFORM_META: Record<string, { name: string; desc: string; cookieGuide: string; needsToken?: boolean }> = {
  site: {
    name: "官网",
    desc: "和光万象官网（好物推荐）或 AI回忆录官网（心灵驿站），配置域名 + 令牌后可用",
    cookieGuide:
      "填写官网域名与令牌（Bearer Token），保存时会自动识别类型：\n· 好物推荐：https://hgwx.aimemory.cafe（拉取统计数据）\n· 心灵驿站：https://aimemory.cafe（推送图文到「心灵驿站」频道）\n令牌在对应官网后台的开放接口处获取。",
    needsToken: true,
  },
  healing: {
    name: "官网-AI回忆录",
    desc: "AI回忆录官网心灵驿站频道（aimemory.cafe），授权后可把图文推送到该频道",
    cookieGuide:
      "填写 https://aimemory.cafe 与心灵驿站令牌（Bearer Token）。\n保存时会真实调用 /api/healing/sync-log 校验令牌。\n授权后，内容库详情页即可「推送心灵驿站」；该频道无流量统计，不影响官网统计授权。",
    needsToken: true,
  },
  xhs: {
    name: "小红书",
    desc: "创作者中心数据授权",
    cookieGuide:
      "电脑浏览器打开 creator.xiaohongshu.com 登录 → F12 打开开发者工具 → Network 面板刷新页面 → 任选一个请求 → 复制 Request Headers 里完整的 Cookie 值粘贴到下面",
  },
  toutiao: {
    name: "头条号",
    desc: "头条号后台数据授权",
    cookieGuide:
      "电脑浏览器打开 mp.toutiao.com 登录 → F12 打开开发者工具 → Network 面板刷新页面 → 任选一个请求 → 复制 Request Headers 里完整的 Cookie 值粘贴到下面",
  },
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchWithCookie(url: string, cookie: string, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const host = new URL(url).host;
    return await fetch(url, {
      headers: {
        "User-Agent": UA,
        Cookie: cookie,
        Accept: "application/json",
        // 小红书 galaxy 接口校验 Referer，缺失会返回 code:-1
        Referer: `https://${host}/`,
        Origin: `https://${host}`,
      },
      redirect: "manual",
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

export type VerifyResult =
  | { ok: true; displayName: string; externalId: string; siteKind?: SiteKind }
  | { ok: false; message: string };

/**
 * 官网类型：
 * - hgwx：和光万象官网（hgwx.aimemory.cafe），Bearer 令牌 + GET /api/stats 拉统计
 * - healing：AI回忆录官网「心灵驿站」频道（aimemory.cafe），Bearer 令牌 + POST /api/healing/sync 推图文
 */
export type SiteKind = "hgwx" | "healing";

export type SiteCredential = { domain: string; token: string; kind: SiteKind };

/** 域名推断官网类型（老凭据没有 kind 字段时兜底） */
export function inferSiteKind(domain: string): SiteKind {
  let host = domain;
  try { host = new URL(domain).host; } catch { /* 保留原串 */ }
  if (/^hgwx\./i.test(host)) return "hgwx";
  if (/aimemory\.cafe$/i.test(host)) return "healing";
  return "hgwx";
}

/** 小红书凭据验证：候选端点轮询 */
async function verifyXhs(cookie: string): Promise<VerifyResult> {
  const candidates: Array<{ url: string; parse: (j: any) => VerifyResult | null }> = [
    {
      // 创作者中心用户信息
      url: "https://creator.xiaohongshu.com/api/galaxy/user/info",
      parse: (j) => {
        const u = j?.data;
        if (u && (u.user_id || u.userId || u.nickname)) {
          return {
            ok: true,
            displayName: String(u.nickname || u.red_id || "小红书创作者"),
            externalId: String(u.user_id || u.userId || u.red_id || ""),
          };
        }
        return null;
      },
    },
    {
      // Web 端登录态
      url: "https://www.xiaohongshu.com/api/sns/web/v2/user/me",
      parse: (j) => {
        const u = j?.data;
        if (u && (u.user_id || u.userId)) {
          return {
            ok: true,
            displayName: String(u.nickname || "小红书创作者"),
            externalId: String(u.user_id || u.userId),
          };
        }
        return null;
      },
    },
  ];
  return verifyViaCandidates(candidates, cookie, "小红书");
}

/** 头条号凭据验证 */
async function verifyToutiao(cookie: string): Promise<VerifyResult> {
  const candidates: Array<{ url: string; parse: (j: any) => VerifyResult | null }> = [
    {
      // 创作者中心用户信息（同步链路同款端点，顶层就有 name/user_id）
      url: "https://mp.toutiao.com/mp/agw/creator_center/user_info?app_id=1231",
      parse: (j) => {
        if (j?.code !== 0) return null;
        const name = j.name || j.screen_name || j.nickname;
        const uid = j.user_id_str || j.user_id || j.media_id || "";
        return {
          ok: true,
          displayName: String(name || "头条号创作者"),
          externalId: String(uid || name || ""),
        };
      },
    },
    {
      // 媒体基础信息：code=0 即登录态有效（无昵称字段，仅做兜底判定）
      url: "https://mp.toutiao.com/mp/agw/media/get_user_base_info",
      parse: (j) => {
        if (j?.code !== 0) return null;
        const u = j?.data;
        const name = u && (u.name || u.screen_name || u.nickname);
        const uid = u && (u.user_id || u.uid);
        return {
          ok: true,
          displayName: String(name || "头条号创作者"),
          externalId: String(uid || name || ""),
        };
      },
    },
  ];
  return verifyViaCandidates(candidates, cookie, "头条号");
}

async function verifyViaCandidates(
  candidates: Array<{ url: string; parse: (j: any) => VerifyResult | null }>,
  cookie: string,
  label: string
): Promise<VerifyResult> {
  const errors: string[] = [];
  for (const c of candidates) {
    try {
      const res = await fetchWithCookie(c.url, cookie);
      if (res.status === 301 || res.status === 302) {
        errors.push(`${new URL(c.url).host} 重定向到登录页`);
        continue;
      }
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        errors.push(`${new URL(c.url).host} 返回非 JSON（HTTP ${res.status}）`);
        continue;
      }
      const parsed = c.parse(json);
      if (parsed) return parsed;
      errors.push(
        `${new URL(c.url).host} 响应 ${json?.code ?? json?.message ?? "无法识别登录态"}`
      );
    } catch (e) {
      errors.push(`${new URL(c.url).host} 请求失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: false, message: `${label}凭据验证未通过：${errors.join("；")}` };
}

/**
 * 验证官网凭据：用域名 + 令牌真实请求，自动识别官网类型。
 * 1) 和光万象官网「好物推荐」：GET /api/stats（Bearer）
 * 2) AI回忆录官网「心灵驿站」：GET /api/healing/sync-log（Bearer，需令牌）
 * 任一路径通过即判定有效；两者都不通时如实返回各自失败原因。
 */
export async function verifySiteCredential(domain: string, token: string): Promise<VerifyResult> {
  const base = domain.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return { ok: false, message: "官网域名需以 http(s):// 开头" };
  let host = base;
  try { host = new URL(base).host; } catch { /* 保留原串 */ }
  const errors: string[] = [];

  // 1) 和光万象官网（好物推荐）
  try {
    const res = await fetch(`${base}/api/stats`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data?.ok) return { ok: true, displayName: `${host}（好物推荐）`, externalId: "", siteKind: "hgwx" };
      errors.push("和光万象 /api/stats 返回异常");
    } else {
      errors.push(`和光万象 /api/stats HTTP ${res.status}`);
    }
  } catch (e) {
    errors.push(`和光万象连接失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) AI回忆录官网 · 心灵驿站（写入接口需令牌，用它验证令牌有效性）
  try {
    const res = await fetch(`${base}/api/healing/sync-log?limit=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const meta = await fetch(`${base}/api/healing/meta`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const total = typeof meta?.total === "number" ? `已收录 ${meta.total} 篇` : "";
      return { ok: true, displayName: `${host} · 心灵驿站${total ? `（${total}）` : ""}`, externalId: "", siteKind: "healing" };
    }
    if (res.status === 401 || res.status === 403) errors.push("心灵驿站令牌无效");
    else errors.push(`心灵驿站 /api/healing/sync-log HTTP ${res.status}`);
  } catch (e) {
    errors.push(`心灵驿站连接失败：${e instanceof Error ? e.message : String(e)}`);
  }

  return { ok: false, message: `官网凭据验证未通过：${errors.join("；")}` };
}

/**
 * 读取当前用户的官网凭据（域名 / 令牌 / 类型）。
 * 兼容早先只存 {domain,token} 的老凭据：按域名推断类型。
 */
export async function loadSiteCredential(
  userId: string
): Promise<{ accountId: string; credential: SiteCredential } | null> {
  const account = await prisma.platformAccount.findFirst({
    where: { userId, platform: "site", status: { not: "expired" } },
    orderBy: { createdAt: "asc" },
  });
  if (!account?.credentialEnc) return null;
  const parsed = parseTokenCredential(account.credentialEnc);
  if (!parsed) return null;
  return { accountId: account.id, credential: parsed };
}

/** 解析 {domain,token,kind} 凭据（老数据缺 kind 时按域名推断） */
function parseTokenCredential(credentialEnc: string): SiteCredential | null {
  let parsed: { domain?: string; token?: string; kind?: string };
  try {
    parsed = JSON.parse(decryptCredential(credentialEnc));
  } catch {
    return null;
  }
  const domain = String(parsed.domain || "").replace(/\/+$/, "");
  const token = String(parsed.token || "");
  if (!domain || !token) return null;
  const kind: SiteKind = parsed.kind === "healing" || parsed.kind === "hgwx" ? parsed.kind : inferSiteKind(domain);
  return { domain, token, kind };
}

/**
 * 读取「心灵驿站」推送用的凭据：
 * 1) 优先取专用授权（platform = healing）
 * 2) 回退到官网卡片里配置的 aimemory.cafe（kind = healing）
 */
export async function loadHealingCredential(
  userId: string
): Promise<{ accountId: string; credential: SiteCredential } | null> {
  const dedicated = await prisma.platformAccount.findFirst({
    where: { userId, platform: "healing", status: { not: "expired" } },
  });
  if (dedicated?.credentialEnc) {
    const parsed = parseTokenCredential(dedicated.credentialEnc);
    if (parsed) return { accountId: dedicated.id, credential: { ...parsed, kind: "healing" } };
  }
  const site = await loadSiteCredential(userId);
  if (site && site.credential.kind === "healing") return site;
  return null;
}

/** 验证「心灵驿站」专用授权：GET /api/healing/sync-log（需令牌）+ /meta 拿频道信息 */
export async function verifyHealingCredential(domain: string, token: string): Promise<VerifyResult> {
  const base = domain.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return { ok: false, message: "官网域名需以 http(s):// 开头" };
  let host = base;
  try { host = new URL(base).host; } catch { /* 保留原串 */ }
  try {
    const res = await fetch(`${base}/api/healing/sync-log?limit=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, message: "心灵驿站令牌无效" };
    if (!res.ok) return { ok: false, message: `心灵驿站接口 HTTP ${res.status}（请确认域名已部署心灵驿站频道）` };
    const meta = await fetch(`${base}/api/healing/meta`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const total = typeof meta?.total === "number" ? `已收录 ${meta.total} 篇` : "";
    return { ok: true, displayName: `${host} · 心灵驿站${total ? `（${total}）` : ""}`, externalId: "", siteKind: "healing" };
  } catch (e) {
    return { ok: false, message: `心灵驿站连接失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 验证平台凭据（绑定前调用） */
export async function verifyPlatformCredential(platform: string, cookie: string): Promise<VerifyResult> {
  if (platform === "xhs") return verifyXhs(cookie);
  if (platform === "toutiao") return verifyToutiao(cookie);
  return { ok: false, message: `平台 ${platform} 不支持 Cookie 授权` };
}

/* ------------------------------------------------------------------ *
 * 效果数据同步
 * ------------------------------------------------------------------ */

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 去 HTML 标签并压缩空白（头条号 feed 里的标题/正文是富文本片段） */
function stripHtml(input: unknown): string {
  return String(input || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** 从头条号 feed 的富文本里抽话题标签（#xxx） */
function extractToutiaoTopics(cell: { richContentInfo?: { richContent?: string } }): string {
  const text = String(cell?.richContentInfo?.richContent || "");
  const out: string[] = [];
  const re = /#([^#\s，。！？、]{1,30})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[1].trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 12).join(",");
}

async function upsertContentMetric(row: {
  platform: string;
  contentKey: string;
  title: string;
  category?: string | null;
  accountId?: string | null;
  userId: string;
  views: number;
  impressions?: number;
  clicks: number;
  likes?: number;
  comments?: number;
  collects?: number;
  shares?: number;
}) {
  const metricDate = todayKey();
  await prisma.platformContentMetric.upsert({
    where: {
      userId_platform_contentKey_metricDate: {
        userId: row.userId,
        platform: row.platform,
        contentKey: row.contentKey,
        metricDate,
      },
    },
    update: {
      title: row.title,
      views: row.views,
      impressions: row.impressions ?? 0,
      clicks: row.clicks,
      likes: row.likes ?? 0,
      comments: row.comments ?? 0,
      collects: row.collects ?? 0,
      shares: row.shares ?? 0,
      accountId: row.accountId ?? null,
      visible: true,
    },
    create: {
      platform: row.platform,
      contentKey: row.contentKey,
      metricDate,
      userId: row.userId,
      title: row.title,
      category: row.category ?? null,
      accountId: row.accountId ?? null,
      views: row.views,
      impressions: row.impressions ?? 0,
      clicks: row.clicks,
      likes: row.likes ?? 0,
      comments: row.comments ?? 0,
      collects: row.collects ?? 0,
      shares: row.shares ?? 0,
      visible: true,
    },
  });
}

/**
 * 同步收尾：把「本次公开列表里没有的」旧记录删掉。
 * 平台内容被删除 / 下架 / 设为仅自己可见后，接口不再返回，
 * 但库里历史 metric 会残留，导致效果数据虚高。这里按 contentKey 差集真删。
 * 返回被清理的条数。
 */
async function pruneStaleMetrics(platform: string, accountId: string | null, liveKeys: string[]): Promise<number> {
  if (liveKeys.length === 0) return 0;
  const live = new Set(liveKeys);
  const scope = { platform, ...(accountId ? { accountId } : {}) };
  const existing = await prisma.platformContentMetric.findMany({
    where: scope,
    select: { contentKey: true },
    distinct: ["contentKey"],
  });
  // 先算出差集，再用 in 分块删。
  // 注意：不能对 notIn 做分块 —— 每一块的 notIn 会把其他块里仍然有效的数据当成「陈旧」删掉。
  const stale = existing.map((r) => r.contentKey).filter((k) => !live.has(k));
  if (stale.length === 0) return 0;
  let removed = 0;
  for (let i = 0; i < stale.length; i += 400) {
    const keys = stale.slice(i, i + 400);
    const r = await prisma.platformContentMetric.deleteMany({
      where: { ...scope, contentKey: { in: keys } },
    });
    removed += r.count;
  }
  return removed;
}

/** 官网渠道：拉当前用户配置的官网统计接口写入本地库（站点 PV/UV + 内容浏览/点击） */
export async function syncSiteMetrics(userId: string): Promise<{ ok: boolean; message: string; items?: number }> {
  const account = await prisma.platformAccount.findFirst({
    where: { userId, platform: "site", status: { not: "expired" } },
  });
  if (!account?.credentialEnc) {
    return { ok: false, message: "官网尚未授权，请先在「平台授权管理」完成配置" };
  }
  const loaded = await loadSiteCredential(userId);
  if (!loaded) {
    await markAccountError(account.id, "官网凭据不完整或解密失败，请重新配置");
    return { ok: false, message: "官网凭据不完整或解密失败" };
  }
  const { domain, token, kind } = loaded.credential;

  // 心灵驿站官网：只有内容推送接口，没有流量统计 → 明确跳过，不当作失败。
  if (kind === "healing") {
    await prisma.platformAccount.update({
      where: { id: account.id },
      data: { lastSyncAt: new Date(), status: "active", statusMsg: "官网（心灵驿站）仅支持内容推送，暂无流量统计" },
    });
    return { ok: true, message: "官网（心灵驿站）仅支持内容推送，暂无流量统计接口，已跳过" };
  }

  try {
    const res = await fetch(`${domain}/api/stats`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, message: `官网统计接口 HTTP ${res.status}` };
    const data = await res.json();
    if (!data?.ok) return { ok: false, message: "官网统计接口返回异常，请检查令牌" };
    // 官网统计接口只给 todayPv，没有 todayUv；site.uv 是**累计** UV。
    // 早先把 todayPv 和累计 uv 一起写进当天的行，导致「今日 UV > 今日 PV」这种矛盾。
    // 正确做法：按接口给的逐日数据（site.days[]）逐天写入，PV/UV 口径才能对齐。
    const dayList: Array<{ date?: unknown; pv?: unknown; uv?: unknown }> = Array.isArray(data.site?.days) ? data.site.days : [];
    let siteDays = 0;
    for (const d of dayList) {
      const date = String(d?.date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const payload = { pv: Number(d.pv) || 0, uv: Number(d.uv) || 0 };
      await prisma.platformSiteMetric.upsert({
        where: { userId_platform_metricDate: { userId, platform: "site", metricDate: date } },
        update: payload,
        create: { userId, platform: "site", metricDate: date, ...payload },
      });
      siteDays++;
    }
    // 兜底：接口没返回 days 时，只补今日 PV（UV 未知，不要拿累计值冒充）
    if (siteDays === 0 && typeof data.site?.todayPv === "number") {
      const metricDate = todayKey();
      await prisma.platformSiteMetric.upsert({
        where: { userId_platform_metricDate: { userId, platform: "site", metricDate } },
        update: { pv: data.site.todayPv },
        create: { userId, platform: "site", metricDate, pv: data.site.todayPv, uv: 0 },
      });
      siteDays = 1;
    }
    const items: any[] = data.items || [];
    for (const it of items) {
      await upsertContentMetric({
        platform: "site",
        contentKey: it.id,
        title: it.title || "",
        category: it.category || null,
        views: it.views || 0,
        clicks: it.clicks || 0,
        userId,
        accountId: account.id,
      });
    }
    // 原文入库：官网内容的正文在本地内容库（PublishRecord → ContentItem）
    const records = await prisma.publishRecord.findMany({
      where: { status: "SUCCESS" },
      select: { remoteId: true, title: true, contentItemId: true },
    });
    let bodies = 0;
    for (const rec of records) {
      if (!rec.remoteId) continue;
      const item = await prisma.contentItem.findUnique({ where: { id: rec.contentItemId } });
      const text = String(item?.body || "").trim();
      if (text.length < 30) continue;
      const payload = {
        title: String(rec.title || item?.title || "").slice(0, 500),
        body: text.slice(0, 20000),
        topics: null,
        author: null,
        source: "content-item",
        fetchedAt: new Date(),
      };
      await prisma.contentSource.upsert({
        where: { platform_contentKey: { platform: "site", contentKey: rec.remoteId } },
        update: payload,
        create: { platform: "site", contentKey: rec.remoteId, ...payload },
      });
      bodies++;
    }
    await prisma.platformAccount.update({
      where: { id: account.id },
      data: {
        lastSyncAt: new Date(),
        status: "active",
        statusMsg: `同步成功（${items.length} 条内容${siteDays ? `，站点流量 ${siteDays} 天` : ""}${bodies ? `，原文 ${bodies} 篇` : ""}）`,
      },
    });
    return {
      ok: true,
      message: `官网数据同步完成：${items.length} 条内容${siteDays ? `，站点流量 ${siteDays} 天` : ""}${bodies ? `，原文 ${bodies} 篇` : ""}`,
      items: items.length,
    };
  } catch (e) {
    await markAccountError(account.id, `同步失败：${e instanceof Error ? e.message : String(e)}`).catch(() => {});
    return { ok: false, message: `官网数据同步失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 小红书渠道：用授权 Cookie 拉创作者中心笔记数据 */
export async function syncXhsMetrics(accountId: string): Promise<{ ok: boolean; message: string; items?: number }> {
  const account = await prisma.platformAccount.findUnique({ where: { id: accountId } });
  if (!account?.credentialEnc) return { ok: false, message: "账号缺少凭据" };
  const { decryptCredential } = await import("./platform-creds");
  let cookie: string;
  try {
    cookie = decryptCredential(account.credentialEnc);
  } catch {
    await markAccountError(accountId, "凭据解密失败，请重新绑定");
    return { ok: false, message: "凭据解密失败" };
  }
  // 创作者中心笔记数据接口有 x-s 签名风控，服务端直连会被 406。
  // 先用无签名的 user/info 验证凭据有效性：
  try {
    const res = await fetchWithCookie("https://creator.xiaohongshu.com/api/galaxy/user/info", cookie);
    const json = await res.json().catch(() => null);
    if (json?.data?.userId) {
      // 凭据有效。笔记明细数据由本地采集器（scripts/xhs-collect.mjs，CDP 真实浏览器通道）推送入库。
      const synced = await prisma.platformContentMetric.count({ where: { platform: "xhs", accountId } });
      const triggered = triggerXhsCollector(cookie, accountId);
      await prisma.platformAccount.update({
        where: { id: accountId },
        data: {
          lastSyncAt: new Date(),
          status: "active",
          statusMsg: triggered
            ? "凭据有效；已触发本地采集器回填笔记数据（约需几分钟）"
            : synced > 0
              ? `凭据有效；已有 ${synced} 篇笔记数据`
              : "凭据有效；笔记数据采集器已在运行中，稍后自动入库",
        },
      });
      return {
        ok: true,
        message: `小红书凭据有效（${json.data.userName || account.displayName}）${triggered ? "；已触发本地采集器回填笔记数据" : ""}`,
        items: synced,
      };
    }
    await markAccountError(accountId, `凭据已失效（平台响应 ${json?.code ?? res.status}），请重新授权`);
    return { ok: false, message: "凭据失效，请重新授权" };
  } catch (e) {
    await markAccountError(accountId, `请求失败：${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, message: "小红书数据同步失败（详见账号状态）" };
  }
}

/**
 * 把库内 Cookie 同步到采集器文件并后台拉起 scripts/xhs-collect.mjs（CDP 采集 → ingest 入库）。
 * 用时间戳锁文件防止重复拉起（10 分钟内视为仍在运行）。
 */
function triggerXhsCollector(cookie: string, accountId: string): boolean {
  const root = process.cwd();
  const cookieFile = path.join(root, ".xhs-cookie.txt");
  const lockFile = path.join(root, ".xhs-collect.lock");
  try {
    const lockStat = fs.existsSync(lockFile) ? fs.statSync(lockFile) : null;
    if (lockStat && Date.now() - lockStat.mtimeMs < 10 * 60 * 1000) return false;
    fs.writeFileSync(cookieFile, cookie, "utf8");
    fs.writeFileSync(lockFile, String(Date.now()), "utf8");
    const child = spawn(
      process.execPath,
      [path.join(root, "scripts", "xhs-collect.mjs")],
      { cwd: root, detached: true, stdio: "ignore", env: { ...process.env, ACCOUNT_ID: accountId } }
    );
    child.on("exit", () => {
      try { fs.unlinkSync(lockFile); } catch {}
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 头条号渠道：feed 接口服务端带 Cookie 直连可用（无签名风控），offset 计数翻页拉全量 */
export async function syncToutiaoMetrics(accountId: string): Promise<{ ok: boolean; message: string; items?: number }> {
  const account = await prisma.platformAccount.findUnique({ where: { id: accountId } });
  if (!account?.credentialEnc) return { ok: false, message: "账号缺少凭据" };
  const { decryptCredential } = await import("./platform-creds");
  let cookie: string;
  try {
    cookie = decryptCredential(account.credentialEnc);
  } catch {
    await markAccountError(accountId, "凭据解密失败，请重新绑定");
    return { ok: false, message: "凭据解密失败" };
  }

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    Cookie: cookie,
    Referer: "https://mp.toutiao.com/profile_v4/manage/content/all",
    Accept: "application/json",
  };
  const fetchJson = async (url: string) => {
    const res = await fetchWithCookie(url, cookie);
    if (res.status === 301 || res.status === 302 || res.status === 401) return { expired: true as const, json: null };
    return { expired: false as const, json: await res.json().catch(() => null) };
  };

  // 凭据校验（带 Referer 的 galaxy 端点）+ 拿账号信息
  const infoRes = await fetchJson("https://mp.toutiao.com/mp/agw/creator_center/user_info?app_id=1231");
  if (infoRes.expired) {
    await markAccountError(accountId, "凭据已失效，请重新授权");
    return { ok: false, message: "凭据失效，请重新授权" };
  }
  const info = infoRes.json;
  if (!info || info.code !== 0 || !info.user_id) {
    await markAccountError(accountId, `凭据已失效（平台响应 ${JSON.stringify(info).slice(0, 80)}），请重新授权`);
    return { ok: false, message: "凭据失效，请重新授权" };
  }

  // feed 全量翻页（offset = 已加载条数）
  const base = "https://mp.toutiao.com/api/feed/mp_provider/v1/?provider_type=mp_provider&aid=13&app_name=news_article&category=mp_all&channel=&stream_api_version=88"
    + "&genre_type_switch=%7B%22repost%22%3A1%2C%22small_video%22%3A1%2C%22toutiao_graphic%22%3A1%2C%22weitoutiao%22%3A1%2C%22xigua_video%22%3A1%7D"
    + `&device_platform=pc&platform_id=0&visited_uid=${info.user_id}&count=20&keyword=&app_id=1231`
    + '&client_extra_params=%7B%22category%22%3A%22mp_all%22%2C%22real_app_id%22%3A%221231%22%2C%22need_forward%22%3A%22true%22%2C%22offset_mode%22%3A%221%22%2C%22page_index%22%3A%22REPLACE_PAGE%22%2C%22status%22%3A%228%22%2C%22source%22%3A%220%22%7D';

  const byId = new Map<
    string,
    { title: string; views: number; impressions: number; clicks: number; likes: number; comments: number; collects: number; shares: number; hasVideo: boolean; body: string; topics: string }
  >();
  let consecutiveEmpty = 0;
  let skippedNotPublic = 0;
  for (let i = 0; i < 200; i++) {
    const res = await fetchJson(base.replace("REPLACE_PAGE", String(i + 1)) + `&offset=${byId.size}`);
    if (res.expired) {
      await markAccountError(accountId, "凭据已失效，请重新授权");
      return { ok: false, message: "凭据失效，请重新授权" };
    }
    const cells = (res.json?.data || []).map((d: any) => d?.assembleCell?.itemCell).filter(Boolean);
    let added = 0;
    for (const cell of cells) {
      // 只统计「当前公开可见」的内容：itemStatus=20 为已发布且对外可见，
      // 10/25/40 等为草稿 / 审核未通过 / 已下架，接口仍会返回但不该计入效果数据。
      if (Number(cell?.articleBase?.itemStatus ?? -1) !== 20) {
        skippedNotPublic++;
        continue;
      }
      const urls = [cell?.shareInfo?.shareURL, cell?.articleBase?.articleURL].filter(Boolean).join(" ");
      const m = /\/(?:a|i)(\d{10,})\/?/.exec(urls) || /thread\/(\d{10,})/.exec(urls);
      if (!m || byId.has(m[1])) continue;
      const c = cell.itemCounter || {};
      const title = String(
        String(cell.richContentInfo?.titleRichSpan || "").replace(/<[^>]+>/g, "").trim()
        || String(cell.articleBase?.content || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
        || "未命名内容",
      ).slice(0, 120);
      byId.set(m[1], {
        title,
        // 阅读（图文 readCount）+ 播放（视频 videoWatchCount）
        views: Number(c.readCount || 0) + Number(c.videoWatchCount || 0),
        // showCount 是「展现量」（推荐曝光数），不是点击量，另行存字段
        impressions: Number(c.showCount || 0),
        // 头条号后台不提供真实点击数，置 0 避免与展现量混淆
        clicks: 0,
        likes: Number(c.diggCount || 0),
        comments: Number(c.commentCount || 0),
        collects: Number(c.repinCount || 0),
        shares: 0,
        // 图文（微头条）的正文就在 feed 里；视频没有可拆解的文本
        hasVideo: !!cell.containsElements?.hasVideo,
        body: stripHtml(cell.articleBase?.content || cell.richContentInfo?.richContent || ""),
        topics: extractToutiaoTopics(cell),
      });
      added++;
    }
    if (cells.length === 0 || added === 0 || !res.json?.has_more) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3 || !res.json?.has_more) break;
    } else {
      consecutiveEmpty = 0;
    }
    await new Promise((r) => setTimeout(r, 280));
  }

  if (byId.size === 0) {
    await markAccountError(accountId, "feed 未返回内容（可能凭据受限），请重试或重新授权");
    return { ok: false, message: "头条号未返回内容" };
  }

  for (const [contentKey, row] of byId) {
    await upsertContentMetric({ platform: "toutiao", contentKey, accountId, userId: account.userId, ...row });
  }
  // 原文入库：图文（微头条）的正文 feed 里就有，存下来供拆解使用；
  // 视频没有可拆解的文本，不写原文记录（前端据此禁用拆解）。
  let bodies = 0;
  for (const [contentKey, row] of byId) {
    if (row.hasVideo) continue;
    if (row.body.length < 15) continue;
    const payload = {
      title: row.title.slice(0, 500),
      body: row.body.slice(0, 20000),
      topics: row.topics || null,
      author: null,
      source: "feed",
      fetchedAt: new Date(),
    };
    await prisma.contentSource.upsert({
      where: { platform_contentKey: { platform: "toutiao", contentKey } },
      update: payload,
      create: { platform: "toutiao", contentKey, ...payload },
    });
    bodies++;
  }
  // 已删除 / 下架的内容本次不再出现，清掉历史残留，避免效果数据虚高
  const removed = await pruneStaleMetrics("toutiao", accountId, [...byId.keys()]);
  const totalViews = [...byId.values()].reduce((s, r) => s + r.views, 0);
  const totalImpressions = [...byId.values()].reduce((s, r) => s + r.impressions, 0);
  const extra = [
    bodies > 0 ? `原文 ${bodies} 篇` : "",
    skippedNotPublic > 0 ? `已排除 ${skippedNotPublic} 条非公开内容` : "",
    removed > 0 ? `清理 ${removed} 条已下架残留` : "",
  ].filter(Boolean).join("；");
  await prisma.platformAccount.update({
    where: { id: accountId },
    data: {
      lastSyncAt: new Date(),
      status: "active",
      statusMsg: `同步成功（${byId.size} 条公开内容，阅读+播放 ${totalViews}，展现 ${totalImpressions}）${extra ? "；" + extra : ""}`,
    },
  });
  return { ok: true, message: `头条号数据同步完成：${byId.size} 条公开可见内容${extra ? "（" + extra + "）" : ""}`, items: byId.size };
}

async function markAccountError(accountId: string, msg: string) {
  await prisma.platformAccount
    .update({ where: { id: accountId }, data: { status: "error", statusMsg: msg.slice(0, 500) } })
    .catch(() => {});
}

/** 同步当前用户全部渠道：官网 + 该用户已授权的账号 */
export async function syncAllPlatforms(userId: string) {
  const results: Array<{ platform: string; ok: boolean; message: string; items?: number }> = [];
  results.push({ platform: "site", ...(await syncSiteMetrics(userId)) });
  const accounts = await prisma.platformAccount.findMany({
    where: { userId, platform: { in: ["xhs", "toutiao"] }, status: { not: "expired" } },
  });
  for (const acc of accounts) {
    if (acc.platform === "xhs") results.push({ platform: "xhs", ...(await syncXhsMetrics(acc.id)) });
    if (acc.platform === "toutiao") results.push({ platform: "toutiao", ...(await syncToutiaoMetrics(acc.id)) });
  }
  return results;
}
