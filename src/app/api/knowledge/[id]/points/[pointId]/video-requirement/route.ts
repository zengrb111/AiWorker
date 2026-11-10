/**
 * 知识点 →「一键生成视频」的创作需求（标题 + 分镜脚本）。
 *
 * 为什么单独一个接口而不是前端拼字符串：
 * 分镜要真的拆——每个镜头写画面和口播，这是模型干的活；前端拼只能拼出
 * 「主题是 X，讲解是 Y」，等于把整段话丢给导演流程，出片全靠它重新理解。
 *
 * 现场生成（不落库）：用户改了讲解稿，上次的分镜就该作废。代价是点击后要等
 * 十几秒，前端用「正在生成分镜…」兜住。
 */
import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { buildVideoRequirement } from "@/lib/kb-wiki";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(
  _request: Request,
  context: { params: { id: string; pointId: string } }
) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const base = await prisma.knowledgeBase.findFirst({
    where: { id: context.params.id, userId: user.id },
    select: { id: true, name: true }
  });
  if (!base) return jsonError("知识库不存在。", 404);

  const point = await prisma.kbKnowledgePoint.findFirst({
    where: { id: context.params.pointId, knowledgeBaseId: base.id }
  });
  if (!point) return jsonError("知识点不存在。", 404);

  try {
    const requirement = await buildVideoRequirement({
      userId: user.id,
      title: point.title,
      explanation: point.explanation,
      videoSeconds: point.videoSeconds
    });
    return jsonOk({
      requirement,
      title: point.title,
      knowledgeBaseName: base.name,
      videoSeconds: point.videoSeconds
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "生成分镜脚本失败。", 500);
  }
}
