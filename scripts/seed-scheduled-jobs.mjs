/**
 * 存量账号定时任务补种脚本（一次性）。
 *
 * 给「当前没有任何定时任务」的账号补齐平台默认模板
 * （每日小红书 / 每日公众号 / 每日头条号）。为安全默认**暂停**（enabled:false），
 * 避免给测试账号的微信发送每日内容；需要时在 UI 里逐账号开启即可。
 *
 * 与 src/lib/default-scheduled-jobs.ts 的 DEFAULT_SCHEDULED_JOBS 保持一致。
 *
 * 用法：
 *   node scripts/seed-scheduled-jobs.mjs            # 干跑（只报告，不写库）
 *   node scripts/seed-scheduled-jobs.mjs --apply    # 实际写入
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "../src/generated/prisma/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function loadEnv(file) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
}
loadEnv(".env.local");

const APPLY = process.argv.includes("--apply");

// 与 src/lib/default-scheduled-jobs.ts 保持一致的默认模板
const DEFAULT_JOBS = [
  {
    name: "每日小红书",
    cronExpr: "0 9 * * *",
    prompt:
      "写一篇小红书笔记：结合今日热点或生活话题选一个选题，输出标题（带 emoji）、正文（口语化、分点、200-400字）、5-8 个话题标签。风格真实不硬广。"
  },
  {
    name: "每日公众号",
    cronExpr: "0 9 * * *",
    prompt:
      "写一篇公众号文章：选一个有传播力的选题，标题+摘要+正文（1200-1800字，结构清晰、有小标题、有观点和案例），结尾带互动引导。"
  },
  {
    name: "每日头条号",
    cronExpr: "0 9 * * *",
    prompt:
      "写一篇头条号文章：选一个大众关心的热点、民生或知识类选题，标题吸引点击但不标题党，正文 800-1200 字，开头 3 行抓人，分段短、可读性强。"
  }
];

const prisma = new PrismaClient();
const users = await prisma.user.findMany({ select: { id: true, phone: true } });

let seededAccounts = 0;
let seededJobs = 0;
const report = [];

for (const u of users) {
  const count = await prisma.scheduledJob.count({ where: { userId: u.id } });
  if (count > 0) continue; // 已有任务的不动
  if (APPLY) {
    await prisma.scheduledJob.createMany({
      data: DEFAULT_JOBS.map((j) => ({
        userId: u.id,
        name: j.name,
        prompt: j.prompt,
        cronExpr: j.cronExpr,
        timezone: "Asia/Shanghai",
        enabled: false
      }))
    });
  }
  seededAccounts += 1;
  seededJobs += DEFAULT_JOBS.length;
  report.push({ phone: u.phone, id: u.id, jobs: DEFAULT_JOBS.length, enabled: false });
}

console.log(
  APPLY
    ? `✅ 已补种 ${seededAccounts} 个账号、共 ${seededJobs} 条默认定时任务（默认暂停）。`
    : `🔍 干跑：将为 ${seededAccounts} 个空账号补种 ${seededJobs} 条任务（加 --apply 实际写入）。`
);
for (const r of report) {
  console.log(`  ${r.phone} | ${r.id} | +${r.jobs} 条（暂停）`);
}

await prisma.$disconnect();
