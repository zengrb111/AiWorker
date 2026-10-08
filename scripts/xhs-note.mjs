/**
 * 单篇小红书笔记原文读取器（一键仿写爆款用）。
 *
 * 背景：小红书笔记页已改为 CSR + 登录/风控拦截，服务端直连只会拿到登录页。
 * 必须走真实浏览器通道：用 headless Chrome 注入登录 Cookie，打开笔记页，
 * 读 window.__INITIAL_STATE__ 里的 noteDetailMap。
 *
 * 用法：
 *   node scripts/xhs-note.mjs "<笔记链接或 noteId>"
 *   Cookie 来源：环境变量 XHS_COOKIE，缺省读项目根 .xhs-cookie.txt（已 gitignore）
 *
 * 输出：单行 JSON
 *   成功 { "ok": true, "note": { title, desc, topics, author, ipLocation, type, coverImages } }
 *   失败 { "ok": false, "reason": "login" | "no-state" | "no-note" | "cookie-missing" | "error", "detail": "…", "href": "…" }
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const input = process.argv[2] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function readCookie() {
  if (process.env.XHS_COOKIE && process.env.XHS_COOKIE.trim()) {
    return process.env.XHS_COOKIE.trim().replace(/^cookie\s*:\s*/i, '').replace(/^["']|["']$/g, '');
  }
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.xhs-cookie.txt'), 'utf8').trim();
    return raw.replace(/^cookie\s*:\s*/i, '').replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
}

function normalizeUrl(raw) {
  const v = raw.trim();
  const idMatch = /(?:explore|discovery\/item|note)\/([0-9a-f]{16,32})/i.exec(v) || /^([0-9a-f]{16,32})$/i.exec(v);
  const tokenMatch = /[?&]xsec_token=([^&\s]+)/.exec(v);
  if (!/^https?:\/\//i.test(v)) {
    if (!idMatch) return null;
    const token = tokenMatch ? `?xsec_token=${tokenMatch[1]}&xsec_source=pc_search` : '';
    return `https://www.xiaohongshu.com/explore/${idMatch[1]}${token}`;
  }
  return v;
}

function parseCookies(cookieStr) {
  return cookieStr
    .split(/;\s*/)
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf('=');
      return [pair.slice(0, idx), pair.slice(idx + 1)];
    })
    .filter(([name]) => name);
}

function extractNote(state) {
  const map = state?.note?.noteDetailMap;
  if (!map || typeof map !== 'object') return null;
  const entry = Object.values(map)[0];
  const note = entry?.note || entry;
  if (!note || (!note.title && !note.desc)) return null;
  const images = [];
  const push = (u) => {
    if (u && /^https?:\/\//.test(u)) images.push(u);
  };
  if (Array.isArray(note.imageList)) {
    for (const it of note.imageList) push(it?.infoList?.[0]?.url || it?.url || it?.urlDefault);
  }
  push(note?.cover?.url || note?.video?.cover?.url);
  return {
    title: note.title || '',
    desc: note.desc || '',
    topics: [...new Set((note.tagList || []).map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean))],
    author: note.user?.nickname || note.author?.nickname || '',
    ipLocation: note.ipLocation || '',
    type: note.type === 1 ? '视频笔记' : note.type === 0 || note.type === 'normal' ? '图文笔记' : '',
    coverImages: images.slice(0, 9),
  };
}

let chrome;
let profile;

