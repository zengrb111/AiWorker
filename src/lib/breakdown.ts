import { prisma } from "./prisma";
import { openClawClient } from "./openclaw";
import path from "node:path";
import fs from "node:fs";

/**
 * 爆款内容拆解服务：
 * 1. 只基于**真实原文**做拆解，并且**只提炼优势点**（原文来自 ContentSource，由采集器在采集效果数据时一并抓取）；
 *    取不到原文就如实报错，不做「通用规律推断」——那种拆解对创作没有指导价值。
 * 2. 拆解结果可人工二次编辑（落库 editedBreakdown）；
 * 3. 标记为 active 后，汇总写入 OpenClaw 知识目录，供每日内容生产任务参考，提高内容质量。
 */

const PLATFORM_NAME: Record<string, string> = {
  xhs: "小红书",
  toutiao: "头条号",
  site: "官网好物推荐",
  wechat: "公众号",
  channels: "视频号",
};

/** 每日任务读取的拆解汇总文件目录（与每日任务知识库同根） */
export const HIT_BREAKDOWN_DIR =
  "C:\\Users\\zengr\\.openclaw\\workspace\\knowledge\\hit-breakdown";
export const HIT_BREAKDOWN_FILE = path.join(HIT_BREAKDOWN_DIR, "爆款拆解方法论.md");

export type OriginalContent = {
  title: string;
  body: string;
  topics?: string | null;
  author?: string | null;
  source: string;
};

/**
 * 取该条内容的真实原文。
 * 优先读 ContentSource（采集时抓好的）；官网再兜底查发布记录关联的内容库正文。
 * 取不到返回 null —— 调用方应直接报错，不要退化成通用推断。
 */
export async function fetchOriginalContent(
  platform: string,
  contentKey: string
): Promise<OriginalContent | null> {
  try {
    const src = await prisma.contentSource.findUnique({
      where: { platform_contentKey: { platform, contentKey } },
    });
    if (src && src.body.trim()) {
      return {
        title: src.title,
        body: src.body,
        topics: src.topics,
        author: src.author,
        source: src.source,
      };
    }
    if (platform === "site") {
      const rec = await prisma.publishRecord.findFirst({ where: { remoteId: contentKey } });
      if (rec) {
        const item = await prisma.contentItem.findUnique({ where: { id: rec.contentItemId } });
        if (item?.body?.trim()) {
          return {
            title: item.title || rec.title || "",
            body: item.body,
            source: "content-item",
          };
        }
      }
    }
  } catch {
    /* 查库失败按「没原文」处理 */
  }
  return null;
}

/** 该内容是否有可拆解的原文（前端据此决定「拆解」按钮是否可用） */
export async function hasOriginalContent(platform: string, contentKey: string): Promise<boolean> {
  return (await fetchOriginalContent(platform, contentKey)) !== null;
}

/** 构造拆解 prompt（只提炼优势点，基于真实原文，贴合金润瀚宇人设） */
export function buildAnalyticsDecomposePrompt(opts: {
  platform: string;
  title: string;
  views: number;
  original: OriginalContent;
}): string {
  const pName = PLATFORM_NAME[opts.platform] || opts.platform;
  const dims = [
    "1. 选题优势（写给谁看、切中了什么情绪或需求，为什么这个角度容易起量）",
    "2. 标题优势（哪个词或结构在拉点击，给出可复用的句式模板）",
    "3. 开头优势（前 3 句是怎么抓住注意力的，逐句说清好在哪）",
    "4. 结构优势（分段模块与节奏怎么安排的，每段承担什么作用）",
    "5. 情绪优势 / 金句（哪些原句引发共鸣，为什么戳人）",
    "6. 互动优势（结尾怎么引导评论、收藏、关注）",
    "7. 可复用要素清单（直接给大彬/金润瀚宇后续创作可照抄的骨架）",
  ].join("\n");
  const meta: string[] = [];
  if (opts.original.author) meta.push(`作者：${opts.original.author}`);
  if (opts.original.topics) meta.push(`话题标签：${opts.original.topics}`);
  return [
    `请对下面这条「${pName}」爆款内容做优势拆解，目的是提炼出可复用到后续创作里的有效做法。`,
    "",
    "硬性要求：",
    "- **必须严格基于下面给出的真实原文**，每一处结论都要能对应到原文的具体句子。",
    "- **只写它做得好的地方**。全篇不要出现任何不足、缺点、问题、风险、改进建议、「可以更好」这类负面或改进性表述，也不要评价它「没做到什么」。",
    "- 不做改写、不生成新内容。",
    "",
    `标题：${opts.title}`,
    `阅读/播放量：${opts.views}`,
    ...meta,
    "",
    "【原文开始】",
    opts.original.body.slice(0, 8000),
    "【原文结束】",
    "",
    "请按以下 7 个维度用 Markdown 结构化输出，每一点都要引用原文中的具体句子作为依据：",
    dims,
  ].join("\n");
}

/** 触发一次 AI 拆解，返回 Markdown 文本；拿不到原文直接抛错 */
export async function decomposeContent(opts: {
  platform: string;
  contentKey: string;
  title: string;
  views: number;
}): Promise<string> {
  const original = await fetchOriginalContent(opts.platform, opts.contentKey);
  if (!original) {
    throw new Error(
      "未取到该内容的原文（视频类内容无文字原文，或原文尚未采集），暂无法拆解。请先在效果分析点「同步数据」重新采集。"
    );
  }
  if (original.body.trim().length < 30) {
    throw new Error("该内容原文过短（不足 30 字），没有可拆解的结构。");
  }
  const prompt = buildAnalyticsDecomposePrompt({ ...opts, original });
  const result = await openClawClient.sendTask(prompt);
  const text = result?.content?.trim();
  if (!text) throw new Error("模型未返回拆解内容");
  return text;
}

/** 把已标记为 active 的拆解汇总写入每日任务知识目录 */
export async function writeHitBreakdownFile(): Promise<{ ok: boolean; count: number; path: string }> {
  const rows = await prisma.contentBreakdown.findMany({
    where: { status: "active" },
    orderBy: { metricViews: "desc" },
  });
  const parts: string[] = [];
  parts.push("# 爆款内容拆解方法论（每日内容生产参考）");
  parts.push("");
  parts.push(
    "本文件由「效果分析 → 爆款拆解」功能自动汇总，记录了经人工确认的高阅读量内容拆解结论。" +
      "请在大彬/金润瀚宇的内容创作中**复用其中的结构骨架、标题公式、情绪钩子与互动引导**，但选题/素材/案例换成与产品、账号相关的内容，保持人设一致、不硬广。"
  );
  parts.push("");
  if (rows.length === 0) {
    parts.push("_（暂无已确认的爆款拆解。在效果分析里对高阅读量内容点击「拆解」→ 编辑 → 设为每日任务参考后，这里会自动出现。）_");
  } else {
    for (const r of rows) {
      const body = r.editedBreakdown || r.aiBreakdown;
      parts.push(`## ${r.title}`);
      parts.push(`- 渠道：${PLATFORM_NAME[r.platform] || r.platform}｜阅读/播放量：${r.metricViews}`);
      parts.push("");
      parts.push(body.trim());
      parts.push("");
    }
  }
  const content = parts.join("\n");
  try {
    fs.mkdirSync(HIT_BREAKDOWN_DIR, { recursive: true });
    fs.writeFileSync(HIT_BREAKDOWN_FILE, content, "utf8");
  } catch (e) {
    throw new Error(`写入拆解参考文件失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: true, count: rows.length, path: HIT_BREAKDOWN_FILE };
}
