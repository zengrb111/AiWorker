/**
 * 视频号助手数据采集器（headless Chrome + 注入 Cookie）。
 *
 * 背景：视频号助手（channels.weixin.qq.com）的数据接口需要登录态，且请求带动态签名，
 * 服务端直连拿不到。本脚本走真实浏览器：
 *   1. 注入「平台授权管理」保存的 Cookie，打开 /platform；
 *   2. 进入「数据中心 → 视频数据」（默认昨日口径）；
 *   3. 拦截 cgi-bin 接口响应（优先）+ DOM 关键指标兜底，提取 播放/点赞/分享；
 *   4. 播放数映射为「阅读」，按「昨日」日期推送到 /api/platform-metrics/ingest。
 *
 * 用法：
 *   node scripts/channels-collect.mjs
 *   ACCOUNT_ID=xxx node scripts/channels-collect.mjs
 * 前置：dev server 已启动（AIWORKER_API 可覆盖，默认 http://127.0.0.1:3000）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const API = process.env.AIWORKER_API || 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const require2 = createRequire(import.meta.url);

function decryptCredential(packed) {
  const key = Buffer.from(fs.readFileSync(path.join(ROOT, '.platform-cred.key'), 'utf8').trim(), 'hex');
  const [ivB64, tagB64, dataB64] = packed.split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8');
}

async function loadAccount() {
  const { PrismaClient } = require2(path.join(ROOT, 'src/generated/prisma'));
  const prisma = new PrismaClient();
  try {
    const acc = process.env.ACCOUNT_ID
      ? await prisma.platformAccount.findUnique({ where: { id: process.env.ACCOUNT_ID } })
      : await prisma.platformAccount.findFirst({ where: { platform: 'channels', status: { not: 'expired' } }, orderBy: { createdAt: 'asc' } });
    if (!acc?.credentialEnc) throw new Error('没有找到已授权的视频号账号');
    return { accountId: acc.id, cookie: decryptCredential(acc.credentialEnc) };
  } finally {
    await prisma.$disconnect();
  }
}

const PORT = 10500 + (process.pid % 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-collect-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 深度查找「播放 + 互动」指标对象（字段名各版本不一致，按常见命名匹配） */
function findMetrics(root) {
  const PLAY = ['playCount', 'play_count', 'playNum', 'play_num', 'plays', 'readCount', 'read_count', 'viewCount', 'view_count'];
  const LIKE = ['likeCount', 'like_count', 'likeNum', 'like_num', 'likes'];
  const SHARE = ['shareCount', 'share_count', 'shareNum', 'share_num', 'shares'];
  const COMMENT = ['commentCount', 'comment_count', 'commentNum', 'comment_num', 'comments'];
  const pick = (o, names) => {
    for (const n of names) if (o[n] != null && Number.isFinite(Number(o[n]))) return Number(o[n]);
    return null;
  };
  let best = null;
  const walk = (v, depth) => {
    if (depth > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const plays = pick(v, PLAY);
    if (plays != null && plays >= 0) {
      const likes = pick(v, LIKE) ?? 0;
      const shares = pick(v, SHARE) ?? 0;
      const comments = pick(v, COMMENT) ?? 0;
      const score = (likes || shares || comments ? 2 : 1) + (/overview|summary|total|data/i.test(Object.keys(v).join('')) ? 1 : 0);
      if (!best || score > best.score) best = { plays, likes, shares, comments, score };
    }
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(root, 0);
  return best;
}

async function main() {
  const { accountId, cookie } = await loadAccount();
  console.log('[channels-collect] 账号', accountId, 'Cookie 长度', cookie.length);

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1440,1100', 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    let wsUrl = null;
    for (let i = 0; i < 80 && !wsUrl; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) wsUrl = page.webSocketDebuggerUrl;
      } catch {}
      if (!wsUrl) await sleep(200);
    }
    if (!wsUrl) throw new Error('Chrome target 未就绪');
    ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let nextId = 1;
    const pending = new Map();
    const hits = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Network.responseReceived') {
        const u = msg.params?.response?.url || '';
        const mt = msg.params?.response?.mimeType || '';
        // 注意：部分接口在 /micro/statistic/cgi-bin/... 下，路径中间还有一段，不能只匹配根路径
        if (/channels\.weixin\.qq\.com\/.*cgi-bin\//.test(u) && mt.includes('json')) {
          hits.push({ requestId: msg.params.requestId, url: u });
        }
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
    const send = (m, prm = {}) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method: m, params: prm }));
      });
    };
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('页面脚本异常: ' + r.exceptionDetails.text);
      return r.result?.value;
    };

    await send('Page.enable');
    await send('Network.enable');
    for (const pair of cookie.split(/;\s*/).filter(Boolean)) {
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1);
      for (const domain of ['.weixin.qq.com', '.qq.com']) {
        try { await send('Network.setCookie', { name, value, domain, path: '/', secure: true }); } catch {}
      }
    }

    await send('Page.navigate', { url: 'https://channels.weixin.qq.com/platform' });
    await sleep(9000);
    const info = await evaluate('(()=>({url:location.href,title:document.title}))()');
    if (String(info?.url || '').includes('login.html')) {
      throw new Error('视频号登录态已失效（跳转到 login.html），请重新授权');
    }

    // 数据中心 → 视频数据（文案可能微调，逐个尝试）
    // 点击标签（同时兼容普通 DOM 与 Shadow DOM）
    const clickLabel = (label) => evaluate(`(() => {
      const find = (root) => {
        let best = null;
        const els = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const e of els) {
          if (e.shadowRoot) { const r = find(e.shadowRoot); if (r) return r; }
          if ((e.textContent || '').trim() === ${JSON.stringify('__L__')}) best = e;
        }
        return best;
      };
      const el = find(document);
      if (el) { el.click(); return true; }
      return false;
    })()`.replace('__L__', label));

    for (const label of ['数据中心', '视频数据']) {
      console.log('[channels-collect] click', label, await clickLabel(label));
      await sleep(4500);
    }
    await sleep(2500);

    // 切换日期范围：昨日 / 近7天 / 近30天（关键指标卡片左上角的下拉）
    console.log('[channels-collect] 切近7天:', await clickLabel('昨日数据'));
    await sleep(1500);
    console.log('[channels-collect] →近7天:', await clickLabel('近7天'));
    await sleep(4500);
    console.log('[channels-collect] 切近30天:', await clickLabel('昨日数据'));
    await sleep(1500);
    console.log('[channels-collect] →近30天:', await clickLabel('近30天'));
    await sleep(5000);

    // 解析「视频数据」接口：statistic/new_post_total_data
    // data.dataByTabtype[].data = { browse:[按天], like:[], comment:[], forward:[], fav:[], ... }
    // 昨日视图返回 2 个点（[前日, 昨日]），7/30 天视图分别返回 7/30 个点。
    const readBody = async (requestId) => {
      try {
        const r = await send('Network.getResponseBody', { requestId });
        const txt = r.base64Encoded ? Buffer.from(r.body || '', 'base64').toString('utf8') : (r.body || '');
        return txt ? JSON.parse(txt) : null;
      } catch {
        return null;
      }
    };

    let day2 = null;
    let day7 = null;
    let day30 = null;
    let fanTotal = null;
    for (const h of hits) {
      if (/statistic\/new_post_total_data/i.test(h.url)) {
        const j = await readBody(h.requestId);
        const rows = j?.data?.dataByTabtype;
        if (!Array.isArray(rows) || rows.length === 0) continue;
        const len = rows[0]?.data?.browse?.length || 0;
        if (len === 2) day2 = rows;
        else if (len === 7) day7 = rows;
        else if (len === 30) day30 = rows;
      } else if (/statistic\/fans_trend/i.test(h.url)) {
        const j = await readBody(h.requestId);
        const t = j?.data?.total;
        if (Array.isArray(t) && t.length) fanTotal = Number(t[t.length - 1]) || null;
      }
    }

    const sumLast = (rows, key) =>
      rows.reduce((s, r) => {
        const a = r?.data?.[key];
        return s + (Array.isArray(a) && a.length ? Number(a[a.length - 1]) || 0 : 0);
      }, 0);
    const sumAll = (rows, key) =>
      rows.reduce((s, r) => {
        const a = r?.data?.[key];
        return s + (Array.isArray(a) ? a.reduce((x, y) => x + (Number(y) || 0), 0) : 0);
      }, 0);

    const base = day2 || day7 || day30;
    if (!base) throw new Error('未取到视频号数据接口（页面结构可能变化）');

    // 昨日：取每个来源序列的最后一个点（昨日视图的末位=昨日）
    const hasDay2 = !!day2;
    const summary = {
      reads: hasDay2 ? sumLast(day2, 'browse') : sumAll(day7, 'browse'),
      likes: hasDay2 ? sumLast(day2, 'like') : sumAll(day7, 'like'),
      shares: hasDay2 ? sumLast(day2, 'forward') : sumAll(day7, 'forward'),
      comments: hasDay2 ? sumLast(day2, 'comment') : sumAll(day7, 'comment'),
    };
    const buildWin = (rows) =>
      rows
        ? {
            reads: sumAll(rows, 'browse'),
            likes: sumAll(rows, 'like'),
            shares: sumAll(rows, 'forward'),
            comments: sumAll(rows, 'comment'),
          }
        : null;
    const summary7 = buildWin(day7);
    const summary30 = buildWin(day30);

    console.log('[channels-collect] 昨日:', JSON.stringify(summary), '近7天:', JSON.stringify(summary7), '近30天:', JSON.stringify(summary30), '总粉丝:', fanTotal);

    // ---- 关注者画像 → 地域分布（best-effort）----
    // 接口：/micro/statistic/cgi-bin/mmfinderassistant-bin/statistic/fans_portrait
    // 返回 data.respJson（字符串）→ metric_info_list[].{name: province_list, value:[{dim,value}]}
    const CN_PROVINCES = new Set([
      '北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省',
      '上海市', '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省', '河南省',
      '湖北省', '湖南省', '广东省', '广西壮族自治区', '海南省', '重庆市', '四川省', '贵州省',
      '云南省', '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区', '新疆维吾尔自治区',
      '台湾省', '香港特别行政区', '澳门特别行政区',
    ]);
    let regions = [];
    try {
      // 通过左侧导航进入「关注者数据」（直接打开 URL 不会渲染出标签页）
      console.log('[channels-collect] click 关注者数据:', await clickLabel('关注者数据'));
      await sleep(7000);
      let clickedPortrait = false;
      for (let i = 0; i < 4 && !clickedPortrait; i++) {
        clickedPortrait = await clickLabel('关注者画像');
        if (!clickedPortrait) await sleep(2500);
      }
      console.log('[channels-collect] click 关注者画像:', clickedPortrait);
      await sleep(7000);
      console.log('[channels-collect] fans_portrait 命中:', hits.filter((h) => /fans_portrait/i.test(h.url)).length);
      for (const h of hits) {
        if (!/statistic\/fans_portrait/i.test(h.url)) continue;
        const j = await readBody(h.requestId);
        const inner = j?.data?.respJson;
        if (!inner) continue;
        const parsed = JSON.parse(inner);
        const list = (parsed?.metric_info_list || []).find((x) => x?.name === 'province_list')?.value || [];
        regions = list
          .filter((x) => CN_PROVINCES.has(String(x?.dim || '')))
          .map((x) => ({ province: String(x.dim), fans: Number(x.value) || 0 }))
          .filter((x) => x.fans > 0);
        if (regions.length > 0) break;
      }
    } catch (e) {
      console.warn('[channels-collect] 地域分布获取失败（忽略）:', e.message);
    }
    console.log('[channels-collect] 地域分布:', regions.length, '个省级地区', regions.slice(0, 3).map((x) => `${x.province}:${x.fans}`).join(' '));

    // 汇总记到「昨日」（后台「昨日数据」口径）
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const pad2 = (n) => String(n).padStart(2, '0');
    const metricDate = `${y.getFullYear()}-${pad2(y.getMonth() + 1)}-${pad2(y.getDate())}`;

    const envText = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
    const ingestToken = (envText.match(/CONTENT_INGEST_TOKEN="([^"]+)"/) || [])[1];
    if (!ingestToken) throw new Error('.env.local 缺少 CONTENT_INGEST_TOKEN');

    const res = await fetch(`${API}/api/platform-metrics/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ingestToken}` },
      body: JSON.stringify({
        platform: 'channels',
        accountId,
        metricDate,
        notes: [],
        // 播放 → 阅读
        summary,
        ...(summary7 ? { summary7 } : {}),
        ...(summary30 ? { summary30 } : {}),
        ...(fanTotal ? { fanTotal } : {}),
        ...(regions.length ? { regions } : {}),
      }),
    });
    const out = await res.json().catch(() => null);
    console.log('[channels-collect] 入库结果 HTTP', res.status, JSON.stringify(out));
    if (!res.ok || !out?.ok) process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch {}
    chrome.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error('[channels-collect] FAILED:', e.message);
  process.exit(1);
});
