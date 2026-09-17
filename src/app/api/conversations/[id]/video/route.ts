import { jsonError, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { generateVideoFromText } from "@/lib/text-to-video";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type VideoBody = { content?: string };
function titleFrom(content: string): string { return content.length > 18 ? `${content.slice(0, 18)}...` : content || "新的视频"; }
function sseEncode(data: unknown): Uint8Array { return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`); }

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const body = await readJson<VideoBody>(request);
  const content = body.content?.trim() ?? "";
  if (!content) return jsonError("请输入视频描述。", 400);
  const conversation = await prisma.conversation.findFirst({ where: { id: context.params.id, userId: user.id } });
  if (!conversation) return jsonError("对话不存在。", 404);
  await prisma.message.create({ data: { conversationId: conversation.id, role: "USER", content: `[视频制作] ${content}` } });
  const task = await prisma.openClawTask.create({ data: { userId: user.id, type: "text-to-video", prompt: content, status: "RUNNING" } });
  const stream = new ReadableStream({ async start(controller) {
    try {
      controller.enqueue(sseEncode({ type: "delta", text: "正在根据你的文字描述生成动态视频...\n" }));
      const videosDir = join(process.cwd(), "public", "videos");
      if (!existsSync(videosDir)) mkdirSync(videosDir, { recursive: true });
      const videoUrl = await generateVideoFromText(content, videosDir);
      const assistantMessage = await prisma.message.create({ data: { conversationId: conversation.id, role: "ASSISTANT", content: `视频已根据文字描述生成完成。\n\n主题：${content}\n\n文件：${videoUrl}` } });
      const saved = await prisma.contentItem.create({ data: { userId: user.id, title: titleFrom(content), body: "", category: "视频", videoUrl, sourceConversationId: conversation.id } });
      await prisma.openClawTask.update({ where: { id: task.id }, data: { status: "SUCCEEDED", resultJson: JSON.stringify({ videoUrl }) } });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { title: conversation.title === "新的对话" ? titleFrom(content) : conversation.title } });
      controller.enqueue(sseEncode({ type: "final", message: { id: assistantMessage.id, role: "ASSISTANT", content: assistantMessage.content, createdAt: assistantMessage.createdAt.toISOString() }, contentSaved: { id: saved.id, title: saved.title, category: saved.category, videoUrl }, videoUrl }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "视频生成失败。";
      await prisma.openClawTask.update({ where: { id: task.id }, data: { status: "FAILED", error: message } });
      controller.enqueue(sseEncode({ type: "error", error: message }));
    } finally { controller.close(); }
  } });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}