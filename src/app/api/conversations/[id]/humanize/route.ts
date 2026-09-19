import { jsonError, readJson } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { buildHumanizerPrompt } from "@/lib/humanizer-prompt";
import { normalizeHumanizerOutput } from "@/lib/humanizer-parse";

type HumanizeBody = {
  messageId?: string;
};

/** 「去 AI 味」作为一次对话指令时，会话里显示的用户消息文案。 */
const HUMANIZE_INSTRUCTION = "一键去AI味";

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

  const prompt = buildHumanizerPrompt(originalMessage.content);

  const task = await prisma.openClawTask.create({
    data: {
      userId: user.id,
      type: "humanize",
      prompt,
      status: "RUNNING"
    }
  });

  // 「去 AI 味」本身就是对话里的一次指令：先把它作为一条用户消息落库，
  // 会话里能看到这次指令，助手回复紧跟在它后面。
  const instructionMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "USER",
      content: HUMANIZE_INSTRUCTION
    }
  });

  const originalBody = originalMessage.content;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 先把指令消息推给前端，让会话立刻出现这次指令
        controller.enqueue(sseEncode({
          type: "user_message",
          message: {
            id: instructionMessage.id,
            role: "USER",
            content: instructionMessage.content,
            createdAt: instructionMessage.createdAt.toISOString()
          }
        }));

        const result = await openClawClient.sendTaskStream(
          prompt,
          (deltaText) => controller.enqueue(sseEncode({ type: "delta", text: deltaText }))
        );

        const { display, body: articleBody } = normalizeHumanizerOutput(result.content);

        // 安全护栏：解析不出正文、或结果被异常截断时，一律保留原稿，
        // 绝不能用空串/残缺内容覆盖会话消息与内容库文章。
        if (!articleBody) {
          throw new Error("去 AI 味没有返回有效正文，已保留原稿，请重试。");
        }
        if (originalBody.trim().length >= 200 && articleBody.length < originalBody.trim().length * 0.3) {
          throw new Error("去 AI 味结果异常（正文疑似被截断），已保留原稿，请重试。");
        }

        // 结果作为一条新消息追加到会话里：检测报告 → 修改后正文 → 质检报告。
        // 原图文保留不动，方便前后对比。
        const assistantMessage = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: "ASSISTANT",
            content: display
          }
        });

        await prisma.openClawTask.update({
          where: { id: task.id },
          data: {
            status: "SUCCEEDED",
            resultJson: JSON.stringify(result.raw ?? null)
          }
        });

        // 找到这条图文对应的内容库文章，原地更新（不新建条目）
        const candidates = await prisma.contentItem.findMany({
          where: { userId: user.id, sourceConversationId: conversation.id },
          orderBy: { createdAt: "desc" },
          take: 20
        });
        const sourceContent =
          candidates.find((item) => item.body === originalBody) ??
          // 兜底：正文被编辑过导致匹配不上时，取该会话最近一篇非空文章
          candidates.find((item) => item.body.trim().length > 0) ??
          null;
        const saved = sourceContent
          ? await prisma.contentItem.update({ where: { id: sourceContent.id }, data: { body: articleBody } })
          : null;
        const contentSaved = saved ? { id: saved.id, title: saved.title, category: saved.category } : null;

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
