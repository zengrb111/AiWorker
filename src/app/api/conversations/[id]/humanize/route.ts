import { jsonError, readJson } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { generateImageUrls } from "@/lib/image-gen";
import { buildHumanizerPrompt } from "@/lib/humanizer-prompt";

type HumanizeBody = {
  messageId?: string;
  title?: string | null;
  category?: string | null;
};

function sseEncode(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) {
    return jsonError("\u672a\u767b\u5f55\u3002", 401);
  }

  const body = await readJson<HumanizeBody>(request);
  const messageId = body.messageId?.trim() ?? "";
  if (!messageId) {
    return jsonError("\u7f3a\u5c11 messageId\u3002");
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!conversation) {
    return jsonError("\u5bf9\u8bdd\u4e0d\u5b58\u5728\u3002", 404);
  }

  // Fetch the original assistant message to humanize
  const originalMessage = await prisma.message.findFirst({
    where: { id: messageId, conversationId: conversation.id }
  });
  if (!originalMessage) {
    return jsonError("\u6d88\u606f\u4e0d\u5b58\u5728\u3002", 404);
  }

  // Save a short user message in the conversation
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "USER",
      content: "\u5bf9\u4ee5\u4e0a\u5185\u5bb9\u8fdb\u884c\u53bb AI \u5473\u5904\u7406"
    }
  });

  const prompt = buildHumanizerPrompt(originalMessage.content);

  const task = await prisma.openClawTask.create({
    data: {
      userId: user.id,
      type: "humanize",
      prompt,
      status: "RUNNING"
    }
  });

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = await openClawClient.sendTaskStream(
          prompt,
          (deltaText) => controller.enqueue(sseEncode({ type: "delta", text: deltaText }))
        );

        const assistantMessage = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: "ASSISTANT",
            content: result.content
          }
        });

        await prisma.openClawTask.update({
          where: { id: task.id },
          data: {
            status: "SUCCEEDED",
            resultJson: JSON.stringify(result.raw ?? null)
          }
        });

        // Auto-save to content library using the original title
        const articleTitle = body.title?.trim() || originalMessage.content.split("\n").find((l) => l.trim().startsWith("#"))?.replace(/^#+\s*/, "").trim().slice(0, 50) || "\u53bb AI \u5473\u7ed3\u679c";
        const images = generateImageUrls(articleTitle, result.content);
        const saved = await prisma.contentItem.create({
          data: {
            userId: user.id,
            title: articleTitle,
            body: result.content,
            category: body.category ?? "\u516c\u4f17\u53f7\u6587\u7ae0",
            coverImageUrl: images.coverImageUrl,
            sourceConversationId: conversation.id
          }
        });

        const contentSaved = { id: saved.id, title: saved.title, category: saved.category };

        controller.enqueue(sseEncode({
          type: "final",
          message: {
            id: assistantMessage.id,
            role: "ASSISTANT",
            content: assistantMessage.content,
            createdAt: assistantMessage.createdAt.toISOString()
          },
          contentSaved
        }));
      } catch (error) {
        await prisma.openClawTask.update({
          where: { id: task.id },
          data: {
            status: "FAILED",
            error: error instanceof Error ? error.message : "OpenClaw \u8c03\u7528\u5931\u8d25\u3002"
          }
        });
        controller.enqueue(sseEncode({
          type: "error",
          error: error instanceof Error ? error.message : "OpenClaw \u8c03\u7528\u5931\u8d25\u3002"
        }));
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    }
  });
}
