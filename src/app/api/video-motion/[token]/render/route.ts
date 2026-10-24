/**
 * 重新出片：Studio 改完 index.html 后，生成新版本 vN。
 *
 * 逻辑在 `huashu-inbox-worker#rerenderProject`（自动接单的 tick 也调它），
 * 这里只做鉴权与错误转 HTTP。
 */
import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { rerenderProject } from "@/lib/video/huashu-inbox-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function POST(_request: Request, { params }: { params: { token: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const project = await prisma.videoMotionProject.findFirst({
    where: { token: params.token, userId: user.id }
  });
  if (!project) return jsonError("视频项目不存在。", 404);

  try {
    const next = await rerenderProject(project);
    return jsonOk(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : "重新出片失败。";
    await prisma.videoMotionProject
      .update({ where: { id: project.id }, data: { status: "FAILED", error: message.slice(0, 1000) } })
      .catch(() => undefined);
    return jsonError(message, 500);
  }
}
