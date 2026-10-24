/**
 * GET /api/video-motion/active?conversationId=xxx
 *
 * 「这条会话里的视频是否正在被后台自动修改」。
 *
 * 为什么需要它：后台 tick 改片会往会话里写进度消息，但聊天区平时不轮询；
 * 前端拿这个接口做轻量心跳（只查内存标记 + 一次 DB 查询），
 * 有处理中才去刷新消息，避免一直拉整份会话列表。
 */
import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { isProjectProcessing } from "@/lib/video/huashu-inbox-worker";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const conversationId = new URL(request.url).searchParams.get("conversationId")?.trim();
  if (!conversationId) return jsonError("缺少 conversationId。", 400);

  const projects = await prisma.videoMotionProject.findMany({
    where: { userId: user.id, conversationId },
    select: { token: true, id: true, status: true }
  });

  const active = projects.filter((project) => isProjectProcessing(project.id));
  return jsonOk({
    processing: active.length > 0,
    tokens: active.map((project) => project.token)
  });
}
