import { jsonError, readJson } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { buildHumanizerPrompt } from "@/lib/humanizer-prompt";

type HumanizeBody = {
  messageId?: string;
};

function sseEncode(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

/** 「润色后全文」小标题（正文的起点标记，兼容多种写法）。 */
const POLISHED_HEADING =
  /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*(?:润色后全文|润色后的全文|润色全文|优化后全文|去\s?AI\s?味后全文|修改后全文)[ \t]*(?:\*\*)?[ \t]*(?:[:：])?[ \t]*(?=\n|$)/;

/** 报告类小标题（正文的结束标记）。 */
const REPORT_HEADING =
  /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*(?:AI[ \t]*味?[ \t]*(?:检测)?[ \t]*报告|AI[ \t]*味?[ \t]*(?:检测|质检)|修改统计|质检报告|检测报告|修改说明)[ \t]*(?:\*\*)?[ \t]*(?:[:：])?[ \t]*(?=\n|$)/;

/** 去掉正文首尾的空白与残留分隔线。 */
function cleanBody(text: string): string {
  return text
    .replace(/^[\s\n]+/, "")
    .replace(/(?:\n[ \t]*(?:-{3,}|\*{3,}|_{3,}|—{2,}|={3,})[ \t]*)+[\s]*$/, "")
    .replace(/[\s\n]+$/, "")
    .trim();
}

/**
 * 从「去 AI 味」的原始输出里取出报告部分（AI 味检测报告 / 修改统计 / 质检报告）。
 * 返回空串表示这次输出里没有报告。
 */
function extractHumanizedReport(raw: string): string {
  const content = raw.replace(/\r\n/g, "\n").trim();
  if (!content) return "";

  const polished = POLISHED_HEADING.exec(content);
  if (polished) {
    // 新格式：正文在前、报告在后，从「润色后全文」之后再找报告标题
    const tail = content.slice(polished.index + polished[0].length);
    const stop = REPORT_HEADING.exec(tail);
    if (stop) return tail.slice(stop.index).trim();
    return "";
  }

  // 旧格式兜底：报告可能在正文之前
  const report = REPORT_HEADING.exec(content);
  return report ? content.slice(report.index).trim() : "";
}

/**
 * 从「去 AI 味」的原始输出里剥离出真正的文章正文。
 *
 * 兼容两种输出顺序：
 *  - 正文在前、报告在后（当前 prompt 要求的格式）；
 *  - 报告在前、正文在后（历史格式）。
 * 全都解析不出来时返回整段原文，绝不返回空串去覆盖原稿。
 */
function extractHumanizedBody(raw: string): string {
  const content = raw.replace(/\r\n/g, "\n").trim();
  if (!content) return "";

  // 策略 1：从「润色后全文」小标题之后开始，截到下一个报告小标题
  const polished = POLISHED_HEADING.exec(content);
  if (polished) {
    const after = content.slice(polished.index + polished[0].length);
    const stop = REPORT_HEADING.exec(after);
    const body = cleanBody(stop ? after.slice(0, stop.index) : after);
    if (body) return body;
  }

  // 策略 2：截断到第一个报告小标题（正文在前的情况）
  const report = REPORT_HEADING.exec(content);
  if (report && report.index > 0) {
    const body = cleanBody(content.slice(0, report.index));
    if (body) return body;
  }

  // 策略 3：模型没输出报告，整段就是正文
  return cleanBody(content);
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

  const originalBody = originalMessage.content;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = await openClawClient.sendTaskStream(
          prompt,
          (deltaText) => controller.enqueue(sseEncode({ type: "delta", text: deltaText }))
        );

        const articleBody = extractHumanizedBody(result.content);

        // 安全护栏：解析不出正文、或结果被异常截断时，一律保留原稿，
        // 绝不能用空串/残缺内容覆盖会话消息与内容库文章。
        if (!articleBody) {
          throw new Error("去 AI 味没有返回有效正文，已保留原稿，请重试。");
        }
        if (originalBody.trim().length >= 200 && articleBody.length < originalBody.trim().length * 0.3) {
          throw new Error("去 AI 味结果异常（正文疑似被截断），已保留原稿，请重试。");
        }

        // 结果作为一条新消息追加到会话里：新图文 + 对应的去 AI 味报告。
        // 原图文保留不动，方便前后对比。
        const report = extractHumanizedReport(result.content);
        const humanizedMessage = report
          ? `${articleBody}\n\n---\n\n${report}`
          : articleBody;

        const assistantMessage = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: "ASSISTANT",
            content: humanizedMessage
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
