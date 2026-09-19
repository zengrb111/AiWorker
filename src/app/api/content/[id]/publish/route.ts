import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { HGWX_CHANNEL, publishContentToHgwx, type HgwxPublishOptions } from "@/lib/hgwx-publish";

/**
 * POST /api/content/[id]/publish —— 把一条内容库条目发布到指定渠道。
 *
 * 目前支持的渠道：官网好物推荐（hgwx.aimemory.cafe）。
 * 请求体（均可选）：{ "channel": "hgwx", "hgwxCategory": "产品热点", "badge": "今日必看", "force": false }
 */
export const dynamic = "force-dynamic";

const SUPPORTED_CHANNELS = new Set([HGWX_CHANNEL, "hgwx"]);

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const body = await readJson<{ channel?: string } & HgwxPublishOptions>(request);
  const channel = (body.channel || HGWX_CHANNEL).trim();
  if (!SUPPORTED_CHANNELS.has(channel)) {
    return jsonError(`暂不支持的发布渠道：${channel}（当前仅支持「官网好物推荐」）。`);
  }

  const contentItem = await prisma.contentItem.findFirst({
    where: { id: context.params.id, userId: user.id },
    select: { id: true }
  });
  if (!contentItem) {
    return jsonError("内容不存在。", 404);
  }

  try {
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
