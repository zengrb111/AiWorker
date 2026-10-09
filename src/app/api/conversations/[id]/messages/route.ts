import { jsonError, readJson } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { generateCoverImage, generateImageUrls, coverPlatformOf, type CoverPlatform } from "@/lib/image-gen";
import { ocrImageText } from "@/lib/ocr";
import { generateRewriteImages } from "@/lib/rewrite-images";
import {
  filterRelevantTopics,
  loadUserKbContext,
  matchTopicsToKnowledge,
  parseTopicLines,
  retrieveReferenceChunks,
  retrieveReferenceGroups,
  type HotTopicMatch,
  type ReferenceGroup
} from "@/lib/kb-hot-topics";
import { fetchXiaohongshuNote, formatXhsForPrompt } from "@/lib/xhs-parse";
import { fetchXhsNoteViaBrowser } from "@/lib/xhs-note-browser";
import { loadXhsCookie } from "@/lib/platform-sync";
import {
  PUBLISH_CHANNEL_LABEL,
  loadPlatformAuthContext,
  resolvePublishChannels,
  type PlatformAuthEntry
} from "@/lib/platform-auth-context";

type MessageBody = {
  content?: string;
  url?: string;
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

/**
 * 文章类请求的输出格式要求：按目标平台区分行文风格。
 * 热点卡片上「小红书创作 / 公众号创作」两个入口的指令自带平台词，据此分流。
 */
function articleFormatInstruction(content: string): string {
  const base =
    "输出格式要求：直接输出成品图文（Markdown），第一行必须是「# 标题」的一级标题；不要输出任何解释说明或开场白。";
  if (/公众号|微信推文|订阅号|服务号/.test(content)) {
    return `${base} 正文按公众号风格写：完整段落、逻辑递进、信息密度高，可用「**小标题**」分节，emoji 尽量少（每节最多 1 个）。`;
  }
  if (/小红书|小红薯|种草|xhs/i.test(content)) {
    return `${base} 正文按小红书风格写：短段落、第一人称口语化、痛点共鸣，多用 emoji 与「**小标题**」加粗。`;
  }
  return `${base} 正文用短段落，可穿插 emoji 与「**小标题**」加粗。`;
}

/**
 * 内容创作类请求（小红书创作 / 公众号创作 / 写一篇 等）：
 * 把"参考了哪些知识库与 IP 人设"的过程渲染成一段可见的 Markdown，
 * 在生成正文前展示给用户，并随正文一起持久化到会话。
 */
function isContentCreationRequest(content: string): boolean {
  return /(小红书创作|公众号创作|头条号创作|写一篇|写篇|写[一个条篇]{0,2}文案|写个?图文|生成一篇|生成篇|创作一篇|小红书(风格|文案|图文)|公众号(风格|文案|图文|文章)|头条号(风格|文案|图文|文章)|微头条|文章正文|软文)/i.test(
    content
  );
}

function buildReferenceProcessMarkdown(
  groups: ReferenceGroup[],
  platformLabel: string,
  authEntries: PlatformAuthEntry[] = []
): string {
  const lines: string[] = [];
  lines.push(`## 📚 创作参考（已读取你的知识库与 IP 人设）`);
  lines.push("");
  lines.push(
    `为写这篇**${platformLabel}**内容，我先调取了你本人知识库里的相关资料，作为「人设语气」与「产品卖点」的依据：`
  );
  lines.push("");

  const seen = new Set<string>();
  let anyHit = false;
  for (const g of groups) {
    const hits = g.hits.filter((h) => {
      if (seen.has(h.id)) return false;
      seen.add(h.id);
      return true;
    });
    if (hits.length === 0) continue;
    anyHit = true;
    lines.push(`**${g.label}**`);
    for (const h of hits) {
      const pct = Math.round(Math.max(0, Math.min(1, h.score)) * 100);
      lines.push(`- 知识库「${h.kbName}」/ 文档「${h.filename}」 · 相关度 ${pct}% — ${h.snippet}`);
    }
    lines.push("");
  }

  if (!anyHit) {
    lines.push("_知识库中暂未检索到与本次选题强相关的片段，将基于通用经验并保持你已设定的人设一致性来写。_");
    lines.push("");
  }

  // 让用户看到这次创作「有哪些渠道可以发」——数据来自平台授权管理，不含任何密钥
  const channels = resolvePublishChannels(authEntries);
  lines.push("**发布渠道（来自「平台授权管理」）**");
  if (channels.length > 0) {
    lines.push(
      `- 可自动发布：${channels.map((c) => PUBLISH_CHANNEL_LABEL[c]).join("、")}（内容入库后可在内容库详情页一键发布，定时任务也会按此授权自动发布）`
    );
  } else {
    lines.push(
      "- 当前没有可自动发布的渠道：小红书 / 头条号仅用于数据采集。需要自动发布请先在「平台授权管理」授权官网（好物推荐）或官网-AI回忆录（心灵驿站）。"
    );
  }
  lines.push("");

  if (anyHit) {
    lines.push("下面据此组织人设语气与产品植入，生成正文 👇");
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

function buildTaskPrompt(contextText: string, content: string, kbText?: string, authText?: string): string {
  // 图文/文案类请求：约定输出格式（# 一级标题开头），让自动入库判定稳定命中，
  // 也保证 generateArticleTitle 能提到干净的标题。
  const isArticleRequest = /(写一篇|写篇|写个?文案|写个?图文|生成一篇|生成篇|小红书(风格|文案|图文)|公众号(风格|文案|图文|文章)|文章正文|软文)/i.test(content);
  // 热点类快捷指令：约定编号列表格式，前端据此渲染可点选的热点卡片。
  const isHotTopicsRequest = /今日全网热点|今日产品热点/.test(content);
  return [
    "请结合以下历史会话上下文继续完成用户任务。",
    "",
    "历史会话：",
    contextText,
    "",
    "当前用户任务：",
    content,
    ...(kbText
      ? [
          "",
          "【参考知识库（来自当前登录用户本人创建的知识库，仅供本次回答参考）】",
          "若用户问题涉及产品、账号定位、品牌、人设、卖点等内容，请优先以上述知识库内容为准；知识库未覆盖的内容可结合通用经验作答，但请勿编造知识库中不存在的产品或账号信息。",
          kbText
        ]
      : []),
    ...(authText
      ? [
          "",
          "【当前账号已授权的发布渠道（来自「平台授权管理」，凭据由服务端加密保存）】",
          authText,
          "回答要求：涉及发布/分发的问题，只依据上面的渠道作答；不要在回答里输出、索要或猜测任何令牌、Cookie 或密钥；用户要求发布到未授权的渠道时，提示其先到「平台授权管理」完成授权。"
        ]
      : []),
    // 所有内容创作类请求都约定「第一行必须是 # 标题」——既让自动入库判定稳定命中，
    // 也保证 generateArticleTitle 能提到干净的标题。
    ...(isArticleRequest || isContentCreationRequest(content)
      ? ["", articleFormatInstruction(content)]
      : []),
    ...(isHotTopicsRequest
      ? [
          "",
          "输出格式要求：第一行固定输出「以下是今日全网热点：」，随后以编号列表输出 10 条左右今日全网热点（各行业热门话题、社会热点、平台热点均可），每条一行，格式「1. 热点简述」；不要展开分析、不要在列表之后输出总结。"
        ]
      : [])
  ].join("\n");
}

/**
 * 智谱封面后台升级：内容先以 pollinations 占位封面入库，本函数在后台完成
 * 智谱生图并落盘本地，成功后把 coverImageUrl 覆盖为本地路径。任何失败只
 * 打日志、保持占位封面，绝不影响已入库的内容。
 */
async function upgradeCoverInBackground(
  contentItemId: string,
  title: string,
  body: string,
  platform: CoverPlatform
): Promise<void> {
  try {
    const localUrl = await generateCoverImage(title, body, platform);
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: { coverImageUrl: localUrl }
    });
  } catch (error) {
    console.error("[image-gen] 智谱封面后台升级失败（保持占位封面）：", error);
  }
}

/**
 * 成品图文的「标题行」形态：`# 标题` / `## 标题`，或老格式的 `**标题：xxx**`。
 */
const ARTICLE_TITLE_LINE = /^(?:#{1,6}\s+\S|\*\*\s*标题\s*[:：]\s*\S)/;

function shouldAutoSave(userMessage: string, _conversationContext: string, assistantContent: string): boolean {
  // 内容创作类指令（小红书创作 / 公众号创作 / 头条号创作 / 写一篇…）+ 产出足够长
  // → 入库。刻意不用「标题 / 结构特征」的细粒度启发式，避免把正常产出误杀。
  if (assistantContent.trim().length < 200) return false;
  if (!isContentCreationRequest(userMessage)) return false;
  // 但产出必须真的是成品图文：首行是标题。否则「帮我改定时任务，让它写一篇公众号文章」
  // 这类元操作对话（回复是英文前言 / 过程说明）会被误当成文章入库，产生垃圾条目。
  const firstLine = assistantContent
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  return ARTICLE_TITLE_LINE.test(firstLine);
}

/**
 * 根据用户消息判断文章分类标签。
 * 默认 "公众号文章"；明确提到小红书相关关键词时改为 "小红书"。
 */
function detectCategory(userMessage: string, conversationContext: string): string {
  const XHS_KEYWORDS = ["小红书", "小红薯", "种草", "xhs", "xhongshu"];
  const WECHAT_KEYWORDS = ["公众号", "微信推文", "订阅号", "服务号"];
  const TOUTIAO_KEYWORDS = ["头条号", "今日头条", "微头条", "toutiao"];

  // 先只看当前这条消息：热点卡片的「小红书创作 / 公众号创作」入口自带平台词，
  // 必须优先于历史上下文 —— 否则对话里出现过「小红书」之后，
  // 再点「公众号创作」会被误标成小红书。
  const current = userMessage.toLowerCase();
  const currentWechat = WECHAT_KEYWORDS.some((kw) => current.includes(kw.toLowerCase()));
  const currentXhs = XHS_KEYWORDS.some((kw) => current.includes(kw.toLowerCase()));
  const currentToutiao = TOUTIAO_KEYWORDS.some((kw) => current.includes(kw.toLowerCase()));
  if (currentWechat) return "公众号文章";
  if (currentXhs) return "小红书";
  if (currentToutiao) return "头条号";

  // 当前消息没有指定平台时，再退回结合上下文推断
  const combined = `${userMessage} ${conversationContext}`.toLowerCase();
  if (XHS_KEYWORDS.some((kw) => combined.includes(kw.toLowerCase()))) {
    return "小红书";
  }
  if (TOUTIAO_KEYWORDS.some((kw) => combined.includes(kw.toLowerCase()))) {
    return "头条号";
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

/** 组装「今日产品热点」的筛选结果回复（编号行为热点本体，缩进行为命中证据）。 */
function buildProductHotTopicReply(matched: HotTopicMatch[], reference: HotTopicMatch[]): string {
  const lines: string[] = [];
  if (matched.length > 0) {
    lines.push(
      `已结合你的知识库产品知识，从今日全网热点中筛选出 ${matched.length} 条相关热点：`,
      ""
    );
    matched.forEach((match, index) => {
      lines.push(`${index + 1}. ${match.topic}`);
      lines.push(
        `   相关度 ${match.score.toFixed(2)} · 命中关键词：${match.keywords.slice(0, 4).join("、")} · 知识库「${match.knowledgeBaseName} / ${match.filename}」：${match.snippet}`
      );
    });
  } else {
    lines.push(
      "已获取今日全网热点并逐条与知识库产品知识比对，暂未发现与产品相关的热点。",
      "",
      "以下为相关度最高的 3 条热点，供参考：",
      ""
    );
    reference.forEach((match, index) => {
      lines.push(`${index + 1}. ${match.topic}`);
      lines.push(
        `   相关度 ${match.score.toFixed(2)} · 知识库「${match.knowledgeBaseName} / ${match.filename}」：${match.snippet}`
      );
    });
  }
  return lines.join("\n");
}

/** 阶段一：要求模型抓取并拆解爆款链接的结构。有 parsed 原文时直接基于真实内容拆解。 */
function buildDecomposePrompt(url: string, parsed?: string | null, failNote?: string | null): string {
  const head = [
    "请对以下爆款内容做结构拆解（只做结构分析，不要改写）：",
    "",
    url
  ];
  const tail = [
    "",
    "请按以下维度用 Markdown 结构化输出：",
    "1. 平台与受众画像",
    "2. 选题角度与切入方式",
    "3. 标题公式（拆解它为什么吸引点击）",
    "4. 开头钩子（前 3 句如何抓住注意力）",
    "5. 正文结构（段落模块、信息密度、节奏）",
    "6. 情绪点 / 金句（哪些地方引发共鸣或转发）",
    "7. 互动引导（如何引导评论/收藏）",
    "8. 可复用的爆款要素清单"
  ];
  if (parsed) {
    return [
      ...head,
      "",
      "该链接已有系统解析出的原文内容（来自页面内嵌数据），请直接基于真实内容做拆解，不要再尝试抓取页面：",
      "",
      parsed,
      ...tail
    ].join("\n");
  }
  if (failNote) {
    return [
      ...head,
      "",
      "系统已经尝试读取该链接，但失败了。**请原样转述下面这个失败原因给用户，不要编造别的原因**（例如不要说是「未登录」或「平台限制」以外的猜测）：",
      failNote,
      "",
      "然后基于你对该平台爆款内容的通用认知，给出上面 8 个维度的拆解框架，并明确标注「以下框架不含该篇真实原文」。",
      ...tail
    ].join("\n");
  }
  return [
    ...head,
    "",
    "请访问并抓取该链接提取真实内容后再拆解。如果无法访问该链接，请明确说明，并基于你对该平台爆款内容的通用认知给出拆解框架。",
    ...tail
  ].join("\n");
}

/** 阶段二：基于拆解 + 知识库（产品知识 + 账号 IP 定位）仿写。有 parsed 原文 / OCR 主图文字时一并参考。 */
function buildRewritePrompt(url: string, decompose: string, kbText: string, parsed?: string | null, ocrText?: string | null): string {
  return [
    "你是大彬（金润瀚宇）的内容创作助手，擅长把爆款结构复用到自家产品与账号上。请基于下面的「爆款内容拆解」，仿写一篇全新的爆款内容。",
    "",
    "要求：",
    "1. 不抄袭原文：保留爆款的「结构骨架」与「情绪钩子类型」，但选题、素材、案例、数据换成与产品/账号相关的内容；",
    "2. 贴合知识库：严格按照下方「产品知识与账号 IP 定位」来写，人设、语气、调性保持一致，自然植入产品卖点，不硬广、不堆参数；",
    "3. 平台适配：链接指向的平台为下方 URL 所示，采用对应平台的排版与语气（小红书重 emoji + 第一人称 + 痛点共鸣；公众号重逻辑与价值密度）；",
    "4. 结构：吸睛标题 + 开头钩子（制造痛点或好奇）+ 2~4 个干货模块（带 emoji 小标题）+ 金句收尾 + 互动引导（提问式）；",
    "5. 直接输出仿写正文（Markdown），不要输出分析说明。",
    "",
    "【爆款原文链接】",
    url,
    "",
    "【爆款内容拆解】",
    decompose || "（无可用拆解内容）",
    ...(parsed ? ["", "【爆款原文内容（页面解析，供你理解选题/语气/素材时参考）】", parsed] : []),
    ...(ocrText ? ["", "【爆款主图 OCR 文字（图片上可见的文案，仿写时可作为选题/语气/金句的参考）】", ocrText] : []),
    "",
    "【产品知识与账号 IP 定位（来自知识库）】",
    kbText || "（当前知识库暂无相关内容，请基于通用经验，保持人设一致性）"
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

  if (content === "今日产品热点" || content === "今日产品热点推荐") {
    const userMessage = await prisma.message.create({ data: { conversationId: conversation.id, role: "USER", content } });

    const stream = new ReadableStream({
      async start(controller) {
        let taskId: string | undefined;
        const finishWith = async (assistantContent: string, taskStatus: "SUCCEEDED" | "FAILED", taskError?: string, id?: string) => {
          const assistantMessage = await prisma.message.create({
            data: { conversationId: conversation.id, role: "ASSISTANT", content: assistantContent }
          });
          if (taskId) {
            await prisma.openClawTask.update({
              where: { id: taskId },
              data: { status: taskStatus, ...(taskError ? { error: taskError } : {}) }
            });
          }
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
        };

        try {
          const kbContext = await loadUserKbContext(user.id);
          if (!kbContext) {
            await finishWith(
              "知识库中还没有可检索的产品知识，暂时无法筛选产品热点。\n\n请先在「知识库」中创建知识库、上传产品资料并完成「切片 → 训练」，之后再来点击「今日产品热点」，我会从今日全网热点中帮你筛选出与产品相关的热点。",
              "FAILED",
              "用户知识库无可用切片"
            );
            return;
          }

          controller.enqueue(sseEncode({ type: "delta", text: "正在获取今日全网热点，并结合知识库中的产品知识逐条比对筛选…" }));

          const task = await prisma.openClawTask.create({
            data: { userId: user.id, type: "conversation", prompt: "今日全网热点推荐", status: "RUNNING" }
          });
          taskId = task.id;

          const hotResult = await openClawClient.sendTask({
            message: "今日全网热点推荐",
            prompt: "请推荐今日全网热点（各行业热门话题、社会热点、平台热点均可），以编号列表输出 10 条左右，每条一行，格式：1. 热点简述。不要展开分析。",
            userId: user.id
          });

          const topics = parseTopicLines(hotResult.content);
          if (topics.length === 0) {
            await finishWith(
              `今日全网热点已获取，但未能解析出结构化热点列表，无法结合知识库筛选。原始热点内容如下：\n\n${hotResult.content.slice(0, 2000)}`,
              "SUCCEEDED",
              undefined,
              task.id
            );
            return;
          }

          const matches = await matchTopicsToKnowledge(topics, kbContext);
          const matched = filterRelevantTopics(matches, kbContext.keywords.length > 0);
          const reply = buildProductHotTopicReply(matched, [...matches].sort((a, b) => b.score - a.score).slice(0, 3));
          await finishWith(reply, "SUCCEEDED", undefined, task.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : "获取今日热点失败。";
          if (taskId) {
            await prisma.openClawTask.update({
              where: { id: taskId },
              data: { status: "FAILED", error: message }
            }).catch(() => {});
          }
          controller.enqueue(sseEncode({ type: "error", error: message || "获取今日热点失败。" }));
          controller.close();
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

  if (content === "一键仿写爆款") {
    const url = body.url?.trim() ?? "";
    const userMessage = await prisma.message.create({
      data: { conversationId: conversation.id, role: "USER", content: url ? `一键仿写爆款：${url}` : content }
    });

    const stream = new ReadableStream({
      async start(controller) {
        let taskId: string | undefined;
        const finishError = async (error: string) => {
          if (taskId) {
            await prisma.openClawTask.update({ where: { id: taskId }, data: { status: "FAILED", error } }).catch(() => {});
          }
          controller.enqueue(sseEncode({ type: "error", error }));
          controller.close();
        };

        try {
          if (!url) {
            await finishError("请先粘贴要仿写的爆款链接，再点击「一键仿写爆款」。");
            return;
          }

          const task = await prisma.openClawTask.create({
            data: { userId: user.id, type: "conversation", prompt: "一键仿写爆款", status: "RUNNING" }
          });
          taskId = task.id;

          // 对小红书链接：先试服务端直连解析，失败则走「已登录浏览器通道」（CDP）读原文。
          // App 分享链接（xsec_source=app_share）被小红书限制为仅 App 内可看，会明确提示用户换链接。
          let xhsParsed: string | null = null;
          let xhsFailNote: string | null = null;
          let mainImage: string | null = null;
          if (/xiaohongshu\.com|xhslink\.com|xhslink\.cn/i.test(url)) {
            try {
              controller.enqueue(sseEncode({ type: "delta", text: "正在读取小红书笔记原文…\n" }));
              let note = await fetchXiaohongshuNote(url);
              if (!note) {
                controller.enqueue(sseEncode({ type: "delta", text: "直连拿不到（小红书要求登录态），改用本机浏览器通道读取…\n" }));
                const cookie = await loadXhsCookie(user.id);
                const result = await fetchXhsNoteViaBrowser(url, { cookie });
                if (result.ok) {
                  note = result.note;
                } else {
                  xhsFailNote = result.message;
                  controller.enqueue(sseEncode({ type: "delta", text: `⚠️ 未能读取原文：${result.message}\n` }));
                }
              }
              if (note) {
                xhsParsed = formatXhsForPrompt(note);
                mainImage = note.coverImages?.[0] ?? null;
                controller.enqueue(sseEncode({ type: "delta", text: `✅ 已读取到原文：标题「${note.title || "（无标题）"}」${note.author ? ` · 作者 ${note.author}` : ""}，进入拆解。\n` }));
              }
            } catch (error) {
              xhsParsed = null;
              xhsFailNote = `读取小红书原文时出错：${error instanceof Error ? error.message : String(error)}`;
            }
          }

          // 对小红书主图做 OCR：提取图片上的文字，供仿写时参考（失败不阻断流程）
          let ocrText: string | null = null;
          if (mainImage) {
            try {
              controller.enqueue(sseEncode({ type: "delta", text: "正在 OCR 识别主图文字…\n" }));
              ocrText = await ocrImageText(mainImage);
              if (ocrText) {
                controller.enqueue(sseEncode({ type: "delta", text: `✅ 主图 OCR 文字：\n${ocrText}\n\n` }));
              }
            } catch (error) {
              ocrText = null;
              controller.enqueue(sseEncode({ type: "delta", text: `⚠️ 主图 OCR 失败（不影响仿写）：${error instanceof Error ? error.message : String(error)}\n` }));
            }
          }

          // 阶段一：爆款内容拆解（流式）
          controller.enqueue(sseEncode({ type: "delta", text: "\n## 一、爆款内容拆解\n" }));
          let decomposeText = "";
          const decomposeResult = await openClawClient.sendTaskStream(
            {
              message: "一键仿写爆款-内容拆解",
              prompt: buildDecomposePrompt(url, xhsParsed, xhsFailNote),
              conversationId: conversation.id,
              userId: user.id
            },
            (delta) => {
              decomposeText += delta;
              controller.enqueue(sseEncode({ type: "delta", text: delta }));
            }
          );
          decomposeText = (decomposeText || decomposeResult.content || "").trim();

          // 阶段二：基于拆解 + 知识库仿写（流式）
          controller.enqueue(sseEncode({ type: "delta", text: "\n\n---\n\n## 二、仿写爆款内容（结合你的产品与账号定位）\n" }));
          const kbContext = await loadUserKbContext(user.id);
          let kbText = "";
          if (kbContext) {
            kbText = await retrieveReferenceChunks(
              ["营销账号 IP定位 人设 风格 调性 粉丝画像", "产品 卖点 参数 使用场景 用户痛点", "品牌 价值观 故事 主张 理念"],
              kbContext,
              6
            );
          }
          let rewriteText = "";
          const rewriteResult = await openClawClient.sendTaskStream(
            {
              message: "一键仿写爆款-仿写",
              prompt: buildRewritePrompt(url, decomposeText, kbText, xhsParsed, ocrText),
              conversationId: conversation.id,
              userId: user.id
            },
            (delta) => {
              rewriteText += delta;
              controller.enqueue(sseEncode({ type: "delta", text: delta }));
            }
          );
          rewriteText = (rewriteText || rewriteResult.content || "").trim();

          // 保存：拆解消息 + 仿写消息（仿写自动入库）
          const decomposeMessage = await prisma.message.create({
            data: { conversationId: conversation.id, role: "ASSISTANT", content: `## 一、爆款内容拆解\n${decomposeText}` }
          });
          const category = /xiaohongshu|xhs|小红书|rednote/i.test(url) ? "小红书" : "公众号文章";
          const articleTitle = generateArticleTitle(rewriteText);

          // 小红书链路 + 已识别到主图：OCR 后按文案拆分生成「仿写文字图」，
          // 这些图同时作为内容库「主图」（首图即封面），跳过智谱封面升级。
          let rewriteImages: string[] = [];
          if (category === "小红书" && mainImage) {
            try {
              controller.enqueue(sseEncode({ type: "delta", text: "\n正在按文案拆分生成仿写主图…\n" }));
              rewriteImages = await generateRewriteImages(articleTitle, rewriteText, "xhs");
              controller.enqueue(sseEncode({ type: "delta", text: `✅ 已生成 ${rewriteImages.length} 张仿写主图，存入内容库「主图」区（可一键下载 zip）。\n` }));
            } catch (error) {
              rewriteImages = [];
              console.error("[rewrite-images] 仿写图生成失败，回退智谱封面：", error);
              controller.enqueue(sseEncode({ type: "delta", text: `⚠️ 仿写图生成失败（改用普通封面）：${error instanceof Error ? error.message : String(error)}\n` }));
            }
          }

          const useRewriteImages = rewriteImages.length > 0;
          const saved = await prisma.contentItem.create({
            data: {
              userId: user.id,
              title: articleTitle,
              body: rewriteText,
              category,
              // 仿写图模式：首图作为封面，全部图写入 inlineImagesJson（内容库「主图」区平铺展示）
              coverImageUrl: useRewriteImages
                ? rewriteImages[0]
                : generateImageUrls(articleTitle, rewriteText, 0, coverPlatformOf(category)).coverImageUrl,
              ...(useRewriteImages ? { inlineImagesJson: JSON.stringify(rewriteImages) } : {}),
              sourceConversationId: conversation.id
            }
          });
          if (!useRewriteImages) {
            void upgradeCoverInBackground(saved.id, articleTitle, rewriteText, coverPlatformOf(category));
          }
          let rewriteMessageContent = `## 二、仿写爆款内容（结合你的产品与账号定位）\n${rewriteText}`;
          if (useRewriteImages) {
            rewriteMessageContent += `\n\n---\n\n### 🖼️ 仿写主图（共 ${rewriteImages.length} 张，已存入内容库「主图」区，可一键下载 zip）\n\n`;
            rewriteImages.forEach((img, i) => {
              rewriteMessageContent += `![主图${i + 1}](${img})\n`;
            });
          }
          const rewriteMessage = await prisma.message.create({
            data: { conversationId: conversation.id, role: "ASSISTANT", content: rewriteMessageContent }
          });

          await prisma.openClawTask.update({ where: { id: task.id }, data: { status: "SUCCEEDED" } });

          controller.enqueue(sseEncode({
            type: "final",
            message: {
              id: decomposeMessage.id,
              role: "ASSISTANT",
              content: decomposeMessage.content,
              createdAt: decomposeMessage.createdAt.toISOString()
            },
            userMessage
          }));
          controller.enqueue(sseEncode({
            type: "final",
            message: {
              id: rewriteMessage.id,
              role: "ASSISTANT",
              content: rewriteMessage.content,
              createdAt: rewriteMessage.createdAt.toISOString()
            },
            userMessage,
            contentSaved: { id: saved.id, title: saved.title, category: saved.category }
          }));
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : "仿写失败。";
          if (taskId) {
            await prisma.openClawTask.update({ where: { id: taskId }, data: { status: "FAILED", error: message } }).catch(() => {});
          }
          controller.enqueue(sseEncode({ type: "error", error: message }));
          controller.close();
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

  // 通用对话生成也须以「当前登录用户本人创建的知识库」为参考来源，
  // 与「今日产品热点 / 一键仿写爆款」共用同一套按 userId 隔离的检索逻辑。
  // 用户没有可用知识库切片时 kbText 为空，prompt 不注入该段，行为等同此前。
  let kbText = "";
  let referenceProcess = "";
  // 当前用户在「平台授权管理」里已授权的渠道（会话据此知道能发到哪、不能发到哪）
  const authCtx = await loadPlatformAuthContext(user.id);
  const isCreationRequest = isContentCreationRequest(content);
  const kbCtx = await loadUserKbContext(user.id);
  if (kbCtx) {
    kbText = await retrieveReferenceChunks(
      [content, "产品卖点 账号人设 品牌定位 用户痛点"],
      kbCtx,
      5
    );
  }
  // 内容创作类请求：先算出"参考了哪些知识库 / IP 人设 / 可发布渠道"的过程，
  // 生成正文前以可见段落展示，并随正文一起入库（持久化）。
  if (isCreationRequest) {
    const platformLabel = detectCategory(content, conversationContext) === "小红书" ? "小红书" : "公众号";
    const groups = kbCtx
      ? await retrieveReferenceGroups(
          [
            { label: "IP 人设 / 调性", query: "账号人设 IP定位 风格 调性 语气 粉丝画像" },
            { label: "产品卖点 / 用户痛点", query: "产品 卖点 参数 使用场景 用户痛点" },
            { label: "本选题相关素材", query: content }
          ],
          kbCtx,
          3
        )
      : [];
    referenceProcess = buildReferenceProcessMarkdown(groups, platformLabel, authCtx.entries);
  }
  const prompt = buildTaskPrompt(conversationContext, content, kbText, authCtx.promptBlock);

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
      // SSE 保活：Agent 执行工具（联网搜索、读写文件、跑脚本）时可能几分钟不产生
      // 任何 delta，连接会被中间层误判为空闲而掐断，前端表现为“莫名其妙中断”。
      // 每 15 秒发一个 ping 帧（前端只认 delta/final/error，ping 会被安全忽略）。
      let streamClosed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (streamClosed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          streamClosed = true;
        }
      };
      const heartbeat = setInterval(() => {
        safeEnqueue(sseEncode({ type: "ping" }));
      }, 15000);

      try {
        // 先把"参考知识库 / IP 人设"的过程展示出来（内容创作类请求才有），
        // 再开始生成正文。这样用户能直接看到本次创作的依据来源。
        if (referenceProcess) {
          safeEnqueue(sseEncode({ type: "delta", text: referenceProcess }));
        }

        const result = await openClawClient.sendTaskStream(
          { message: content, context: conversationContext, prompt, conversationId: conversation.id, userId: user.id },
          (deltaText) => safeEnqueue(sseEncode({ type: "delta", text: deltaText }))
        );

        if (!result.content.trim()) {
          throw new Error("助手返回了空回复，请重试。");
        }

        const assistantMessage = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: "ASSISTANT",
            content: referenceProcess ? `${referenceProcess}${result.content}` : result.content
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
          const category = detectCategory(content, conversationContext);
          const saved = await prisma.contentItem.create({
            data: {
              userId: user.id,
              title: articleTitle,
              body: result.content,
              category,
              // 入库不被生图阻塞：先用 pollinations 占位封面，智谱生图后台完成后升级为本地图
              coverImageUrl: generateImageUrls(articleTitle, result.content, 0, coverPlatformOf(category)).coverImageUrl,
              sourceConversationId: conversation.id
            }
          });
          contentSaved = { id: saved.id, title: saved.title, category: saved.category };
          void upgradeCoverInBackground(saved.id, articleTitle, result.content, coverPlatformOf(category));
        }

        safeEnqueue(sseEncode({
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
        const err = error as Error & { partialContent?: string; code?: string };
        const partial = (err.partialContent || "").trim();

        // 超时/中断时若已有流式内容，保存部分内容并照常走自动入库判定，
        // 避免用户已经看到的图文因超时全部丢失。
        if (partial.length >= 100) {
          const assistantMessage = await prisma.message.create({
            data: {
              conversationId: conversation.id,
              role: "ASSISTANT",
              content: referenceProcess ? `${referenceProcess}${partial}` : partial
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
            const category = detectCategory(content, conversationContext);
            const saved = await prisma.contentItem.create({
              data: {
                userId: user.id,
                title: articleTitle,
                body: partial,
                category,
                // 入库不被生图阻塞：先用 pollinations 占位封面，智谱生图后台完成后升级为本地图
                coverImageUrl: generateImageUrls(articleTitle, partial, 0, coverPlatformOf(category)).coverImageUrl,
                sourceConversationId: conversation.id
              }
            });
            contentSaved = { id: saved.id, title: saved.title, category: saved.category ?? category };
            void upgradeCoverInBackground(saved.id, articleTitle, partial, coverPlatformOf(category));
          }

          safeEnqueue(sseEncode({
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
          // soft=true 表示「不是真失败，只是本端等待超时」：网关侧的 run 仍在
          // 继续执行，前端据此用提示色而非报错色呈现，避免误导用户重发。
          safeEnqueue(sseEncode({
            type: "error",
            error: err.message || "OpenClaw 调用失败。",
            soft: err.code === "TIMEOUT"
          }));
        }
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // 流已被消费方取消，忽略重复关闭。
        }
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
