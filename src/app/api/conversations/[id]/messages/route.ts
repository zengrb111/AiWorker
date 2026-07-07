import { jsonError, jsonOk, readJson } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

type MessageBody = {
  content?: string;
};

type ConversationMessage = {
  role: string;
  content: string;
  createdAt: Date;
};

const maxContextMessages = 20;
const maxContextCharacters = 12000;

function titleFrom(content: string): string {
  return content.length > 18 ? `${content.slice(0, 18)}...` : content || "新的对话";
}

function roleLabel(message: ConversationMessage): string {
  return message.role === "ASSISTANT" ? "助手" : "用户";
}

function trimContext(value: string): string {
  if (value.length <= maxContextCharacters) {
    return value;
  }
  return `...前文已截断...\n${value.slice(-maxContextCharacters)}`;
}

function buildConversationContext(messages: ConversationMessage[]): string {
  if (!messages.length) {
    return "暂无历史会话。";
  }

  return trimContext(
    messages
      .map((message) => `[${message.createdAt.toLocaleString("zh-CN")}] ${roleLabel(message)}: ${message.content}`)
      .join("\n")
  );
}

function buildTaskPrompt(contextText: string, content: string): string {
  return [
    "请结合以下历史会话上下文继续完成用户任务。",
    "",
    "历史会话：",
    contextText,
    "",
    "当前用户任务：",
    content
  ].join("\n");
}

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const body = await readJson<MessageBody>(request);
  const content = body.content?.trim() ?? "";
  if (!content) {
    return jsonError("请输入消息内容。");
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!conversation) {
    return jsonError("对话不存在。", 404);
  }

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "USER",
      content
    }
  });

  const recentMessages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    take: maxContextMessages
  });
  const conversationContext = buildConversationContext(recentMessages.reverse());
  const prompt = buildTaskPrompt(conversationContext, content);

  const task = await prisma.openClawTask.create({
    data: {
      userId: user.id,
      type: "conversation",
      prompt,
      status: "RUNNING"
    }
  });

  try {
    const result = await openClawClient.sendTask({
      message: content,
      context: conversationContext,
      prompt,
      conversationId: conversation.id,
      userId: user.id
    });
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

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        title: conversation.title === "新的对话" ? titleFrom(content) : conversation.title
      }
    });

    if (result.title || result.coverImageUrl || result.inlineImages?.length) {
      await prisma.contentItem.create({
        data: {
          userId: user.id,
          title: result.title ?? titleFrom(content),
          body: result.content,
          coverImageUrl: result.coverImageUrl,
          inlineImagesJson: JSON.stringify(result.inlineImages ?? []),
          sourceConversationId: conversation.id
        }
      });
    }

    return jsonOk({ message: assistantMessage, taskId: task.id });
  } catch (error) {
    await prisma.openClawTask.update({
      where: { id: task.id },
      data: {
        status: "FAILED",
        error: error instanceof Error ? error.message : "OpenClaw 调用失败。"
      }
    });
    return jsonError(error instanceof Error ? error.message : "OpenClaw 调用失败。", 502);
  }
}