/**
 * 公众号数据采集器（headless Chrome + 注入 Cookie）。
 *
 * 背景：公众号后台的数据接口都需要 URL 里的动态 token（登录时生成、Cookie 里拿不到），
 * 服务端直连拿不到数据。本脚本走真实浏览器通道：
 *   1. 注入「平台授权管理」里已保存的公众号 Cookie，打开 mp.weixin.qq.com 拿到 token；
 *   2. 拉图文列表（appmsg list_ex）得到「收录内容」清单（标题 / 链接 / 时间）；
 *   3. 拉内容分析汇总（appmsganalysis daily_v2）得到账号级 阅读 / 分享 / 点赞 / 在看；
 *   4. 推送到 /api/platform-metrics/ingest 入库。
 *
 * 用法：
 *   node scripts/wechat-collect.mjs            # 自动取第一个已授权的公众号
 *   ACCOUNT_ID=xxx node scripts/wechat-collect.mjs
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
const PLATFORM = process.env.COLLECT_PLATFORM || 'wechat';
const require2 = createRequire(import.meta.url);

/** 解密平台凭据（与 src/lib/platform-creds.ts 同算法：AES-256-GCM） */
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
    const where = process.env.ACCOUNT_ID
      ? { id: process.env.ACCOUNT_ID }
      : { platform: PLATFORM, status: { not: 'expired' } };
    const acc = await prisma.platformAccount.findFirst({ where, orderBy: { createdAt: 'asc' } });
    if (!acc?.credentialEnc) throw new Error(`没有找到已授权的 ${PLATFORM} 账号`);
    return { accountId: acc.id, cookie: decryptCredential(acc.credentialEnc) };
  } finally {
    await prisma.$disconnect();
  }
}

const PORT = 10400 + (process.pid % 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-collect-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { accountId, cookie } = await loadAccount();
  console.log('[wechat-collect] 账号', accountId, 'Cookie 长度', cookie.length);

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
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
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
    /** 在页面上下文里拉后台接口（同源 + 自动带 Cookie + token） */
    const callApi = async (url) => {
      const t = await evaluate(`(async()=>{try{
        const r=await fetch(${JSON.stringify(url)},{credentials:'include',headers:{'X-Requested-With':'XMLHttpRequest'}});
        return await r.text();
      }catch(e){return JSON.stringify({__fetchError:String(e)})}})()`);
      try { return JSON.parse(t); } catch { return null; }
    };

    await send('Page.enable');
    await send('Network.enable');
    for (const pair of cookie.split(/;\s*/).filter(Boolean)) {
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1);
      for (const domain of ['.qq.com', '.weixin.qq.com']) {
        try { await send('Network.setCookie', { name, value, domain, path: '/', secure: true }); } catch {}
      }
    }

    await send('Page.navigate', { url: 'https://mp.weixin.qq.com/' });
    await sleep(9000);
    const info = await evaluate('(()=>({url:location.href,title:document.title}))()');
    const token = (/token=(\d+)/.exec(String(info?.url || '')) || [])[1];
    if (!token) {
      throw new Error(`未取到 token（登录态可能已失效）：${info?.url || ''} ${info?.title || ''}`);
    }
    console.log('[wechat-collect] token =', token, ' 页面标题 =', info?.title);

    // ---- 1) 图文列表（分页拉全量）----
    const notes = [];
    let total = 0;
    for (let begin = 0; begin < 500; begin += 20) {
      const j = await callApi(`/cgi-bin/appmsg?token=${token}&lang=zh_CN&f=json&ajax=1&random=${Date.now()}&action=list_ex&begin=${begin}&count=20&type=9&query=&fakeid=&free_publish_type=1&sub_action=list_ex`);
      if (!j || j.base_resp?.ret !== 0) {
        console.warn('[wechat-collect] 列表第', begin, '页返回异常:', JSON.stringify(j?.base_resp || j).slice(0, 120));
        break;
      }
      total = Number(j.app_msg_cnt || 0);
      const list = Array.isArray(j.app_msg_list) ? j.app_msg_list : [];
      for (const it of list) {
        const key = String(it.aid || it.appmsgid || '').trim();
        if (!key) continue;
        notes.push({
          id: key,
          title: String(it.title || '未命名文章').slice(0, 200),
          // 列表接口不返回阅读/互动数（微信已移除），内容级留 0；
          // 账号级阅读/分享/点赞/在看由下方 summary 提供（平台只给账号级口径）
          views: 0, impressions: 0, clicks: 0, likes: 0, comments: 0, collects: 0, shares: 0,
          permissionCode: 0, itemStatus: 20,
          _link: it.link || '',
          _createTime: it.create_time || 0,
        });
      }
      console.log(`[wechat-collect] 列表 ${notes.length}/${total || '?'} 条`);
      if (list.length === 0 || (total > 0 && notes.length >= total)) break;
      await sleep(1200);
    }

    // ---- 2) 账号级互动汇总（内容分析 daily_v2）----
    const summaryRaw = await callApi(`/misc/appmsganalysis?action=report&type=daily_v2&token=${token}&lang=zh_CN&f=json&ajax=1`);
    const pickRange = (arr, rangeType) => {
      if (!Array.isArray(arr)) return 0;
      const hit = arr.find((x) => Number(x?.data_range_type) === rangeType);
      return Number(hit?.data_value || 0);
    };
    // data_range_type: 1=今日 2=近 7 天 3=近 30 天（按微信后台口径；取「今日」写当日行，取「近7天」作参考）
    const summary = {
      reads: pickRange(summaryRaw?.read_summary, 1),
      shares: pickRange(summaryRaw?.share_summary, 1),
      likes: pickRange(summaryRaw?.like_summary, 1),
      wows: pickRange(summaryRaw?.zaikan_summary, 1),
      reads7: pickRange(summaryRaw?.read_summary, 2),
      reads30: pickRange(summaryRaw?.read_summary, 3),
      ok: summaryRaw?.base_resp?.ret === 0,
    };
    console.log('[wechat-collect] 账号级汇总:', JSON.stringify(summary));

    if (notes.length === 0 && !summary.ok) {
      throw new Error('未取到任何数据（列表与汇总接口都为空）');
    }

    // ---- 3) 推送入库 ----
    const envText = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
    const ingestToken = (envText.match(/CONTENT_INGEST_TOKEN="([^"]+)"/) || [])[1];
    if (!ingestToken) throw new Error('.env.local 缺少 CONTENT_INGEST_TOKEN');

    const res = await fetch(`${API}/api/platform-metrics/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ingestToken}` },
      body: JSON.stringify({ platform: PLATFORM, accountId, notes, summary }),
    });
    const out = await res.json().catch(() => null);
    console.log('[wechat-collect] 入库结果 HTTP', res.status, JSON.stringify(out));
    if (!res.ok || !out?.ok) process.exitCode = 1;
  } catch (err) {
    console.error('[wechat-collect] FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    try { ws?.close(); } catch {}
    try { chrome.kill(); } catch {}
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main();
