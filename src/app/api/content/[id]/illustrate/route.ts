import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { generateArticleIllustration } from "@/lib/image-gen";
import {
  buildIllustrationPrompts,
  enhanceIllustrationPrompts,
  insertIllustrations,
  planIllustrationSpots
} from "@/lib/article/illustrate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/content/[id]/illustrate
 * 按文章大意在开头 + 各段前生成 3 张左右配图，写入正文 Markdown。
 * 重复调用会先清掉上一次的自动配图，不会越插越多。
 */
export async function POST(_request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const item = await prisma.contentItem.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!item) return jsonError("内容不存在。", 404);
  if (!item.body?.trim()) return jsonError("这篇作品没有正文，无法按段落生成配图。", 400);

  const spots = planIllustrationSpots(item.body);
  if (!spots.length) return jsonError("正文太短，找不到合适的插图位置。", 400);

  try {
    const basePrompts = buildIllustrationPrompts(spots);
    const prompts = await enhanceIllustrationPrompts(
      user.id,
      item.title,
      item.body,
      basePrompts,
      spots.map((s) => s.topic)
    );

    // 3 张并行出图；单张失败不拖垮整批（内部已有程序化极简背景兜底）。
    const images = await Promise.all(
      prompts.map(async (prompt, index) => {
        try {
          return await generateArticleIllustration(prompt, spots[index]?.topic || item.title, index);
        } catch (error) {
          console.error("[illustrate] 单张配图生成失败：", error);
          return "";
        }
      })
    );
    const usable = images.filter(Boolean);
    if (!usable.length) return jsonError("配图生成失败，请稍后重试。", 502);

    const body = insertIllustrations(item.body, spots, images);
    const contentItem = await prisma.contentItem.update({
      where: { id: item.id },
      data: { body }
    });
    return jsonOk({ contentItem, images: usable, count: usable.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(`生成配图失败：${message}`, 502);
  }
}
