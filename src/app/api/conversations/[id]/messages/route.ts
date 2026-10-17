import { jsonError, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { chatComplete, chatCompleteStream } from "@/lib/llm-client";
import { openClawClient, friendlyGatewayError, classifyGatewayError } from "@/lib/openclaw";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { searchWeb } from "@/lib/web-search";
import { snapshotUserConfig, resolveCapabilityConfig, type ResolvedModelConfig } from "@/lib/model-credentials";
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
      "- 当前没有可自动发布的渠道：小红书 / 头条号 / 公众号 / 视频号仅用于数据采集。需要自动发布请先在「平台授权管理」授权官网（好物推荐）、官网-AI回忆录（心灵驿站）或官网-AI员工（AI最前沿）。"
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

/** 该用户可用于定时任务微信通知的投递目标。 */
type WechatDeliveryTarget = { to: string; accountId: string };

/**
 * 复刻 OpenClaw 的 normalizeAccountId：把 bot id（如 "fa3c1b27710c@im.bot"）
 * 规范成网关投递用的账号 key（"fa3c1b27710c-im-bot"）。
 */
function normalizeWeixinAccountId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return trimmed.toLowerCase();
  return (
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || ""
  );
}

/**
 * 从用户的微信绑定记录推导「定时任务微信通知」的投递目标。
 * OpenClaw 的 cron 投递需要成对的 (--to 好友 openid, --account 机器人账号)：
 *   - to      = 绑定里的 wechatNo（形如 xxx@im.wechat，是收件人）
 *   - account = 绑定里的 wechatOpenId（形如 xxx@im.bot，规范成 xxx-im-bot）
 * 历史数据里 wechatOpenId 也可能存 userId（@im.wechat），那种情况无法可靠反推账号，
 * 返回 null（宁可不投递，也不能投错人）。
 */
function resolveWechatDeliveryTarget(binding?: {
  wechatOpenId?: string | null;
  wechatNo?: string | null;
} | null): WechatDeliveryTarget | null {
  const to = (binding?.wechatNo || "").trim();
  const rawAccount = (binding?.wechatOpenId || "").trim();
  if (!to.endsWith("@im.wechat") || !rawAccount.endsWith("@im.bot")) return null;
  const accountId = normalizeWeixinAccountId(rawAccount);
  if (!accountId) return null;
  return { to, accountId };
}

/** 平台侧定时任务（存在本库，不再依赖网关 cron）。 */
type UserScheduledJob = {
  id: string;
  name: string;
  cronExpr: string;
  timezone: string;
  enabled: boolean;
};

/**
 * 读取「当前用户自己的」定时任务 —— 直接来自平台库（按 userId 过滤），
 * 网关 cron 已不再保存用户任务。查询异常返回 null（不注入该段，避免误导 AI 说"没有任务"）。
 */
async function loadUserScheduledJobs(userId: string): Promise<UserScheduledJob[] | null> {
  try {
    return await prisma.scheduledJob.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, cronExpr: true, timezone: true, enabled: true }
    });
  } catch {
    return null;
  }
}

/**
 * 该用户定时任务清单（唯一事实来源）+ 平台调度接口用法。
 * 任务与调度都归平台，AI 只需按清单作答、并在需要时调用平台接口增删改。
 */
function buildCronBlock(jobs: UserScheduledJob[] | null, userId: string): string | null {
  if (jobs === null) return null;
  const lines = ["【该用户的定时任务（唯一事实来源，涉及定时任务的回答只依据本列表）】"];
  if (jobs.length === 0) {
    lines.push("- 该用户当前没有任何定时任务。");
  } else {
    for (const j of jobs) {
      lines.push(
        `- 「${j.name}」 调度：${j.cronExpr} (${j.timezone}) · ${j.enabled ? "已启用" : "已停用"} · id=${j.id}`
      );
    }
  }
  lines.push("- 本列表之外的任务都不属于该用户：绝不展示、复述、查询或修改。");

  const base = (process.env.AIWORKER_BASE_URL || "http://127.0.0.1:3000").trim();
  const token = (process.env.SCHEDULE_API_TOKEN || process.env.CONTENT_INGEST_TOKEN || "").trim();
  if (token) {
    lines.push(
      "- 定时任务的创建/修改/删除/查询一律走**平台接口**（唯一入口，不要用 openclaw cron）：",
      `  POST ${base}/api/scheduled-jobs/agent`,
      `  Header: Authorization: Bearer ${token} ； Content-Type: application/json`,
      "  Body 示例：",
      `    {"action":"create","userId":"${userId}","name":"每日内容生成","cronExpr":"30 17 * * *","timezone":"Asia/Shanghai","prompt":"到点要执行的完整指令"}`,
      `    {"action":"update","userId":"${userId}","id":"<任务id>","cronExpr":"0 9 * * *"}`,
      `    {"action":"delete","userId":"${userId}","id":"<任务id>"}`,
      "  userId 必须固定为当前用户；cronExpr 为 5 段（分 时 日 月 周）；时区默认 Asia/Shanghai。",
      "- **严禁**使用 `openclaw cron`（add / edit / rm / list 等）：网关侧已不再保存用户定时任务，只剩系统任务；用它既拿不到也可能看到不该看的东西。"
    );
  } else {
    lines.push(
      "- 定时任务由平台管理：需要新增或修改时，提示用户在平台页面上操作。"
    );
  }
  return lines.join("\n");
}