async function main() {
  const url = normalizeUrl(input);
  if (!url) {
    out({ ok: false, reason: 'bad-url', detail: '无法识别的链接，请粘贴小红书笔记链接（含 xsec_token 更稳）' });
    return;
  }

  const cookie = readCookie();
  if (!cookie) {
    out({
      ok: false,
      reason: 'cookie-missing',
      detail: '缺少小红书登录 Cookie：请在「平台授权管理 → 小红书」重新授权，或先同步一次小红书数据'
    });
    return;
  }

  const port = 10200 + (process.pid % 400);
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-note-'));
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--window-size=1440,1100',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('Chrome 调试端口未就绪');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Network.enable');
  // 用真实 Chrome UA，避免 headless 标识被风控直接拦
  const UA = process.env.XHS_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  await send('Network.setUserAgentOverride', { userAgent: UA, acceptLanguage: 'zh-CN,zh;q=0.9', platform: 'Win32' }).catch(() => {});
  for (const [name, value] of parseCookies(cookie)) {
    await send('Network.setCookie', { name, value, domain: '.xiaohongshu.com', path: '/', secure: true }).catch(() => {});
  }

  // 先进首页建立会话（风控会看 referer / 首访），再打开笔记页
  await send('Page.navigate', { url: 'https://www.xiaohongshu.com/explore' });
  await sleep(6000);
  await send('Page.navigate', { url });

  const isAppShare = /xsec_source=app_share/i.test(url);

  let note = null;
  let href = '';
  let sawLogin = false;
  // 最多轮询 ~30 秒：CSR 页面要等前端把 noteDetailMap 填好
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const r = await evaluate(
        `(()=>{ const href=location.href; const s=window.__INITIAL_STATE__; const n=s?(s.note&&s.note.noteDetailMap):null; return { href, hasState: !!s, keys: n?Object.keys(n).length:0 }; })()`
      );
      href = r?.href || href;
      if (/\/login|redirectPath/i.test(href)) sawLogin = true;
      if (r?.keys > 0) {
        note = await evaluate(`(()=>{ const s=window.__INITIAL_STATE__; const m=s.note.noteDetailMap; const e=m[Object.keys(m)[0]]; const nt=e&&(e.note||e); if(!nt) return null; const imgs=[]; (nt.imageList||[]).forEach(it=>{const u=it&&(it.infoList&&it.infoList[0]&&it.infoList[0].url||it.url||it.urlDefault); if(u) imgs.push(u)}); if(nt.cover&&nt.cover.url) imgs.push(nt.cover.url); if(nt.video&&nt.video.cover&&nt.video.cover.url) imgs.push(nt.video.cover.url); return { title:nt.title||'', desc:nt.desc||'', type:nt.type, tags:(nt.tagList||[]).map(t=>t&&t.name).filter(Boolean), author:(nt.user&&nt.user.nickname)||(nt.author&&nt.author.nickname)||'', ip:nt.ipLocation||'', images:imgs.slice(0,9) }; })()`);
        if (note && (note.title || note.desc)) break;
        note = null;
      }
      // 页面可能要求点击（视频笔记/展开全文），尽力滚动一下
      if (i === 8) {
        await evaluate('window.scrollTo(0, 600)').catch(() => {});
      }
    } catch {
      /* 继续等 */
    }
  }

  if (note) {
    out({
      ok: true,
      note: {
        title: note.title || '',
        desc: note.desc || '',
        topics: [...new Set(note.tags || [])],
        author: note.author || '',
        ipLocation: note.ip || '',
        type: note.type === 1 ? '视频笔记' : note.type === 0 || note.type === 'normal' ? '图文笔记' : '',
        coverImages: note.images || [],
      },
    });
    return;
  }

  // 失败原因判定：区分「App 分享链接（仅 App 内可看）」/「登录失效」/「笔记不可用」
  let pageText = '';
  try {
    pageText = String((await evaluate('document.body ? document.body.innerText.slice(0, 200) : ""')) || '');
  } catch {
    /* ignore */
  }
  const secRedirect = /xhs_sec_server|\/404\/sec_|connect\/oauth2\/authorize/i.test(href);
  const appOnly = /App内打开|仅支持在小红书|打开 ?APP/i.test(pageText);

  if (isAppShare || appOnly || secRedirect) {
    out({
      ok: false,
      reason: 'app-share-link',
      detail: `App 分享链接受限（href=${href.slice(0, 120)}；page=${pageText.slice(0, 60)}）`,
      href,
    });
    return;
  }

  out({
    ok: false,
    reason: sawLogin ? 'login' : 'no-note',
    detail: sawLogin
      ? '小红书返回了登录页：当前 Cookie 未登录或已失效，请在「平台授权管理 → 小红书」重新授权'
      : '页面没读到笔记数据（可能是链接失效 / 需要 xsec_token / 笔记已被删除）',
    href,
  });
}

main()
  .catch((e) => out({ ok: false, reason: 'error', detail: e?.message || String(e) }))
  .finally(async () => {
    try {
      ws?.close?.();
    } catch {}
    try {
      chrome?.kill();
    } catch {}
    await sleep(300);
    try {
      if (profile) fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
    process.exit(0);
  });
