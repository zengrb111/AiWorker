/**
 * Studio 评论 → AI 改片（手动触发）。
 *
 * GET  查看当前待处理评论（前端展示「有 N 条待改」）。
 * POST 立刻处理一轮，**流式**返回进度。
 *
 * 与自动接单的关系：真正的处理逻辑在 `huashu-inbox-worker`，手动与自动共用同一把
 * 项目锁 —— 后台正在改时手动点会直接返回「忙」，不会两个 DSH 同时改 index.html。
 *
 * 为什么是 SSE：一次改片是几分钟级的 DSH 任务，普通请求会撞 5 分钟响应头超时
 * （实测客户端报 fetch failed，而服务端其实还在改）。
 */
import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { isProjectProcessing, processPendingComments } from "@/lib/video/huashu-inbox-worker";
import { omInboxList } from "@/lib/video/huashu";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

const HEARTBEAT_MS = 15_000;

function sseEncode(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function GET(_request: Request, { params }: { params: { token: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const project = await prisma.videoMotionProject.findFirst({
    where: { token: params.token, userId: user.id }
  });
  if (!project) return jsonError("视频项目不存在。", 404);

  const comments = await omInboxList(project.projectDir).catch(() => []);
  return jsonOk({
    pending: comments.filter((c) => !c.status || c.status === "pending").length,
    comments,
    busy: isProjectProcessing(project.id)
  });
}

export async function POST(_request: Request, { params }: { params: { token: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const project = await prisma.videoMotionProject.findFirst({
    where: { token: params.token, userId: user.id }
  });
  if (!project) return jsonError("视频项目不存在。", 404);

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sseEncode(event));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => send({ type: "ping", at: Date.now() }), HEARTBEAT_MS);

      try {
        const outcome = await processPendingComments(project, {
          limit: 3,
          onProgress: (text) => send({ type: "delta", text })
        });

        if (outcome.busy) {
          send({ type: "final", processed: [], remaining: 0, message: "后台正在改这一版，稍等它跑完。" });
          return;
        }
        send({
          type: "final",
          processed: outcome.processed,
          remaining: outcome.remaining,
          message: outcome.processed.length
            ? `已按 ${outcome.processed.length} 条评论改完，点「重新出片」生成新版本。`
            : "Studio 里还没有新评论。"
        });
      } catch (error) {
        send({ type: "error", error: error instanceof Error ? error.message : "修改失败。" });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
