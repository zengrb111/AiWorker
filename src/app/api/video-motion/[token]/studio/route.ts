/**
 * Studio：为一条视频项目启动（或复用）huashu-motion 的可视化编辑器。
 *
 * Studio 只监听 127.0.0.1（om 自己起的是本机服务），平台与浏览器在同一台机器时
 * 直接可用；以后要远程访问需要再加反向代理。
 */
import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { ensureStudio } from "@/lib/video/huashu";
import { existsSync } from "node:fs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(_request: Request, { params }: { params: { token: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const project = await prisma.videoMotionProject.findFirst({
    where: { token: params.token, userId: user.id }
  });
  if (!project) return jsonError("视频项目不存在。", 404);
  if (!existsSync(project.projectDir)) return jsonError("项目目录已被清理，请重新生成视频。", 410);

  try {
    const studio = await ensureStudio(project.projectDir);
    await prisma.videoMotionProject.update({
      where: { id: project.id },
      data: { studioPort: studio.port }
    });
    return jsonOk({ url: studio.url, port: studio.port, reused: studio.reused });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Studio 启动失败。", 500);
  }
}
