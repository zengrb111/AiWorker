/**
 * 图生视频（huashu-motion 链路）—— 一次性直出。
 *
 * 真正的出片流程在 `lib/video/huashu-generate.ts`（定时任务也用同一套），
 * 这里只负责：鉴权、解析表单（含参考图文件）、把进度用 SSE 转给前端。
 *
 * 约束：竖版 1080×1920、网站与参考图至少有一个。成片时长由创作需求决定
 *（提示词写了「N 秒 / N 分钟」就用它，没写则不限制，DSH 按内容自然展开）。
 */
import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { huashuAvailable, parseHuashuDuration } from "@/lib/video/huashu";
import { runHuashuGeneration, type HuashuImageInput } from "@/lib/video/huashu-generate";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

const HEARTBEAT_MS = 15_000;

function sseEncode(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const conversation = await prisma.conversation.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!conversation) return jsonError("对话不存在。", 404);

  const availability = huashuAvailable();
  if (!availability.ok) return jsonError(availability.reason || "huashu-motion 不可用。", 500);

  const form = await request.formData();
  const siteUrl = String(form.get("siteUrl") ?? "").trim();
  const requirement = String(form.get("requirement") ?? "").trim();
  const imageFiles = (form.getAll("image") || []).filter(
    (entry): entry is File => entry instanceof File && entry.size > 0
  );

  if (!requirement) return jsonError("请填写创作需求（它会作为产品名称使用）。");
  if (siteUrl && !/^https?:\/\//i.test(siteUrl)) return jsonError("产品网站需以 http:// 或 https:// 开头。");
  if (!siteUrl && imageFiles.length === 0) return jsonError("产品网站与参考图至少填一个。");

  const images: HuashuImageInput[] = [];
  for (const file of imageFiles) {
    images.push({ filename: file.name, data: Buffer.from(await file.arrayBuffer()) });
  }

  // 对话「一键生成视频」：时长完全交给提示词。提示词里写了「30秒 / 1分钟」就用它，
  // 没写就传 null（不限制，DSH 按内容自然展开），取代原先固定的 20s 上限。
  const targetSeconds = parseHuashuDuration(requirement);

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sseEncode(event));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => safeEnqueue({ type: "ping", at: Date.now() }), HEARTBEAT_MS);

      try {
        const result = await runHuashuGeneration({
          userId: user.id,
          conversationId: conversation.id,
          requirement,
          siteUrl: siteUrl || null,
          images,
          targetSeconds,
          onProgress: (text) => safeEnqueue({ type: "delta", text: `${text}\n` })
        });

        safeEnqueue({
          type: "final",
          videoUrl: result.videoUrl,
          duration: result.duration,
          projectToken: result.projectToken,
          studioUrl: null,
          contentSaved: {
            id: result.contentId,
            title: requirement.slice(0, 60),
            category: "视频",
            videoUrl: result.videoUrl
          }
        });
      } catch (error) {
        safeEnqueue({ type: "error", error: error instanceof Error ? error.message : "视频生成失败。" });
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
