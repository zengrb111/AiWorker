/**
 * 小红书创作者中心数据采集器（一键全量同步）。
 *
 * 背景：创作者中心笔记数据接口有 x-s 签名风控，服务端直连 406，
 * 必须走真实浏览器通道。本脚本用 headless Chrome 注入 Cookie 打开
 * 笔记管理页，滚动加载全部笔记并拦截接口响应，推送到平台入库。
 *
 * 用法：
 *   1. Cookie 保存在项目根 .xhs-cookie.txt（已 gitignore；失效后重新从
 *      创作者后台 F12 → Network → 请求 Request Headers 里复制整段 Cookie 覆盖）
 *   2. node scripts/xhs-collect.mjs   （需先启动 dev server :3000）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const API = process.env.AIWORKER_API || 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function readCookie() {
  const file = path.join(ROOT, '.xhs-cookie.txt');
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw.replace(/^cookie\s*:\s*/i, '').replace(/^["']|["']$/g, '');
  } catch {
    console.error('缺少 .xhs-cookie.txt（创作者后台 Cookie）。获取方法见平台「平台授权管理」引导文案。');
    process.exit(1);
  }
}

const PORT = 10100 + (process.pid % 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-collect-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCookies(cookieStr) {
  return cookieStr.split(/;\s*/).filter(Boolean).map((pair) => {
    const idx = pair.indexOf('=');
    return [pair.slice(0, idx), pair.slice(idx + 1)];
  });
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=1440,1100', 'about:blank',
], { stdio: 'ignore' });

async function pickTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('Chrome target 未就绪');
}