/**
 * 收集该用户最近上传的素材图片绝对路径。
 *
 * 素材落盘在 `public/uploads/gen-video-refs/<token>/`（gen-video 面板上传）与
 * `public/uploads/gen-video-prep/<token>/`（热点一键生成的配图下载）。
 * 按目录 mtime 倒序取最近的若干张，够 OpenClaw 引用即可。
 *
 * 刻意不递归、不扫全站：素材量可能很大，而 prompt 里只需要最近几张。
 * 任何 IO 失败都返回空数组 —— 这只是提示素材，不该让会话发不出去。
 */
function collectUserMaterialPaths(userId: string, limit = 20): string[] {
  const root = join(process.cwd(), "public", "uploads");
  const buckets = ["gen-video-refs", "gen-video-prep"];
  const found: Array<{ path: string; mtimeMs: number }> = [];
  try {
    for (const bucket of buckets) {
      const bucketDir = join(root, bucket);
      if (!existsSync(bucketDir)) continue;
      const tokens = readdirSync(bucketDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      for (const token of tokens) {
        const dir = join(bucketDir, token);
        let stat;
        try {
          stat = statSync(dir);
        } catch {
          continue;
        }
        let files: string[];
        try {
          files = readdirSync(dir);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!/\.(jpe?g|png|webp)$/i.test(file)) continue;
          found.push({ path: join(dir, file), mtimeMs: stat.mtimeMs });
        }
      }
    }
  } catch (error) {
    console.warn(
      `[messages] 收集素材路径失败（不影响会话）：${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((item) => item.path);
}

/**
 * 视频能力说明块（方案 C 的核心注入）。
 *
 * 为什么必须注入：OpenClaw 是"第一交互人"，它要知道平台有视频能力、以及**怎么用**。
 * 不注入的话用户说"帮我做个视频"，它只会回一段文字，不会去 spawn 平台 CLI。
 *
 * 设计取舍：
 *  · 只在用户消息**疑似视频请求**时注入。无条件注入会让每条对话都背上几百字
 *    的工具说明，既浪费 token 又稀释注意力。
 *  · 命令行签名写死，不让 OpenClaw 自由发挥参数名 —— 它拼错一个参数名，
 *    CLI 就会以"未知参数"失败，而它很可能反复重试同一个错命令。
 *  · 素材路径只给**当前用户自己的**（由平台上传时注入），它无法构造别人的路径。
 */
function buildVideoCapabilityBlock(
  userId: string | undefined,
  content: string,
  userMaterials?: string[]
): string {
  // 只有疑似视频诉求才注入，避免每次对话都带一大段工具说明。
  const looksLikeVideoRequest =
    /(视频|短片|影片|剪辑|片子|做个.{0,6}(视频|短片)|生成.{0,4}视频|拍.{0,4}(视频|短片)|短视频|口播)/i.test(
      content
    );
  if (!looksLikeVideoRequest) return "";

  const safeUserId = (userId ?? "").trim();
  const materialLines = (userMaterials ?? [])
    .filter((p) => p.trim())
    .map((p, i) => `  ${i + 1}. ${p.trim()}`)
    .join("\n");

  return [
    "【平台视频能力（用户提到了视频，按下面说明操作）】",
    "",
    "平台提供一条视频生成命令，你可以通过执行它来为用户生成视频。命令需原样执行，不要改写参数名：",
    "",
    "  npx tsx scripts/aiworker-video.mts \\",
    "    --user-id <用户ID> \\",
    "    --requirement \"<创作要求，从用户消息提炼，20-200字>\" \\",
    "    --materials <图片路径1> <图片路径2> ... \\",
    "    [--theme <主题key>] [--target-seconds <秒数>] \\",
    "    [--look-effects <特效,特效>] [--look-motion <运镜>] [--caption-style <字幕样式>]",
    "",
    "参数说明：",
    `- --user-id：固定填 ${safeUserId || "<当前用户ID>"}（**必须填这个值，不要填别的**）`,
    "- --requirement：必填。从用户消息提炼创作要求，包含主题、风格倾向、要突出的信息",
    "- --materials：必填。图片绝对路径列表，空格分隔；见下方「该用户的素材」",
    "- --theme：可选。warm-default 温暖治愈 / cool-night 冷调夜色 / clean-light 明亮清新 / film-revive 胶片复古 / acid-graphics 酸性设计 / glitch-art 故障艺术 / collage-zine 拼贴胶带 / swiss-grid 瑞士网格 / mono-ink 单色水墨。不填则由 AI 按素材色调自动挑选",
    "- --target-seconds：可选，目标口播时长（秒），默认 20",
    "- --look-effects：可选，叠加特效层，最多 2 个，逗号分隔。可选值：glitch 故障艺术 / acid-flow 酸性流体 / collage 撕纸拼贴 / swiss-grid 瑞士网格",
    "- --look-motion：可选，统一运镜。可选值：ken-burns 缓慢推进 / parallax 视差景深 / zoom-in 推近 / drift-up 上移 / drift-down 下移 / static 静止。不填则由 AI 逐镜头挑选",
    "- --caption-style：可选，字幕样式。可选值：classic 经典白字 / bold-yellow 醒目黄字 / boxed-dark 半透明底框 / minimal-line 极简细描边",
    "",
    "命令输出：stdout 最后一行是 JSON。",
    '  成功：{"ok":true,"token":"...","title":"...","videoPath":"...","coverPath":"...","durationSeconds":19.4,"narration":"...","sceneCount":7}',
    '  失败：{"ok":false,"error":"具体原因"}',
    "",
    "执行要求：",
    "1. 用户没有提供素材图片时，先问用户要图，不要凭空调用命令（--materials 不能为空）",
    "2. 命令可能要跑 1-3 分钟，这是正常的，耐心等待它结束，不要中断",
    "3. 成功后把 title / narration / 视频已生成的事实自然地转述给用户，不要把 JSON 原文和文件路径丢给用户",
    "4. 失败时把 error 里的原因用中文解释给用户，并给出可行的下一步建议",
    materialLines
      ? ["", "【该用户的素材（只有这些，不要使用或猜测其它路径）】", materialLines].join("\n")
      : ["", "【该用户的素材】用户尚未上传任何素材图片。请先引导用户在对话中上传图片。"].join("\n")
  ].join("\n");
}

function buildTaskPrompt(
  contextText: string,
  content: string,
  kbText?: string,
  authText?: string,
  userId?: string,
  wechatDelivery?: WechatDeliveryTarget | null,
  cronJobs?: UserScheduledJob[] | null,
  userMaterials?: string[]
): string {
  // 图文/文案类请求：约定输出格式（# 一级标题开头），让自动入库判定稳定命中，
  // 也保证 generateArticleTitle 能提到干净的标题。
  const isArticleRequest = /(写一篇|写篇|写个?文案|写个?图文|生成一篇|生成篇|小红书(风格|文案|图文)|公众号(风格|文案|图文|文章)|文章正文|软文)/i.test(content);
  // 热点类快捷指令：约定编号列表格式，前端据此渲染可点选的热点卡片。
  const isHotTopicsRequest = /今日全网热点|今日产品热点/.test(content);
  // 多用户隔离：每个登录用户的会话与模型密钥都独立，规则作为最高优先级指令注入。
  const isolationBlock = [
    "【多用户隔离规则（最高优先级，必须遵守）】",
    "- 本平台多名用户共用同一个 AI 员工，你当前只为其中一位用户服务，回答里不得出现其他用户的任何数据。",
    "- 该用户的一切定时任务都由平台管理：你无法直接创建/修改定时任务，需要变更时请引导用户在平台的「定时任务」界面操作。",
    ...(wechatDelivery
      ? [
          `- 该用户的微信通知投递目标（唯一可用，严禁改用其他用户的）：--announce --channel openclaw-weixin --to ${wechatDelivery.to} --account ${wechatDelivery.accountId}。`,
          "- 创建/修改任何带微信通知的定时任务时，必须显式带上上面的 --to 与 --account；绝不要复用、猜测或沿用其他用户的 --to/--account（否则会把别人的通知发到这个微信号上）。"
        ]
      : [
          "- 该用户尚未绑定微信：不要创建带微信通知（delivery/announce）的定时任务，也不要复用任何已有的微信投递目标。"
        ]),
    "- 严禁引用、复述或推测其他用户的会话内容、定时任务、账号或数据；上下文里出现与当前用户无关的信息时，直接忽略。",
    "- 用户查询定时任务时，只汇报属于该用户的任务；发现遗留的共享会话任务，提醒用户联系管理员迁移，不要擅自改动其他用户的任务。"
  ].join("\n");
  const cronBlock = buildCronBlock(cronJobs ?? null, userId ?? "");
  return [
    isolationBlock,
    ...(cronBlock ? ["", cronBlock] : []),
    "",
    buildVideoCapabilityBlock(userId, content, userMaterials),
    "",
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
 * 免费封面后台升级：内容先以 pollinations 占位封面入库，本函数在后台完成
 * 免费生图（简约背景 + 程序绘制正确标题）并落盘本地，成功后把 coverImageUrl
 * 覆盖为本地路径。任何失败只打日志、保持占位封面，绝不影响已入库的内容。
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
    console.error("[image-gen] 免费封面后台升级失败（保持占位封面）：", error);
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
    "6. 字数限制：仿写正文（不含标题与文末话题标签）控制在 1000 字以内，精炼表达，不注水、不堆排比、不重复同一个意思。",
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

  if (content === "一键生成视频") {
    const userMessage = await prisma.message.create({
      data: { conversationId: conversation.id, role: "USER", content }
    });
    const assistantMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: "请在下方上传多张参考图，并填写整体创作要求。点击开始生成后，我会调用 Remotion 视频技能，在当前会话中实时展示视频脚本、分镜渲染、配音字幕与成片合成的完整过程。"
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

          controller.enqueue(sseEncode({ type: "delta", text: "正在联网获取今日真实热点…" }));

          const task = await prisma.openClawTask.create({
            data: { userId: user.id, type: "conversation", prompt: "今日全网热点推荐", status: "RUNNING" }
          });
          taskId = task.id;

          // 快照一次配置：同一次请求里搜索与对话用同一份用户配置，不会中途换模型/换密钥。
          const snapshot = await snapshotUserConfig(user.id);

          // 第一步：真实联网搜索（失败即报错，绝不让模型在没有素材时编造今日热点）。
          const hits = await searchWeb({
            userId: user.id,
            query: "今日全网热点",
            topK: 12,
            config: snapshot.search
          });
          controller.enqueue(
            sseEncode({ type: "delta", text: `已联网获取 ${hits.length} 条当日热点，正在结合知识库中的产品知识逐条比对筛选…\n\n` })
          );

          // 第二步：交给用户配置的对话模型做去重与影响力排序。
          const material = hits
            .map((hit, index) => `${index + 1}. ${hit.title}\n   来源：${hit.url}\n   摘要：${hit.snippet}`)
            .join("\n");
          const hotResult = await chatComplete({
            userId: user.id,
            capability: "chat",
            config: snapshot.chat ?? undefined,
            prompt:
              "以下是联网搜索抓取到的今日热点素材（真实结果，未经加工）：\n\n" +
              `${material}\n\n` +
              "请从中挑选 10 条左右最值得关注的热点，去掉重复与明显无关内容，按影响力从高到低排序，" +
              "以编号列表输出，每条一行，格式：1. 热点简述。不要展开分析，不要编造素材里没有的热点。"
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

          // 快照一次配置：拆解与仿写两阶段用同一份用户配置。
          const rewriteSnapshot = await snapshotUserConfig(user.id);

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
              ocrText = await ocrImageText(mainImage, { userId: user.id });
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
          const decomposeResult = await chatCompleteStream({
            userId: user.id,
            capability: "chat",
            config: rewriteSnapshot.chat ?? undefined,
            prompt: buildDecomposePrompt(url, xhsParsed, xhsFailNote),
            onDelta: (delta) => {
              decomposeText += delta;
              controller.enqueue(sseEncode({ type: "delta", text: delta }));
            }
          });
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
          const rewriteResult = await chatCompleteStream({
            userId: user.id,
            capability: "chat",
            config: rewriteSnapshot.chat ?? undefined,
            prompt: buildRewritePrompt(url, decomposeText, kbText, xhsParsed, ocrText),
            onDelta: (delta) => {
              rewriteText += delta;
              controller.enqueue(sseEncode({ type: "delta", text: delta }));
            }
          });
          rewriteText = (rewriteText || rewriteResult.content || "").trim();

          // 保存：拆解消息 + 仿写消息（仿写自动入库）
          const decomposeMessage = await prisma.message.create({
            data: { conversationId: conversation.id, role: "ASSISTANT", content: `## 一、爆款内容拆解\n${decomposeText}` }
          });
          const category = /xiaohongshu|xhs|小红书|rednote/i.test(url) ? "小红书" : "公众号文章";
          const articleTitle = generateArticleTitle(rewriteText);

          // 小红书链路 + 已识别到主图：OCR 后按文案拆分生成「仿写文字图」，
          // 这些图同时作为内容库「主图」（首图即封面），跳过普通封面升级。
          let rewriteImages: string[] = [];
          if (category === "小红书" && mainImage) {
            try {
              controller.enqueue(sseEncode({ type: "delta", text: "\n正在按文案拆分生成仿写主图…\n" }));
              rewriteImages = await generateRewriteImages(articleTitle, rewriteText, "xhs");
              controller.enqueue(sseEncode({ type: "delta", text: `✅ 已生成 ${rewriteImages.length} 张仿写主图，存入内容库「主图」区（可一键下载 zip）。\n` }));
            } catch (error) {
              rewriteImages = [];
              console.error("[rewrite-images] 仿写图生成失败，改用普通封面：", error);
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
  // 该用户绑定的微信通知目标：注入隔离规则，避免 AI 创建/修改定时任务时把通知投给别的用户。
  const wechatBinding = await prisma.wechatBinding.findFirst({
    where: { userId: user.id, status: "BOUND" },
    orderBy: { boundAt: "desc" },
    select: { wechatOpenId: true, wechatNo: true }
  });
  const wechatDelivery = resolveWechatDeliveryTarget(wechatBinding);
  // 该用户自己的定时任务清单（按会话 key 过滤），注入后 AI 无需（也不允许）去看全局 cron。
  const userCronJobs = await loadUserScheduledJobs(user.id);
  // 该用户最近上传的素材路径。只收集**属于该用户**的目录，
  // 让 OpenClaw 能把用户消息里提到的"这些图"解析成真实路径，
  // 同时它无法构造别人的路径（路径由平台给定，见 buildVideoCapabilityBlock）。
  const userMaterials = collectUserMaterialPaths(user.id);
  const prompt = buildTaskPrompt(
    conversationContext,
    content,
    kbText,
    authCtx.promptBlock,
    user.id,
    wechatDelivery,
    userCronJobs,
    userMaterials
  );

  const task = await prisma.openClawTask.create({
    data: {
      userId: user.id,
      type: "conversation",
      prompt,
      status: "RUNNING"
    }
  });

  // 会话主链路走 OpenClaw 网关（v3 方案）：
  //   · 模型凭据由 OpenClaw 自己管（openclaw.json + 私有 sqlite），平台不再解析 chat 分配；
  //   · 平台侧能力（识图/TTS/搜索/向量/旁白）仍走 resolveCapabilityConfig(userId, ...)，
  //     那套体系原样保留，只是不再是会话的来源。
  // 网关未启动时 probeGatewayHandshake 会给出结构化诊断，文案由 friendlyGatewayError 统一产出。

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

        // 主链路：OpenClaw 网关。sessionKey 按 userId 派生，实现多用户隔离。
        // sendTaskStream 内部带 300 秒连接预算 + 网关慢启动重试，失败时抛出的
        // 错误已由 friendlyGatewayError 翻译成可操作中文提示。
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
            // OpenClaw 模式下模型由网关自行决定（读它自己的配置），
            // 平台侧不再知道 provider/model，只记录 runId 便于回网关追溯。
            resultJson: JSON.stringify({
              engine: "openclaw",
              runId: result.taskId ?? null
            })
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
              // 入库不被生图阻塞：先用 pollinations 占位封面，免费封面后台完成后升级为本地图
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

        // 网关类错误统一翻译成可操作中文提示（未启动/端口占用/凭据缺失/鉴权失败/超时）。
        // 判定依据是 error.code 而非 message 文本，因此「空 message」场景也能给对结论。
        // 非网关错误（如 chat.send 未返回 runId）原样透出。
        const diagnosis = classifyGatewayError(err);
        const userFacingMessage =
          diagnosis.kind === "unknown" ? err.message : friendlyGatewayError(err, { wasRetried: false });

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
              error: `${userFacingMessage}（已保留流式部分内容）`
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
                // 入库不被生图阻塞：先用 pollinations 占位封面，免费封面后台完成后升级为本地图
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
              error: userFacingMessage || "助手未返回内容，请重试。"
            }
          });
          // soft=true 表示「不是真失败，只是本端等待超时」：网关侧的 run 仍在
          // 继续执行，前端据此用提示色而非报错色呈现，避免误导用户重发。
          safeEnqueue(sseEncode({
            type: "error",
            error: userFacingMessage || "助手未返回内容，请重试。",
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
