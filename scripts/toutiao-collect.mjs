/**
 * 头条号创作者后台数据采集器（一键全量同步）。
 *
 * 头条号「内容管理」feed 接口（/api/feed/mp_provider/v1/）服务端带 Cookie 直连可用
 * （无签名风控），用响应里的 offset 值链式翻页抓全量，推送到平台入库。
 *
 * 用法：
 *   1. Cookie 保存在项目根 .toutiao-cookie.txt（已 gitignore；失效后从
 *      mp.toutiao.com 后台 F12 → Network → 任意请求 Request Headers 复制整段 Cookie 覆盖）
 *   2. node scripts/toutiao-collect.mjs   （需先启动 dev server :3000）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const API = process.env.AIWORKER_API || 'http://127.0.0.1:3000';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

function readCookie() {
  const file = path.join(ROOT, '.toutiao-cookie.txt');
  try {
    return fs.readFileSync(file, 'utf8').trim().replace(/^["']|["']$/g, '');
  } catch {
    console.error('缺少 .toutiao-cookie.txt（头条号后台 Cookie）。');
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractId(cell) {
  const urls = [
    cell?.shareInfo?.shareURL,
    cell?.articleBase?.articleURL,
  ].filter(Boolean).join(' ');
  const m = /\/(?:a|i)(\d{10,})\/?/.exec(urls) || /thread\/(\d{10,})/.exec(urls);
  return m ? m[1] : '';
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&\w+;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function main() {
  const cookie = readCookie();

  // 1. 验证凭据 + 拿账号信息
  const infoRes = await fetch('https://mp.toutiao.com/mp/agw/creator_center/user_info?app_id=1231', {
    headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://mp.toutiao.com/profile_v4/manage/content/all', Accept: 'application/json' },
    cache: 'no-store',
  });
  const info = await infoRes.json().catch(() => null);
  if (!info || info.code !== 0 || !info.user_id) {
    console.error('凭据验证失败，Cookie 可能已失效：', JSON.stringify(info).slice(0, 200));
    process.exit(1);
  }
  console.log(`账号验证通过：${info.name}（粉丝 ${info.total_fans_count}）`);

  // 2. feed 全量翻页（offset 链式）
  const base = 'https://mp.toutiao.com/api/feed/mp_provider/v1/?provider_type=mp_provider&aid=13&app_name=news_article&category=mp_all&channel=&stream_api_version=88'
    + '&genre_type_switch=%7B%22repost%22%3A1%2C%22small_video%22%3A1%2C%22toutiao_graphic%22%3A1%2C%22weitoutiao%22%3A1%2C%22xigua_video%22%3A1%7D'
    + `&device_platform=pc&platform_id=0&visited_uid=${info.user_id}&count=20&keyword=&app_id=1231`
    + '&client_extra_params=%7B%22category%22%3A%22mp_all%22%2C%22real_app_id%22%3A%221231%22%2C%22need_forward%22%3A%22true%22%2C%22offset_mode%22%3A%221%22%2C%22page_index%22%3A%22REPLACE_PAGE%22%2C%22status%22%3A%228%22%2C%22source%22%3A%220%22%7D';

  const byId = new Map();
  let consecutiveEmpty = 0;
  for (let i = 0; i < 200; i++) {
    const url = base.replace('REPLACE_PAGE', String(i + 1)) + `&offset=${byId.size}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://mp.toutiao.com/profile_v4/manage/content/all', Accept: 'application/json' },
      cache: 'no-store',
    });
    if (res.status !== 200) {
      console.error(`HTTP ${res.status} @ page ${page}，停止`);
      break;
    }
    const j = await res.json().catch(() => null);
    const cells = (j?.data || []).map((d) => d?.assembleCell?.itemCell).filter(Boolean);
    let added = 0;
    for (const cell of cells) {
      const id = extractId(cell);
      if (!id || byId.has(id)) continue;
      const c = cell.itemCounter || {};
      const title =
        stripHtml(cell.richContentInfo?.titleRichSpan) ||
        stripHtml(cell.richContentInfo?.richContent) ||
        stripHtml(cell.articleBase?.content) ||
        '未命名内容';
      byId.set(id, {
        id,
        title: title.slice(0, 120),
        time: cell.articleBase?.publishTime || 0,
        type: cell.videoInfo ? '视频' : '图文',
        views: Number(c.readCount || 0) + Number(c.videoWatchCount || 0),
        clicks: Number(c.showCount || 0),
        likes: Number(c.diggCount || 0),
        comments: Number(c.commentCount || 0),
        collects: Number(c.repinCount || 0),
        shares: 0,
      });
      added++;
    }
    if (i % 10 === 0 || cells.length === 0) {
      console.log(`page ${i + 1}: cells=${cells.length} added=${added} total=${byId.size} has_more=${j?.has_more}`);
    }
    if (cells.length === 0 || added === 0 || !j?.has_more) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3 || !j?.has_more) break;
    } else {
      consecutiveEmpty = 0;
    }
    await sleep(280);
  }

  const notes = [...byId.values()];
  const totalViews = notes.reduce((s, n) => s + n.views, 0);
  const totalShow = notes.reduce((s, n) => s + n.clicks, 0);
  console.log(`采集完成：${notes.length} 条内容，阅读+播放 ${totalViews}，展现 ${totalShow}`);
  if (notes.length === 0) {
    console.error('未采集到任何内容，中止');
    process.exit(1);
  }

  // 3. 推送入库
  const token = (fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').match(/CONTENT_INGEST_TOKEN="([^"]+)"/) || [])[1];
  if (!token) throw new Error('.env.local 缺少 CONTENT_INGEST_TOKEN');
  const res = await fetch(`${API}/api/platform-metrics/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ platform: 'toutiao', notes }),
  });
  const out = await res.json().catch(() => null);
  console.log('入库结果 HTTP', res.status, JSON.stringify(out));
  if (!res.ok || !out?.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
