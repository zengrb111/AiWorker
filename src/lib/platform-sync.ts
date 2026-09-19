import { prisma } from "./prisma";

/**
 * 平台效果数据同步器。
 * - 官网(site)：无需授权，用服务端 HGWX_PUBLISH_TOKEN 拉官网统计接口，真实数据。
 * - 小红书(xhs) / 头条号(toutiao)：无个人可申请的内容数据开放 API，
 *   采用创作者后台 Cookie 授权（业界通行做法），凭据加密存储后真实请求平台接口。
 *   平台接口有签名/风控不确定性，验证器按候选端点轮询，失败如实记录到账号状态。
 */

export const PLATFORM_META: Record<string, { name: string; desc: string; cookieGuide: string }> = {
  site: {
    name: "官网",
    desc: "和光万象官网 hgwx.aimemory.cafe",
    cookieGuide: "",
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
  | { ok: true; displayName: string; externalId: string }
  | { ok: false; message: string };

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
      // 头条号后台账号信息
      url: "https://mp.toutiao.com/mp/agw/media/get_user_base_info",
      parse: (j) => {
        const u = j?.data;
        if (u && (u.name || u.screen_name || u.user_id)) {
          return {
            ok: true,
            displayName: String(u.name || u.screen_name || "头条号创作者"),
            externalId: String(u.user_id || u.uid || u.name || ""),
          };
        }
        return null;
      },
    },
    {
      // 创作者主页信息（部分版本端点）
      url: "https://mp.toutiao.com/mp/agw/user/base_info",
      parse: (j) => {
        const u = j?.data?.user;
        if (u && (u.name || u.user_id)) {
          return {
            ok: true,
            displayName: String(u.name || "头条号创作者"),
            externalId: String(u.user_id || u.uid || ""),
          };
        }
        return null;
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

async function upsertContentMetric(row: {
  platform: string;
  contentKey: string;
  title: string;
  category?: string | null;
  accountId?: string | null;
  views: number;
  clicks: number;
  likes?: number;
  comments?: number;
  collects?: number;
  shares?: number;
}) {
  const metricDate = todayKey();
  await prisma.platformContentMetric.upsert({
    where: {
      platform_contentKey_metricDate: {
        platform: row.platform,
        contentKey: row.contentKey,
        metricDate,
      },
    },
    update: {
      title: row.title,
      views: row.views,
      clicks: row.clicks,
      likes: row.likes ?? 0,
      comments: row.comments ?? 0,
      collects: row.collects ?? 0,
      shares: row.shares ?? 0,
      accountId: row.accountId ?? null,
    },
    create: {
      platform: row.platform,
      contentKey: row.contentKey,
      metricDate,
      title: row.title,
      category: row.category ?? null,
      accountId: row.accountId ?? null,
      views: row.views,
      clicks: row.clicks,
      likes: row.likes ?? 0,
      comments: row.comments ?? 0,
      collects: row.collects ?? 0,
      shares: row.shares ?? 0,
    },
  });
}

/** 官网渠道：拉官网统计接口写入本地库（站点 PV/UV + 内容浏览/点击） */
export async function syncSiteMetrics(): Promise<{ ok: boolean; message: string; items?: number }> {
  const token = process.env.HGWX_PUBLISH_TOKEN;
  if (!token) return { ok: false, message: "未配置 HGWX_PUBLISH_TOKEN" };
  try {
    const res = await fetch("https://hgwx.aimemory.cafe/api/stats", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, message: `官网统计接口 HTTP ${res.status}` };
    const data = await res.json();
    if (!data?.ok) return { ok: false, message: "官网统计接口返回异常" };
    const metricDate = todayKey();
    if (data.site) {
      await prisma.platformSiteMetric.upsert({
        where: { platform_metricDate: { platform: "site", metricDate } },
        update: { pv: data.site.todayPv ?? 0, uv: data.site.uv ?? 0 },
        create: { platform: "site", metricDate, pv: data.site.todayPv ?? 0, uv: data.site.uv ?? 0 },
      });
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
      });
    }
    return { ok: true, message: `官网数据同步完成：${items.length} 条内容`, items: items.length };
  } catch (e) {
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
      await prisma.platformAccount.update({
        where: { id: accountId },
        data: {
          lastSyncAt: new Date(),
          status: "active",
          statusMsg: synced > 0 ? `凭据有效；已有 ${synced} 篇笔记数据（由本地采集器同步）` : "凭据有效；笔记数据待本地采集器同步",
        },
      });
      return { ok: true, message: `小红书凭据有效（${json.data.userName || account.displayName}）`, items: synced };
    }
    await markAccountError(accountId, `凭据已失效（平台响应 ${json?.code ?? res.status}），请重新授权`);
    return { ok: false, message: "凭据失效，请重新授权" };
  } catch (e) {
    await markAccountError(accountId, `请求失败：${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, message: "小红书数据同步失败（详见账号状态）" };
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

  const byId = new Map<string, { title: string; views: number; clicks: number; likes: number; comments: number; collects: number; shares: number }>();
  let consecutiveEmpty = 0;
  for (let i = 0; i < 200; i++) {
    const res = await fetchJson(base.replace("REPLACE_PAGE", String(i + 1)) + `&offset=${byId.size}`);
    if (res.expired) {
      await markAccountError(accountId, "凭据已失效，请重新授权");
      return { ok: false, message: "凭据失效，请重新授权" };
    }
    const cells = (res.json?.data || []).map((d: any) => d?.assembleCell?.itemCell).filter(Boolean);
    let added = 0;
    for (const cell of cells) {
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
        views: Number(c.readCount || 0) + Number(c.videoWatchCount || 0),
        clicks: Number(c.showCount || 0),
        likes: Number(c.diggCount || 0),
        comments: Number(c.commentCount || 0),
        collects: Number(c.repinCount || 0),
        shares: 0,
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
    await upsertContentMetric({ platform: "toutiao", contentKey, accountId, ...row });
  }
  const totalViews = [...byId.values()].reduce((s, r) => s + r.views, 0);
  await prisma.platformAccount.update({
    where: { id: accountId },
    data: { lastSyncAt: new Date(), status: "active", statusMsg: `同步成功（${byId.size} 条内容，阅读+播放 ${totalViews}）` },
  });
  return { ok: true, message: `头条号数据同步完成：${byId.size} 条内容`, items: byId.size };
}

async function markAccountError(accountId: string, msg: string) {
  await prisma.platformAccount
    .update({ where: { id: accountId }, data: { status: "error", statusMsg: msg.slice(0, 500) } })
    .catch(() => {});
}

/** 同步全部渠道：官网 + 所有已授权账号 */
export async function syncAllPlatforms() {
  const results: Array<{ platform: string; ok: boolean; message: string; items?: number }> = [];
  results.push({ platform: "site", ...(await syncSiteMetrics()) });
  const accounts = await prisma.platformAccount.findMany({ where: { status: { not: "expired" } } });
  for (const acc of accounts) {
    if (acc.platform === "xhs") results.push({ platform: "xhs", ...(await syncXhsMetrics(acc.id)) });
    if (acc.platform === "toutiao") results.push({ platform: "toutiao", ...(await syncToutiaoMetrics(acc.id)) });
  }
  return results;
}
