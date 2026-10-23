/**
 * 平台默认定时任务模板。
 *
 * 设计原则：
 * - 通用、不绑定任何账号或具体产品（与 138001/138003 的「专属任务」区分开）。
 * - 不写死 --user / 产品定位：执行时由调度器在「该用户专属会话」里跑（runScheduledJob
 *   会把 job.userId 透传给 agent），结果由平台确定性投递到本人微信。
 * - 任务只负责「产出内容」，入库/发布由各自 prompt 自行决定（默认模板只产出并投递，
 *   不强制入库，避免给没有内容库需求的账号制造脏数据）。
 *
 * 这套模板用于两类场景：
 * 1. 新账号注册时自动初始化（见 api/auth/register）。
 * 2. 存量账号补齐（见 scripts/seed-scheduled-jobs.mjs）。
 */
export type DefaultJobTemplate = {
  name: string;
  cronExpr: string;
  prompt: string;
};

export const DEFAULT_SCHEDULED_JOBS: DefaultJobTemplate[] = [
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

/**
 * 为账号初始化默认定时任务（幂等：已有任务的账号不再重复种）。
 *
 * @param userId  平台用户 id
 * @param enabled 是否启用（注册的新账号默认启用；存量补种可传 false 先暂停）
 * @returns 本次实际新建的任务数
 */
export async function ensureDefaultScheduledJobs(
  userId: string,
  enabled = true
): Promise<number> {
  const { prisma } = await import("@/lib/prisma");
  const existing = await prisma.scheduledJob.count({ where: { userId } });
  if (existing > 0) return 0;
  await prisma.scheduledJob.createMany({
    data: DEFAULT_SCHEDULED_JOBS.map((job) => ({
      userId,
      name: job.name,
      prompt: job.prompt,
      cronExpr: job.cronExpr,
      timezone: "Asia/Shanghai",
      enabled
    }))
  });
  return DEFAULT_SCHEDULED_JOBS.length;
}