let ws;
try {
  const cookieStr = readCookie();
  const wsUrl = await pickTarget();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 1;
  const pending = new Map();
  const postedResponses = [];
  // 用户/账号类接口（粉丝数所在）——端点名不固定，按关键字拦截，best-effort
  const userInfoResponses = [];
  const pageByUrl = (u) => {
    const m = /[?&]page=(\d+)/.exec(u);
    return m ? Number(m[1]) : 0;
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Network.responseReceived') {
      const u = msg.params?.response?.url || '';
      if (u.includes('/api/galaxy/v2/creator/note/user/posted')) {
        postedResponses.push({ requestId: msg.params.requestId, page: pageByUrl(u) });
      }
      // 用户/账号信息接口（粉丝数）：端点名不固定，凡路径含 user/personal/profile/account 的 JSON 都收
      if (
        u.includes('/api/galaxy/') &&
        !u.includes('/note/user/posted') &&
        /(user|personal|profile|account)/i.test(u) &&
        String(msg.params?.response?.mimeType || '').includes('json')
      ) {
        userInfoResponses.push(msg.params.requestId);
      }
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (m, p = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method: m, params: p }));
    });
  };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Network.enable');
  for (const [name, value] of parseCookies(cookieStr)) {
    await send('Network.setCookie', { name, value, domain: '.xiaohongshu.com', path: '/', secure: true, sameSite: 'Lax' });
  }
  await send('Page.navigate', { url: 'https://creator.xiaohongshu.com/' });
  await sleep(9000);

  // 从拦截到的用户类接口里找粉丝数（best-effort，失败不影响主流程）。
  // 必须趁首页响应还在缓存里读取（点「笔记管理」后导航容易把 body 冲掉）。
  const readRespBody = async (requestId) => {
    const r = await send('Network.getResponseBody', { requestId }).catch(() => null);
    if (!r) return '';
    return r.base64Encoded ? Buffer.from(r.body || '', 'base64').toString('utf8') : (r.body || '');
  };
  const findFans = (obj) => {
    const KEYS = new Set(['fans', 'fansCount', 'fans_count', 'fansNum', 'fans_num', 'followers', 'followersCount', 'followers_count', 'total_fans_count']);
    let found = null;
    const walk = (v, depth) => {
      if (found != null || depth > 6 || !v || typeof v !== 'object') return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      for (const [k, val] of Object.entries(v)) {
        if (KEYS.has(k) && (typeof val === 'number' || /^\d+$/.test(String(val)))) { found = Number(val); return; }
        walk(val, depth + 1);
        if (found != null) return;
      }
    };
    walk(obj, 0);
    return found;
  };
  let fanTotal = null;
  for (const rid of userInfoResponses) {
    try {
      const txt = await readRespBody(rid);
      if (!txt) continue;
      const got = findFans(JSON.parse(txt));
      if (got != null && got > 0) { fanTotal = got; break; }
    } catch { /* 忽略单个接口失败 */ }
  }
  console.log('[xhs-collect] 累计粉丝:', fanTotal ?? '未获取到');

  const clicked = await evaluate(`(()=>{ const l=[...document.querySelectorAll('a,li,span,div')].filter(e=>e.children.length<=1&&(e.textContent||'').trim()==='笔记管理'); if(l.length){l[0].click();return true;} return false; })()`);
  if (!clicked) throw new Error('未找到「笔记管理」入口（Cookie 可能已失效）');
  await sleep(9000);

  const seen = new Set();
  const raw = [];
  const grabBodies = async () => {
    for (const resp of postedResponses) {
      if (seen.has(resp.requestId)) continue;
      seen.add(resp.requestId);
      try {
        const r = await send('Network.getResponseBody', { requestId: resp.requestId });
        const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
        const j = JSON.parse(body);
        for (const n of j?.data?.notes || []) {
          raw.push({
            id: n.id, title: n.display_title || '', time: n.time || '', type: n.type || '',
            views: n.view_count || 0, likes: n.likes || 0, comments: n.comments_count || 0,
            collects: n.collected_count || 0, shares: n.shared_count || 0,
            // 可见性：permission_code=0 为公开可见；非 0（如 1「仅自己可见」）不计入效果数据
            permissionCode: n.permission_code ?? 0, permissionMsg: n.permission_msg || '',
            // 详情页需要 xsec_token 才能打开（小红书反爬）
            token: n.xsec_token || '',
          });
        }
      } catch {}
    }
  };
  await grabBodies();

  let lastCount = -1;
  for (let i = 0; i < 50; i++) {
    await evaluate(`(()=>{ const c=[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+200&&getComputedStyle(e).overflowY!=='visible'); c.sort((a,b)=>b.scrollHeight-a.scrollHeight); (c[0]||document.scrollingElement).scrollTop=(c[0]||document.scrollingElement).scrollHeight; window.scrollTo(0,document.body.scrollHeight); return true; })()`);
    await sleep(2800);
    await grabBodies();
    if (raw.length === lastCount && i > 3) break;
    lastCount = raw.length;
  }

  const byId = new Map();
  for (const n of raw) if (n.id && !byId.has(n.id)) byId.set(n.id, n);
  const allNotes = [...byId.values()];
  // 只保留当前公开可见的笔记（排除「仅自己可见」等）
  const notes = allNotes.filter((n) => n.permissionCode === 0);
  const hidden = allNotes.filter((n) => n.permissionCode !== 0);
  console.log('采集完成：', allNotes.length, '篇笔记；公开可见', notes.length, '篇；已排除非公开', hidden.length, '篇');
  if (hidden.length) {
    for (const h of hidden.slice(0, 5)) console.log('  排除：', h.permissionMsg || ('code=' + h.permissionCode), '::', h.title.slice(0, 30));
  }

  // 抓图文笔记的真实原文：拆解必须基于原文，小红书笔记页已改 CSR 且要 xsec_token，
  // 只能借当前这个已登录的浏览器逐篇打开详情页，读 window.__INITIAL_STATE__。
  const graphicNotes = notes.filter((n) => n.type === 'normal' && n.token);
  const bodies = [];
  if (graphicNotes.length) {
    console.log('开始抓取图文原文：', graphicNotes.length, '篇…');
    for (const n of graphicNotes) {
      const url = `https://www.xiaohongshu.com/explore/${n.id}?xsec_token=${encodeURIComponent(n.token)}&xsec_source=pc_creatormng`;
      try {
        await send('Page.navigate', { url });
        await sleep(6500);
        const r = await evaluate(`(()=>{try{
          const s = window.__INITIAL_STATE__; if(!s) return null;
          const map = s?.note?.noteDetailMap; if(!map) return null;
          const nt = map[Object.keys(map)[0]]?.note; if(!nt) return null;
          return { title: nt.title||'', desc: nt.desc||'', type: nt.type, tags:(nt.tagList||[]).map(t=>t&&t.name).filter(Boolean), author: (nt.user&&nt.user.nickname)||'' };
        }catch(e){return null}})()`);
        if (r && (r.title || r.desc)) {
          bodies.push({ id: n.id, title: r.title || n.title, body: r.desc || '', topics: (r.tags || []).join(','), author: r.author || '' });
          console.log('  原文 OK', (r.desc || '').length, '字 ::', (r.title || n.title).slice(0, 24));
        } else {
          console.log('  原文 未取到 ::', String(n.title).slice(0, 24));
        }
      } catch (e) {
        console.log('  原文 失败', e.message, '::', String(n.title).slice(0, 24));
      }
    }
  }

  // 推送到平台入库
  const token = (fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').match(/CONTENT_INGEST_TOKEN="([^"]+)"/) || [])[1];
  if (!token) throw new Error('.env.local 缺少 CONTENT_INGEST_TOKEN');
  const res = await fetch(`${API}/api/platform-metrics/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      platform: 'xhs',
      notes,
      bodies,
      accountId: process.env.ACCOUNT_ID || '',
      // 累计粉丝快照（拦截 creator 用户接口 best-effort 获取），供「用户维度」全渠道统计
      ...(fanTotal != null ? { fanTotal } : {}),
    }),
  });
  const out = await res.json().catch(() => null);
  console.log('入库结果 HTTP', res.status, JSON.stringify(out));
  if (!res.ok || !out?.ok) process.exitCode = 1;
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { chrome.kill(); } catch {}
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
