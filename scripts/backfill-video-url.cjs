// 一次性回填：把已渲染好的短视频 MP4 关联回内容库的「视频」条目（videoUrl 为空）。
// 背景：定时任务的视频渲染任务曾与用户聊天会话抢同一 agent 会话而超时，
// 成片虽渲染成功但未回填 videoUrl，内容库条目因此看起来只有图文。
// 仅影响本次列出的条目；不动其他用户数据。
// 用法：node scripts/backfill-video-url.cjs [--dry]
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// 从 .env.local 读取 DATABASE_URL（Prisma 不会自动加载 .env.local）
if (!process.env.DATABASE_URL) {
  const envRaw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const m = envRaw.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
  if (m) process.env.DATABASE_URL = m[1].trim();
}
const { PrismaClient } = require(path.join(ROOT, 'src/generated/prisma'));
const prisma = new PrismaClient();

const DRY = process.argv.includes('--dry');
const USER = 'cmuz5serd0005ekj34qghwe9x';

const PLAN = {
  cmv6shykh003f3ncb89xh5alf: { videoUrl: '/videos/content-video-1791900699905-el5rijvd-title.mp4' },
  cmv6reroi001b3ncb68ax5v06: { videoUrl: '/videos/content-video-1791900699905-el5rijvd-title.mp4' },
  cmv6shsxc002t3ncbn2gkeoxm: { videoUrl: '/videos/content-video-1791902520834-7pi60ldl.mp4' },
  cmv6reror001d3ncbz39zyxn0: { videoUrl: '/videos/content-video-1791902520834-7pi60ldl.mp4' },
};

const absOf = (url) => path.join(ROOT, 'public', url.replace(/^\//, ''));

(async () => {
  let changed = 0;
  for (const [id, patch] of Object.entries(PLAN)) {
    const item = await prisma.contentItem.findUnique({ where: { id } });
    if (!item) { console.log(`SKIP ${id}：条目不存在`); continue; }
    if (item.userId !== USER) { console.log(`SKIP ${id}：不属于目标用户`); continue; }
    if (!fs.existsSync(absOf(patch.videoUrl))) { console.log(`SKIP ${id}：成片文件不存在 ${patch.videoUrl}`); continue; }
    if (item.videoUrl === patch.videoUrl) { console.log(`OK   ${id}：已是该成片，跳过`); continue; }
    console.log(`${DRY ? 'DRY ' : 'SET '}${id}  「${item.title}」  ${item.videoUrl || '(空)'} -> ${patch.videoUrl}`);
    changed++;
    if (!DRY) {
      await prisma.contentItem.update({ where: { id }, data: { videoUrl: patch.videoUrl } });
    }
  }
  console.log(`\n${DRY ? '[dry] 将更新' : '已更新'} ${changed} 条`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
