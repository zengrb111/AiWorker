import { prisma } from "@/lib/prisma";

/**
 * 发布/删除类接口共用的「目标解析」：
 * 调用方可以给 contentId，也可以只给标题关键词。
 * 解析结果带上内容归属账号（内容库按账号隔离，发布/删除都要按归属账号的授权来）。
 */

export type PublishTargetInput = {
  contentId?: string;
  title?: string;
  hgwxCategory?: string;
  category?: string;
};

export type ResolvedPublishTarget = {
  contentId: string | null;
  title: string | null;
  userId: string | null;
  phone: string | null;
  hgwxCategory?: string;
  category?: string;
  error?: string;
};

export async function resolvePublishTargets(
  items: PublishTargetInput[],
  fallbackUser: { id: string; phone: string } | null
): Promise<ResolvedPublishTarget[]> {
  const targets: ResolvedPublishTarget[] = [];

  for (const item of items) {
    if (item?.contentId) {
      const found = await prisma.contentItem.findUnique({
        where: { id: item.contentId },
        select: { id: true, title: true, userId: true }
      });
      if (!found) {
        targets.push({
          contentId: null,
          title: null,
          userId: null,
          phone: null,
          error: `内容库里找不到 id 为 ${item.contentId} 的内容`
        });
        continue;
      }
      const owner = await prisma.user.findUnique({
        where: { id: found.userId },
        select: { phone: true }
      });
      targets.push({
        contentId: found.id,
        title: found.title,
        userId: found.userId,
        phone: owner?.phone ?? null,
        hgwxCategory: item.hgwxCategory,
        category: item.category
      });
      continue;
    }

    const keyword = String(item?.title || "").trim();
    if (!keyword) {
      targets.push({
        contentId: null,
        title: null,
        userId: null,
        phone: null,
        error: "缺少 contentId 或 title"
      });
      continue;
    }

    // 优先在指定账号内找，找不到再全局找最新的一条
    const found =
      (fallbackUser
        ? await prisma.contentItem.findFirst({
            where: { title: { contains: keyword }, userId: fallbackUser.id },
            orderBy: { createdAt: "desc" },
            select: { id: true, title: true, userId: true }
          })
        : null) ??
      (await prisma.contentItem.findFirst({
        where: { title: { contains: keyword } },
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true, userId: true }
      }));

    if (!found) {
      targets.push({
        contentId: null,
        title: keyword,
        userId: null,
        phone: null,
        error: `内容库里找不到标题含「${keyword}」的内容`
      });
      continue;
    }
    const owner = await prisma.user.findUnique({
      where: { id: found.userId },
      select: { phone: true }
    });
    targets.push({
      contentId: found.id,
      title: found.title,
      userId: found.userId,
      phone: owner?.phone ?? null,
      hgwxCategory: item.hgwxCategory,
      category: item.category
    });
  }

  return targets;
}
