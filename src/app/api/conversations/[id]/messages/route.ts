import { jsonError, readJson } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { generateImageUrls } from "@/lib/image-gen";

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

const ARTICLE_KEYWORDS = [
  // 文章类型
  "文章", "公众号", "小红书", "写作", "图文", "推文", "帖子", "blog", "笔记", "文案",
  // 选题/话题
  "选题", "话题",
  // 生成/创作指令
  "开工", "继续生成", "继续写", "继续创作", "生成内容", "创作",
  "来一篇", "写一篇", "帮我写", "帮我生成", "帮我创作", "开始写"
];

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

function shouldAutoSave(userMessage: string, conversationContext: string, assistantContent: string): boolean {
  if (assistantContent.length <= 300) return false;
  const combined = `${userMessage} ${conversationContext}`.toLowerCase();
  const hasKeyword = ARTICLE_KEYWORDS.some((kw) => combined.includes(kw.toLowerCase()));
  if (!hasKeyword) return false;

  // 进一步过滤：必须是真正的"图文/文章"内容（含有结构化特征），不能是纯推荐/对话回复
  // 结构特征：markdown 标题、列表项、引号标题、Markdown 链接/加粗
  const hasStructure =
    assistantContent.includes("##") ||                                    // markdown 标题
    assistantContent.includes("\n- ") || assistantContent.includes("\n* ") || // 列表
    /^\d+[.、．)）]\s*\S+/m.test(assistantContent) ||                     // 数字列表
    /[「『"'""''].{2,40}[」』""'']/.test(assistantContent) ||             // 引号标题
    /\*\*[^*\n]{2,30}\*\*/.test(assistantContent);                        // 加粗短语
  if (!hasStructure) return false;

  // 排除明显的"推荐/查询"回复：开头就是"以下是"、"根据"、"结合"等引导词，且内容里没有"选题/标题"等明确文章词
  const isRecommendation = /^(结合|根据|以下|参考|看到|听说|你好|感谢)/.test(assistantContent.trim());
  const hasExplicitArticle = /标题[：:]|选题|写作|生成一?篇|正文[：:]|封面[：:]/i.test(assistantContent);
  if (isRecommendation && !hasExplicitArticle) return false;

  return true;
}

/**
 * 根据用户消息判断文章分类标签。
 * 默认 "公众号文章"；提到小红书相关关键词时改为 "小红书"。
 */
function detectCategory(userMessage: string, conversationContext: string): string {
  const XHS_KEYWORDS = ["小红书", "小红薯", "种草", "xhs", "xhongshu"];
  const combined = `${userMessage} ${conversationContext}`.toLowerCase();
  if (XHS_KEYWORDS.some((kw) => combined.includes(kw.toLowerCase()))) {
    return "小红书";
  }
  return "公众号文章";
}

function generateArticleTitle(content: string): string {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);

  // 1. 优先用 markdown 标题
  for (const line of lines) {
    if (line.startsWith("#")) {
      const title = line.replace(/^#+\s*/, "").trim();
      if (title) return title.slice(0, 50);
    }
  }

  // 2. 尝试从列表项里找第一个有标题感的
  //    - 数字列表： 1. xxx / 1）xxx / 1、xxx
  //    - 中文列表： 一、二、 或 「」 内的内容
  for (const line of lines) {
    // 数字列表
    const numMatch = line.match(/^\d+[.、．)）]\s*(.+)$/);
    if (numMatch) {
      const t = numMatch[1].replace(/^[「『"'""'']+|[」』""'']+$/g, "").trim();
      if (t.length >= 4) return t.slice(0, 50);
    }
    // 中文列表（"一、xxx"）
    const cnMatch = line.match(/^[一二三四五六七八九十]+[、.]\s*(.+)$/);
    if (cnMatch) {
      const t = cnMatch[1].replace(/^[「『"'""'']+|[」』""'']+$/g, "").trim();
      if (t.length >= 4) return t.slice(0, 50);
    }
    // 全行就是引号内容：「xxx」「xxx」
    const quoteMatch = line.match(/^[「『"'""''](.+)[」』""'']$/);
    if (quoteMatch) {
      const t = quoteMatch[1].trim();
      if (t.length >= 4 && t.length <= 50) return t;
    }
  }

  // 3. 兜底：首句截断
  const firstLine = lines[0] || "";
  const sentenceMatch = firstLine.match(/^[^。！？.!?]+[。！？.!?]?/);
  const title = (sentenceMatch?.[0] || firstLine).trim();
  return title.slice(0, 50) || "无标题内容";
}

function sseEncode(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
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

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = await openClawClient.sendTaskStream(
          { message: content, context: conversationContext, prompt, conversationId: conversation.id, userId: user.id },
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

        await prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            title: conversation.title === "新的对话" ? titleFrom(content) : conversation.title
          }
        });

        let contentSaved = null;
        if (shouldAutoSave(content, conversationContext, result.content)) {
          const articleTitle = generateArticleTitle(result.content);
          const images = generateImageUrls(articleTitle, result.content);
          const category = detectCategory(content, conversationContext);
          const saved = await prisma.contentItem.create({
            data: {
              userId: user.id,
              title: articleTitle,
              body: result.content,
              category,
              coverImageUrl: images.coverImageUrl,
              sourceConversationId: conversation.id
            }
          });
          contentSaved = { id: saved.id, title: saved.title, category: saved.category };
        }

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
            error: error instanceof Error ? error.message : "OpenClaw 调用失败。"
          }
        });
        controller.enqueue(sseEncode({
          type: "error",
          error: error instanceof Error ? error.message : "OpenClaw 调用失败。"
        }));
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
