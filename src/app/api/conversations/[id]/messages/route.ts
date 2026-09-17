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

function shouldAutoSave(userMessage: string, _conversationContext: string, assistantContent: string): boolean {
  if (assistantContent.length <= 500) return false;
  const isExplicitArticleRequest = /(写一篇|写篇|生成一篇|生成篇|创作一篇|创作篇|公众号文章|小红书文案|文章正文)/i.test(userMessage);
  if (!isExplicitArticleRequest) return false;

  // 进一步过滤：必须是真正的"图文/文章"内容（含有结构化特征），不能是纯推荐/对话回复
  // 结构特征：markdown 标题、列表项、引号标题、Markdown 链接/加粗
  const hasStructure =
    assistantContent.includes("##") ||                                    // markdown 标题
    assistantContent.includes("\n- ") || assistantContent.includes("\n* ") || // 列表
    /^\d+[.、．)）]\s*\S+/m.test(assistantContent) ||                     // 数字列表
    /[「『"'""''].{2,40}[」』""'']/.test(assistantContent) ||             // 引号标题
    /\*\*[^*\n]{2,30}\*\*/.test(assistantContent);                        // 加粗短语
  const hasArticleTitle = /^#{1,3}\s+\S+/m.test(assistantContent);
  if (!hasStructure || !hasArticleTitle) return false;

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

  if (content === "一键剪视频") {
    const userMessage = await prisma.message.create({
      data: { conversationId: conversation.id, role: "USER", content }
    });
    const assistantMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: "请在下方上传需要剪辑的视频。开始剪辑后，我会在会话中实时展示视频分析、字幕生成、音频优化、画面特效、转场和成片渲染的完整过程。"
      }
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(sseEncode({
          type: "final",
          message: {
            id: assistantMessage.id,
            role: "ASSISTANT",
            content: assistantMessage.content,
            createdAt: assistantMessage.createdAt.toISOString()
          },
          userMessage
        }));
        controller.close();
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

  if (content === "一键复刻爆款视频") {
    const userMessage = await prisma.message.create({ data: { conversationId: conversation.id, role: "USER", content } });
    const assistantMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: "请填写抖音、小红书、视频号、快手等平台的参考视频链接，或上传参考视频；同时上传用于制作的视频或图片素材。素材齐全后，系统将使用 OpenMontage 自动制作一条结构和节奏相近、但不直接复制参考内容的新视频。"
      }
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(sseEncode({ type: "final", message: { id: assistantMessage.id, role: "ASSISTANT", content: assistantMessage.content, createdAt: assistantMessage.createdAt.toISOString() }, userMessage }));
        controller.close();
      }
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
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

        if (!result.content.trim()) {
          throw new Error("助手返回了空回复，请重试。");
        }

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
        const err = error as Error & { partialContent?: string };
        const partial = (err.partialContent || "").trim();

        // 超时/中断时若已有流式内容，保存部分内容并照常走自动入库判定，
        // 避免用户已经看到的图文因超时全部丢失。
        if (partial.length >= 100) {
          const assistantMessage = await prisma.message.create({
            data: {
              conversationId: conversation.id,
              role: "ASSISTANT",
              content: partial
            }
          });

          await prisma.openClawTask.update({
            where: { id: task.id },
            data: {
              status: "FAILED",
              error: `${err.message}（已保留流式部分内容）`
            }
          });

          let contentSaved: { id: string; title: string; category: string } | null = null;
          if (shouldAutoSave(content, conversationContext, partial)) {
            const articleTitle = generateArticleTitle(partial);
            const images = generateImageUrls(articleTitle, partial);
            const category = detectCategory(content, conversationContext);
            const saved = await prisma.contentItem.create({
              data: {
                userId: user.id,
                title: articleTitle,
                body: partial,
                category,
                coverImageUrl: images.coverImageUrl,
                sourceConversationId: conversation.id
              }
            });
            contentSaved = { id: saved.id, title: saved.title, category: saved.category ?? category };
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
        } else {
          await prisma.openClawTask.update({
            where: { id: task.id },
            data: {
              status: "FAILED",
              error: err.message || "OpenClaw 调用失败。"
            }
          });
          controller.enqueue(sseEncode({
            type: "error",
            error: err.message || "OpenClaw 调用失败。"
          }));
        }
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
