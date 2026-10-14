import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { HGWX_CHANNEL, publishContentToHgwx, type HgwxPublishOptions } from "@/lib/hgwx-publish";
import { HEALING_CHANNEL, publishContentToHealing, type HealingPublishOptions } from "@/lib/healing-publish";
import { FRONTIER_CHANNEL, publishContentToFrontier, type FrontierPublishOptions } from "@/lib/frontier-publish";

/**
 * POST /api/content/[id]/publish —— 把一条内容库条目发布到指定渠道。
 *
 * 支持的渠道：
 * - 官网好物推荐（hgwx.aimemory.cafe）：channel = "hgwx"（默认）
 * - 官网心灵驿站（aimemory.cafe）：channel = "healing"（需先在「平台授权管理」配置官网为 aimemory.cafe + 心灵驿站令牌）
 *
 * 请求体（均可选）：{ "channel": "hgwx", "hgwxCategory": "产品热点", "badge": "今日必看", "force": false }
 */
export const dynamic = "force-dynamic";

const HGWX_CHANNELS = new Set([HGWX_CHANNEL, "hgwx"]);
const HEALING_CHANNELS = new Set([HEALING_CHANNEL, "healing", "xinling"]);
const FRONTIER_CHANNELS = new Set([FRONTIER_CHANNEL, "aiworker"]);

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const body = await readJson<{ channel?: string } & HgwxPublishOptions & HealingPublishOptions & FrontierPublishOptions>(request);
  const channel = (body.channel || HGWX_CHANNEL).trim();

  const contentItem = await prisma.contentItem.findFirst({
    where: { id: context.params.id, userId: user.id },
    select: { id: true }
  });
  if (!contentItem) {
    return jsonError("内容不存在。", 404);
  }

  try {
    if (HEALING_CHANNELS.has(channel)) {
      const result = await publishContentToHealing(contentItem.id, user.id, user.phone, {
        category: body.category,
        publishedAt: body.publishedAt,
        force: body.force
      });
      return jsonOk(result);
    }

    if (FRONTIER_CHANNELS.has(channel)) {
      const result = await publishContentToFrontier(contentItem.id, user.id, user.phone, {
        tag: body.tag,
        date: body.date,
        link: body.link,
        force: body.force
      });
      return jsonOk(result);
    }

    if (!HGWX_CHANNELS.has(channel)) {
      return jsonError(`暂不支持的发布渠道：${channel}（支持「官网好物推荐」「官网心灵驿站」「官网-AI员工（AI最前沿）」）。`);
    }

    const result = await publishContentToHgwx(contentItem.id, user.phone, {
      hgwxCategory: body.hgwxCategory,
      badge: body.badge,
      sort: body.sort,
      force: body.force
    });
    return jsonOk(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(`发布失败：${message}`, 502);
  }
}
