import { prisma } from "@/lib/prisma";
import {
  coverPlatformOf,
  generateCoverImage,
  generateImageUrls,
  type CoverPlatform
} from "@/lib/image-gen";

/**
 * 外部内容入库（定时任务产物 → 内容库）。
 *
 * 定时任务跑在 OpenClaw 侧，产出的图文只是 Markdown 文件；本模块负责把它们
 * 落成内容库里的 ContentItem，让用户能在「内容库」里直接审核、编辑、复制。
 */

export type IngestItem = {
  /** 标题；缺省时从正文首个 # 标题行提取 */
  title?: string;
  /** Markdown 正文 */
  body?: string;
  /** 平台分类：小红书 / 公众号 */
  category?: string;
};

export type IngestSaved = { id: string; title: string; category: string };
export type IngestSkipped = { title: string; reason: string };
export type IngestResult = { saved: IngestSaved[]; skipped: IngestSkipped[] };

/** 正文至少要有这么多字才算一篇成品，避免把热点清单之类的东西灌进内容库。 */
const MIN_BODY_LENGTH = 200;

/** 从 Markdown 正文里提取标题：优先一级/二级标题，其次首个非空行。 */
export function extractArticleTitle(body: string, fallback = "未命名内容"): string {
  const lines = body.split("\n").map((line) => line.trim());
  const heading = lines.find((line) => /^#{1,2}\s+\S/.test(line));
  if (heading) {
    return heading.replace(/^#{1,2}\s+/, "").replace(/\*\*/g, "").trim().slice(0, 120);
  }
  const first = lines.find((line) => line && !/^[#>|`\-*]/.test(line));
  if (first) {
    return first.replace(/[*_`]/g, "").trim().slice(0, 120);
  }
  return fallback;
}

/**
 * 归一化平台分类。必须归到「小红书」/「公众号文章」这两个词上，
 * 因为前端内容库的筛选项是按 `category.includes("小红书")` /
 * `includes("公众号")` 来分桶的。
 */
export function normalizeCategory(input?: string | null): string {
  const value = (input || "").trim();
  if (/公众号|微信|订阅号|服务号/.test(value)) return "公众号文章";
  if (/小红书|红书|种草/.test(value)) return "小红书";
  return value || "公众号文章";
}

/**
 * 占位封面先入库、智谱封面后台升级 —— 和对话链路保持一致的策略：
 * 入库不被生图阻塞（生图十几秒），失败也只打日志、保留占位封面。
 */
async function upgradeCoverInBackground(
  contentItemId: string,
  title: string,
  body: string,
  platform: CoverPlatform
): Promise<void> {
  try {
    const localUrl = await generateCoverImage(title, body, platform);
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: { coverImageUrl: localUrl }
    });
  } catch (error) {
    console.error("[content-ingest] 智谱封面后台升级失败（保持占位封面）：", error);
  }
}

/** 当天零点，用于「同一天内同标题」去重。 */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 批量入库。幂等性：同一天内、同一账号下、标题相同的条目会被跳过，
 * 这样定时任务重复跑（调试、补跑）不会灌出一堆重复内容。
 */
export async function ingestContentItems(
  userId: string,
  items: IngestItem[]
): Promise<IngestResult> {
  const saved: IngestSaved[] = [];
  const skipped: IngestSkipped[] = [];
  const dayStart = startOfToday();
  // 同一批里也可能有重复标题，用集合兜住。
  const seenTitles = new Set<string>();

  for (const raw of items) {
    const body = (raw?.body || "").trim();
    const title = (raw?.title?.trim() || extractArticleTitle(body)).slice(0, 120);

    if (body.length < MIN_BODY_LENGTH) {
      skipped.push({ title, reason: `正文过短（${body.length} 字）` });
      continue;
    }
    if (seenTitles.has(title)) {
      skipped.push({ title, reason: "本批内标题重复" });
      continue;
    }

    const duplicated = await prisma.contentItem.findFirst({
      where: { userId, title, createdAt: { gte: dayStart } },
      select: { id: true }
    });
    if (duplicated) {
      skipped.push({ title, reason: "当天已存在同名内容" });
      continue;
    }

    const category = normalizeCategory(raw?.category);
    const platform = coverPlatformOf(category);
    const created = await prisma.contentItem.create({
      data: {
        userId,
        title,
        body,
        category,
        coverImageUrl: generateImageUrls(title, body, 0, platform).coverImageUrl
      }
    });

    seenTitles.add(title);
    saved.push({ id: created.id, title: created.title, category: created.category ?? category });
    void upgradeCoverInBackground(created.id, title, body, platform);
  }

  return { saved, skipped };
}
