"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "@/lib/markdown";
import { escapeHtml, escapeAttr } from "@/lib/escape";
import KnowledgePanel from "./knowledge-panel";
import PublishPanel from "./publish-panel";
import AnalyticsPanel from "./analytics-panel";
import AccountsPanel from "./accounts-panel";
import SettingsPanel from "./settings-panel";
import ModelPicker, { type ModelOption, type CurrentModel } from "./model-picker";

type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * 把 SSE 里的 error 事件包成带 soft 标记的 Error。
 * soft=true 表示「只是本端等待超时」——网关侧的任务仍在后台继续执行，
 * 不该按失败渲染，否则用户会误以为任务挂了而重复发送。
 */
/**
 * 把 SSE 的 error 事件包成 Error。
 *
 * `modelConfig` 是「缺模型配置」的结构化分类（kind + capability）：
 * 服务端在用户没配对话模型时会带上它，前端据此显示「去系统配置」入口，
 * 而不是只给一句用户无法行动的文案。
 */
function streamError(
  message: string,
  soft: boolean,
  modelConfig?: ModelConfigErrorPayload,
): Error & { soft?: boolean; modelConfig?: ModelConfigErrorPayload } {
  const err = new Error(message) as Error & {
    soft?: boolean;
    modelConfig?: ModelConfigErrorPayload;
  };
  err.soft = soft;
  if (modelConfig) err.modelConfig = modelConfig;
  return err;
}

function isSoftError(error: unknown): boolean {
  return (error as { soft?: boolean } | null)?.soft === true;
}

/**
 * 从助手回复里提取视频任务 token。
 *
 * 方案 C：OpenClaw spawn 平台 CLI 后，会把 CLI 输出的 JSON 内容转述给用户，
 * 其中 `token` 字段是唯一能关联到 CLI 进程与进度文件的标识。
 * 匹配形如 `"token":"1792201507948-nzhg66ke"` 的片段。
 *
 * 匹配不到返回 null（普通对话，不启动轮询）。
 */
function extractVideoToken(content: string): string | null {
  if (!content) return null;
  const match = content.match(/"token"\s*:\s*"([A-Za-z0-9_-]{8,64})"/);
  return match ? match[1] : null;
}

/**
 * 后端返回的「模型未配置」结构化错误。
 *
 * 与 `ModelConfigErrorKind`（src/lib/model-credentials.ts）一一对应。
 * 有它才能在前端区分「用户少配了一个模型」和「服务出故障」——
 * 前者要给可点击的跳转入口，后者只该报错误。
 */
type ModelConfigErrorPayload = {
  kind?: "no_provider" | "no_assignment" | "invalid_key" | "unknown";
  capability?: string | null;
};

/**
 * 带结构化配置信息的 API 错误。
 * 只有服务端确认是「缺模型配置」时才会抛这个，别的错误仍走普通 Error。
 */
class ModelConfigApiError extends Error {
  readonly payload: ModelConfigErrorPayload;
  constructor(message: string, payload: ModelConfigErrorPayload) {
    super(message);
    this.name = "ModelConfigApiError";
    this.payload = payload;
  }
}

/** 能力 key → 界面上用的中文名（与后端 CAPABILITY_LABELS 保持一致）。 */
const CAPABILITY_LABELS_FRONTEND: Record<string, string> = {
  chat: "对话创作",
  vision: "图片识别",
  ocr: "文字识别",
  tts: "语音合成",
  video: "视频生成",
  storyboard: "分镜规划",
  embedding: "向量嵌入",
  search: "联网搜索",
};

/**
 * 从 API 响应体里判断是不是「缺模型配置」错误。
 * 服务端约定：这类错误 HTTP 400 + body 带 { kind, capability }。
 */
function isModelConfigError(payload: unknown): payload is ModelConfigErrorPayload {
  if (!payload || typeof payload !== "object") return false;
  const kind = (payload as ModelConfigErrorPayload).kind;
  return kind === "no_provider" || kind === "no_assignment" || kind === "invalid_key";
}

/** 把结构化配置错误翻译成「做什么能解决」的指引。 */
function modelConfigGuidance(payload: ModelConfigErrorPayload): string {
  const label = payload.capability ? CAPABILITY_LABELS_FRONTEND[payload.capability] ?? payload.capability : "";
  switch (payload.kind) {
    case "no_provider":
      return `${label ? `「${label}」` : "该功能"}还没有可用的模型服务。请前往「系统配置」添加模型服务并填写 API Key。`;
    case "no_assignment":
      return `${label ? `「${label}」` : "该功能"}还没有指定使用哪个模型。请前往「系统配置 → 默认模型分配」里选择。`;
    case "invalid_key":
      return `${label ? `「${label}」` : "该模型"}的 API Key 无效或已失效。请前往「系统配置」重新填写并测试连接。`;
    default:
      return "模型配置有误，请前往「系统配置」检查。";
  }
}

type AuthMode = "login" | "register";
type Section =
  | "chat"
  | "library"
  | "publish"
  | "analytics"
  | "knowledge"
  | "accounts"
  | "settings"
  | "users"
  | "profile";

/** 侧栏菜单（顺序即展示顺序） */
const navItems: Array<[Section, string, string]> = [
  ["chat", "对话", "◉"],
  ["library", "内容库", "▦"],
  ["publish", "发布管理", "▣"],
  ["analytics", "效果分析", "◫"],
  ["knowledge", "知识库", "▤"],
  ["accounts", "平台授权管理", "◈"],
  ["settings", "系统配置", "⚙"],
  ["users", "账号管理", "◍"],
  ["profile", "个人中心", "◌"]
];

const sectionTitles: Record<Section, string> = {
  chat: "对话",
  library: "内容库",
  publish: "发布管理",
  analytics: "效果分析",
  knowledge: "知识库",
  accounts: "平台授权管理",
  settings: "系统配置",
  users: "账号管理",
  profile: "个人中心"
};

/** 尚未落地实现、以静态原型（iframe）方式引入平台的分区（系统配置已改为真实面板） */
const prototypeSections: Section[] = ["users"];
type MessageRole = "USER" | "ASSISTANT";
type BindingStatus = "PENDING" | "BOUND" | "UNBOUND";

type User = { id: string; phone: string };

type WechatBinding = {
  id: string;
  status: BindingStatus;
  ticketId?: string | null;
  qrCodeUrl?: string | null;
  wechatNickname?: string | null;
  wechatOpenId?: string | null;
  wechatNo?: string | null;
  boundAt?: string | null;
};

type Message = { id: string; role: MessageRole; content: string; createdAt: string };
type Conversation = { id: string; title: string; updatedAt: string; messages: Message[] };
type ContentItem = {
  id: string;
  title: string;
  body: string;
  category?: string | null;
  coverImageUrl?: string | null;
  videoUrl?: string | null;
  inlineImagesJson?: unknown;
  createdAt: string;
};
type QrData = { ticketId: string; qrCodeUrl?: string; qrCodeText?: string };
type BindingCheckStatus = {
  status: "pending" | "bound" | "unbound";
  ticketId?: string;
  wechatNickname?: string;
  wechatOpenId?: string;
  wechatNo?: string;
};

const bindingWaitTimeoutMs = 490000;
/** 生成绑定二维码的请求超时：首次需加载微信插件 + 请求微信服务器，给足 60 秒。 */
const qrRequestTimeoutMs = 60000;
/** 触发热点选题列表渲染的快捷指令（后两项为旧文案，用于兼容历史对话） */
const hotTopicPrompts = ["今日全网热点", "今日产品热点", "今日全网热点推荐", "今日产品热点推荐"];
/** 内容库瀑布流每页展示条数（滚到底部自动再加载一页）。 */
const LIBRARY_PAGE_SIZE = 12;

/** 内容库类型筛选项：全部 / 小红书 / 公众号 / 头条号 / 视频 / 其他。 */
type ContentKind = "xhs" | "wechat" | "toutiao" | "video" | "other";
type ContentFilterKey = "all" | ContentKind;
const contentFilterOptions: Array<{ key: ContentFilterKey; label: string }> = [
  { key: "all", label: "全部" },
  { key: "xhs", label: "小红书" },
  { key: "wechat", label: "公众号" },
  { key: "toutiao", label: "头条号" },
  { key: "video", label: "视频" },
  { key: "other", label: "其他" }
];

/** 把一条内容归到某一类型：有视频优先算视频，再看 category 文案。 */
function contentKindOf(item: ContentItem): ContentKind {
  if (item.videoUrl || item.category === "视频") return "video";
  const category = item.category ?? "";
  if (category.includes("小红书")) return "xhs";
  if (category.includes("公众号") || category.includes("微信")) return "wechat";
  if (category.includes("头条")) return "toutiao";
  return "other";
}

/** 卡片角标文案与配色，和筛选项保持一致 */
function contentKindMeta(item: ContentItem): { label: string; tagClass: string } {
  switch (contentKindOf(item)) {
    case "xhs":
      return { label: item.category || "小红书", tagClass: "tag-xhs" };
    case "wechat":
      return { label: item.category || "公众号文章", tagClass: "tag-wechat" };
    case "toutiao":
      return { label: item.category || "头条号", tagClass: "tag-toutiao" };
    case "video":
      return { label: item.category || "视频", tagClass: "tag-video" };
    default:
      return { label: "未分类", tagClass: "tag-other" };
  }
}
const fallbackImages = [
  "https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1469334031218-e382a71b716b?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1551836022-d5d88e9218df?auto=format&fit=crop&w=1200&q=80"
];

async function api<T>(path: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
    });
    const payload = (await response.json()) as ApiResponse<T>;
    if (!payload.ok) throw new Error(payload.error);
    return payload.data;
  } catch (error) {
    // fetch 被 abort 时浏览器抛的是底层英文 DOMException（如
    // "signal is aborted without reason"），这里统一换成可读的提示。
    if (timedOut || controller.signal.aborted) {
      throw new Error(`请求超时（已等待 ${Math.round(timeoutMs / 1000)} 秒），请稍后重试。`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function formatDate(value?: string | null): string {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function parseInlineImages(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return parseInlineImages(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function videoUrlFromMessage(content: string): string | null {
  return content.match(/\/videos\/[A-Za-z0-9._-]+\.mp4\b/)?.[0] ?? null;
}

/** 把任意图片 blob 转成 PNG（剪贴板写图片基本只接受 image/png）。 */
async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = objectUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 不支持");
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("图片转换失败"))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("图片编码失败"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 是否为「一键去 AI 味」的产物：这类回复固定由「AI 味检测报告 → 修改后正文 → 质检报告」
 * 三段组成，用签名段落自证，不依赖前后消息顺序（与热点回复同理）。
 */
function isHumanizeResultText(content: string): boolean {
  return /AI\s?味检测报告|去\s?AI\s?味报告|质检报告/.test(content);
}

function isHumanizableArticle(content: string): boolean {
  // 已经带着「去 AI 味报告」的内容不再重复处理
  if (isHumanizeResultText(content)) return false;
  const paragraphs = content.split(/\n\s*\n/).filter((part) => part.trim().length >= 20);
  return content.trim().length >= 300 && (/#\s+\S+/m.test(content) || paragraphs.length >= 3);
}

function matchTopicLine(line: string): string | null {
  const cleaned = line.replace(/^#{1,4}\s*/, "").replace(/^\*\*\s*/, "").trim();
  if (!cleaned) return null;

  let topic: string | null = null;
  const numbered = cleaned.match(/^\d{1,2}[.、．)）]\s*(.+)$/);
  const bullet = cleaned.match(/^[-*•]\s*(.+)$/);
  const chinese = cleaned.match(/^[一二三四五六七八九十]{1,3}[.、．]\s*(.+)$/);
  if (numbered) topic = numbered[1];
  else if (bullet) topic = bullet[1];
  else if (chinese) topic = chinese[1];
  if (!topic) return null;

  topic = topic
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[「」『』]/g, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  return topic.length >= 4 && topic.length <= 80 ? topic : null;
}

type HotTopicEntry = { text: string; evidence?: string };

/**
 * 从热点类回复中抽出可点选的选题列表：
 * - 编号 / 项目符号 / 中文序号行 → 一条热点；
 * - 紧跟其后、以缩进开头且含「相关度 / 命中关键词」的行 → 该热点的命中证据，
 *   收进卡片里展示，不再散落在正文中。
 */
function extractHotTopics(content: string): { topics: HotTopicEntry[]; remainder: string } {
  const topics: HotTopicEntry[] = [];
  const kept: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const topic = matchTopicLine(rawLine.trim());
    if (topic) {
      topics.push({ text: topic });
      continue;
    }
    const trimmed = rawLine.trim();
    const last = topics[topics.length - 1];
    if (last && !last.evidence && /^[ \t\u3000]+\S/.test(rawLine) && /相关度|命中关键词/.test(trimmed)) {
      last.evidence = trimmed;
      continue;
    }
    kept.push(rawLine);
  }
  return { topics, remainder: kept.join("\n") };
}

/**
 * 判断一条助手回复本身是否为「热点推荐结果」（与前后文无关）。
 * 之所以不能只看紧邻的上一条用户消息：热点回复由 agent 长耗时生成，用户可能在等待期间
 * 又发了别的消息（或点了「一键去 AI 味」），导致回复落地时它的前一条已不是那条指令，
 * 卡片就会整块不渲染。这里用回复内容自证，兜住这种情况。
 */
function isHotTopicResultText(content: string): boolean {
  if (/已结合你的知识库产品知识，从今日全网热点中筛选出\s*\d+\s*条相关热点/.test(content)) return true;
  if (/已获取今日全网热点并逐条与知识库产品知识比对，暂未发现与产品相关的热点/.test(content)) return true;
  if (/以下是今日全网热点/.test(content)) return true;
  // 兜底：旧格式的全网热点回复——编号列表 ≥ 3 条，且带榜单/抓取来源这类硬特征。
  // 不能只凭「正文里出现热点二字」：自我介绍、产品介绍这类带项目符号的回复会被误判。
  return (
    /热点/.test(content) &&
    extractHotTopics(content).topics.length >= 3 &&
    /相关度|抓取时间|热榜|热搜榜|热度榜/.test(content)
  );
}

function renderQr(data?: QrData | null, loading?: boolean) {
  if (data?.qrCodeUrl) return <img className="qr-image" src={data.qrCodeUrl} alt="微信绑定二维码" />;
  if (data?.qrCodeText) {
    return (
      <div className="qr-text-card" aria-label="OpenClaw 绑定二维码文本">
        <strong>OpenClaw 已返回绑定内容</strong>
        <span>请使用微信扫码或在 OpenClaw 原始通道中打开。</span>
        <code>{data.qrCodeText}</code>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="qr-empty qr-loading" aria-live="polite">
        <span className="qr-spinner" aria-hidden="true" />
        <span>正在生成二维码，首次加载微信插件约需 10~30 秒，请稍候…</span>
      </div>
    );
  }
  return <div className="qr-empty">暂未获取到绑定二维码，请点击下方按钮重新生成。</div>;
}

/**
 * 视频风格说明。与 remotion/src/theme.ts 的 THEMES.description 对应。
 *
 * 刻意在前端复制一份而不是从 theme.ts import：theme.ts 是 Remotion 侧的模块，
 * 引入前端会让打包器把整个 Remotion 依赖树拖进浏览器 bundle。
 * 代价是新增主题时要同步两处 —— 所以下面写明了对应关系，避免漏改。
 */
const VIDEO_THEME_HINTS: Record<string, string> = {
  "warm-default": "暖褐颗粒感，适合怀旧、人文、生活记录类内容",
  "cool-night": "冷蓝夜色，适合科技、情感、夜景类内容",
  "clean-light": "明亮清爽，适合知识分享、产品介绍类内容",
  "film-revive": "暖褐胶片质感，适合怀旧、故事叙述类内容",
  "acid-graphics": "高饱和流体渐变与金属光泽，适合潮玩、电音、潮流文化类内容",
  "glitch-art": "RGB 错位与画面撕裂，适合科技、悬疑、游戏、赛博类内容",
  "collage-zine": "撕纸边与手写贴纸，适合种草、好物分享、青年文化类内容",
  "swiss-grid": "严格网格与大留白，适合知识科普、商业分析、专业解读类内容",
  "mono-ink": "黑白灰加一笔朱红，适合人文、书法、东方美学类内容",
};

/**
 * 一条新闻素材。
 *
 * `isPrimary` = 这条视频唯一要讲的新闻。其余条目只是背景参考，
 * 会被带进 prompt 但明确禁止写进文案（见 narration.ts 的 newsBlock）。
 */
type GenVideoNewsItem = {
  title: string;
  snippet: string;
  isPrimary?: boolean;
};

/**
 * 一个镜头的方案摘要（对应后端 storyboard.ts 的 PlanSceneSummary）。
 *
 * 为什么用秒而不是毫秒：用户看的是「这个镜头 3.5 秒」，毫秒在这个场景里没有价值。
 */
type GenVideoPlanScene = {
  id: string;
  startSeconds: number;
  outSeconds: number;
  durationSeconds: number;
  /** 用到的素材序号（从 1 开始，对应上传顺序）。 */
  imageIndexes: number[];
  motion: string;
  particles: string;
  overlays: { kind: string; text: string; position: string }[];
  imageNotes: string[];
};

/** /gen-video/plan 返回的方案。 */
type GenVideoPlan = {
  planToken: string;
  requirement: string;
  title: string;
  narration: string;
  theme: string;
  themeReason: string;
  captionStyle: string;
  summary: {
    themeLabel: string;
    durationSeconds: number;
    beatCount: number;
    scenes: GenVideoPlanScene[];
    effects: string[];
    outroText: string;
    fallback: boolean;
  };
  insights: Array<{
    index: number;
    caption: string;
    mood: string;
    subject: string;
    dominantColor: string;
  }>;
  /** 本次文案依据的新闻事实（标题 + 摘要）。让用户能核对「文案到底依据什么」。 */
  newsItems: Array<{ title: string; snippet: string }>;
  audioSeconds: number;
  diagnostics: {
    visionRecognized: number;
    visionTotal: number;
    dshAvailable: boolean;
    /** DSH 不可用时的原因（缺配置 / 找不到合格 Python）。 */
    dshReason?: string;
    /** DSH SDK / 运行时版本，形如「SDK 0.1.5rc1 · 运行时 0.1.5rc1」。 */
    dshVersion?: string;
    /** 版本自检提醒：与本项目核对过的基线不一致时才有内容。 */
    dshVersionNote?: string;
    storyboardFallback: boolean;
    storyboardAttempts: number;
    /** DSH 可用但分镜没通过校验时的原因。 */
    storyboardReason?: string;
    sceneCount: number;
    elapsedMs: number;
    ttsEngine?: string;
  };
  options: {
    effects: ReadonlyArray<{ value: string; label: string }>;
    motions: ReadonlyArray<{ value: string; label: string }>;
    captions: ReadonlyArray<{ value: string; label: string }>;
  };
  /** 「文章转视频」才有：文章来源与图表清单。普通生成视频为 null。 */
  article: {
    sourceType: "url" | "document" | "paste";
    sourceLabel: string;
    sourceUrl?: string;
    title: string;
    summary: string;
    keyPoints: string[];
    charts: Array<{
      id: string;
      kind: string;
      kindLabel: string;
      title: string;
      webPath: string;
      dataSummary: string;
      /** true = 画面上每个数字都在原文/搜索结果里核对过。 */
      verified: boolean;
      /** true = 数据过不了溯源校验，已降级为不含数值的图卡。 */
      downgraded: boolean;
      downgradeReason?: string;
    }>;
    searchUsed: boolean;
    dataGaps: string[];
    notices: string[];
  } | null;
  /** 回显到对话流的方案文本（规划阶段已写入 assistant 消息，前端追加即时展示）。 */
  planEcho: string;
};

/**
 * 效果微调的兜底选项。
 *
 * 正常情况下选项由 /gen-video/plan 随方案一起下发（后端是唯一事实来源），
 * 但用户可能先调效果再生成方案 —— 这时前端也得有可选项，所以这里保留一份本地默认。
 * 两处不一致时以后端为准（方案生成后会自动切换）。
 */
const DEFAULT_LOOK_EFFECTS = [
  { value: "glitch", label: "故障艺术" },
  { value: "acid-flow", label: "酸性流体" },
  { value: "collage", label: "撕纸拼贴" },
  { value: "swiss-grid", label: "瑞士网格" },
];

/** 「一键生成视频」创作要求的默认提示词（打开弹窗即预填，重置后也回到这一句）。 */
const DEFAULT_GEN_VIDEO_REQUIREMENT = "生成ai回忆录宣传片";
const DEFAULT_LOOK_MOTIONS = [
  { value: "auto", label: "跟随分镜（AI 逐镜头挑选）" },
  { value: "ken-burns", label: "缓慢推进" },
  { value: "parallax", label: "视差景深" },
  { value: "zoom-in", label: "推近" },
  { value: "drift-up", label: "上移" },
  { value: "drift-down", label: "下移" },
  { value: "static", label: "静止" },
];
const DEFAULT_LOOK_CAPTIONS = [
  { value: "classic", label: "经典白字" },
  { value: "bold-yellow", label: "醒目黄字" },
  { value: "boxed-dark", label: "半透明底框" },
  { value: "minimal-line", label: "极简细描边" },
];

export default function PlatformClient() {
  const [checkingSession, setCheckingSession] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [phone, setPhone] = useState("13800138000");
  const [password, setPassword] = useState("123456");
  const [authHint, setAuthHint] = useState("演示账号已预填，可直接登录。");
  const [authError, setAuthError] = useState("");
  const [registerQr, setRegisterQr] = useState<QrData | null>(null);
  const [registerBinding, setRegisterBinding] = useState<BindingCheckStatus | null>(null);
  const [registerBound, setRegisterBound] = useState(false);
  const [registerLoading, setRegisterLoading] = useState(false);

  const [section, setSection] = useState<Section>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /** 点「知识库」菜单时自增，用于让知识库面板退出详情/检索，回到列表页。 */
  const [knowledgeResetToken, setKnowledgeResetToken] = useState(0);
  /** 点「发布管理」菜单时自增，让发布面板重新拉一次发布记录。 */
  const [publishResetToken, setPublishResetToken] = useState(0);
  /** 点「效果分析」「平台授权管理」时自增，让面板重新拉数据。 */
  const [analyticsResetToken, setAnalyticsResetToken] = useState(0);
  const [accountsResetToken, setAccountsResetToken] = useState(0);
  /** 点「系统配置」时自增，让模型配置面板重新拉数据。 */
  const [settingsResetToken, setSettingsResetToken] = useState(0);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatError, setChatError] = useState("");
  const [chatErrorSoft, setChatErrorSoft] = useState(false);
  /**
   * 视频 CLI 任务进度（方案 C：OpenClaw spawn 的独立进程，进度靠轮询）。
   *
   * 渲染时按 3 秒间隔查 /gen-video/cli-status，终态后停轮询并展示成品链接。
   */
  const [videoTaskProgress, setVideoTaskProgress] = useState<{
    token: string;
    stage: string;
    percent: number;
    message: string;
    terminal: boolean;
    videoUrl: string | null;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [toast, setToast] = useState<{ message: string; linkLabel?: string; linkSection?: Section } | null>(null);
  const [lastSavedContent, setLastSavedContent] = useState<ContentItem | null>(null);
  const [humanizingMessageId, setHumanizingMessageId] = useState<string | null>(null);
  const [lastVideoUrl, setLastVideoUrl] = useState<string | null>(null);
  const [montagePanelOpen, setMontagePanelOpen] = useState(false);
  const [montageVideoFiles, setMontageVideoFiles] = useState<File[]>([]);
  const [remakePanelOpen, setRemakePanelOpen] = useState(false);
  const [genVideoPanelOpen, setGenVideoPanelOpen] = useState(false);
  const [genVideoImages, setGenVideoImages] = useState<Array<{ file: File; url: string }>>([]);
  const [genVideoRequirement, setGenVideoRequirement] = useState(DEFAULT_GEN_VIDEO_REQUIREMENT);
  const [referenceVideoUrl, setReferenceVideoUrl] = useState("");
  const [referenceVideoFile, setReferenceVideoFile] = useState<File | null>(null);
  const [genVideoPreviewUrl, setGenVideoPreviewUrl] = useState<string | null>(null);
  /** 解说语音引擎：默认「免费合成音」(edge-tts)，免费优先；云端引擎按需切换。 */
  const [genVideoTtsProvider, setGenVideoTtsProvider] = useState<"zhipu" | "qwen" | "edge">("edge");
  /**
   * 视频风格。空串 = 自动（由后端按素材色调推断）。
   *
   * 选项与 remotion/src/theme.ts 的 THEMES 一一对应，新增主题时这里要同步加，
   * 否则用户选不到。theme.ts 是唯一事实来源。
   */
  const [genVideoTheme, setGenVideoTheme] = useState("");
  /** 热点「一键生成视频」：后端正在联网收集信息 / 整理创作要求 / 下载关联配图。 */
  const [videoPreparingTopic, setVideoPreparingTopic] = useState<string | null>(null);

  /* ---------------------------------------------------------------------
   * 视频方案确认（gen-video）
   *
   * 改造前点「开始生成」就一路跑到渲染，用户在 2~5 分钟里看不到任何方案。
   * 现在拆成两步：先「生成方案」（识图 + 风格推断 + 旁白 + 配音 + DeepSeek 分镜，
   * 约 1~2 分钟），把结构化方案摆给用户看并允许调整效果，确认后再出片。
   * ------------------------------------------------------------------- */
  /** 正在生成方案。 */
  const [genVideoPlanning, setGenVideoPlanning] = useState(false);
  /** 规划阶段的实时进展（SSE 流式推到会话里，生成完/失败后清空）。 */
  const [planProgressLines, setPlanProgressLines] = useState<string[]>([]);
  /** 已确认的方案（来自 /gen-video/plan）。null = 还没出方案。 */
  const [genVideoPlan, setGenVideoPlan] = useState<GenVideoPlan | null>(null);
  /** 效果调整：外挂特效层（最多 2 层，与主题自带取并集）。 */
  const [genVideoEffects, setGenVideoEffects] = useState<string[]>([]);
  /** 效果调整：统一运镜；"auto" = 跟随分镜逐镜头挑选。 */
  const [genVideoMotion, setGenVideoMotion] = useState("auto");
  /** 效果调整：字幕样式（走 ffmpeg 烧录通道）。 */
  const [genVideoCaptionStyle, setGenVideoCaptionStyle] = useState("classic");
  /**
   * 本次热点检索到的新闻事实（标题 + 摘要）。
   *
   * 这是「让 AI 真正看懂新闻内容」的关键：它会一路带到旁白生成，
   * 让口播围绕真实报道写，而不是只按创作要求凭空编。
   */
  const [genVideoNewsItems, setGenVideoNewsItems] = useState<GenVideoNewsItem[]>([]);
  /** -------------------------------------------------------------------
   * 文章转视频（gen-article-video）
   *
   * 与「一键生成视频」共用方案面板与出片逻辑，差别只有素材来源：
   * 那边传图片，这边传一篇文章，由服务端画好数据图表再当素材用。
   * ------------------------------------------------------------------- */
  /** 合并后的一键生成视频：同一面板里用 Tab 二选一（参考图 / 参考文章）。 */
  const [videoInputTab, setVideoInputTab] = useState<"image" | "article">("image");
  /** 文章模式下可选的参考图（作为画面素材补充）。 */
  const [articleRefImages, setArticleRefImages] = useState<Array<{ file: File; url: string }>>([]);
  /** 文章来源方式：url = 抓链接，document = 上传文档，paste = 粘贴正文。 */
  const [articleSourceType, setArticleSourceType] = useState<"url" | "document" | "paste">("url");
  const [articleUrl, setArticleUrl] = useState("");
  const [articleFile, setArticleFile] = useState<File | null>(null);
  const [articleText, setArticleText] = useState("");
  /** 额外创作要求（会拼进组装好的创作要求，同时用于解析目标时长「N 秒」）。 */
  const [articleRequirement, setArticleRequirement] = useState("");
  /** 文章数据不够时是否允许联网补充。全流程最多搜一次。 */
  const [articleAllowSearch, setArticleAllowSearch] = useState(true);
  const [articlePlanning, setArticlePlanning] = useState(false);
  /**
   * 主新闻在 genVideoNewsItems 里的下标。
   *
   * 默认 0（prepare 阶段已把模型选出的主新闻排在第一位）。
   * 用户改选后，提交时按这里重排 isPrimary —— 这才是「视频内容与所选新闻一致」的落点：
   * 不是由代码替他决定，而是他能看到、能改。
   */
  const [genVideoPrimaryIndex, setGenVideoPrimaryIndex] = useState(0);

  function removeGenVideoImage(index: number) {
    setGenVideoImages((previous) => {
      const target = previous[index];
      if (target) URL.revokeObjectURL(target.url);
      return previous.filter((_, i) => i !== index);
    });
  }

  function clearGenVideoImages() {
    setGenVideoImages((previous) => {
      previous.forEach((item) => URL.revokeObjectURL(item.url));
      return [];
    });
  }
  const [remakeMaterials, setRemakeMaterials] = useState<File[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 聊天输入区（含展开的面板）容器，用于把实际高度同步给消息列表的留白。 */
  const chatInputBoxRef = useRef<HTMLFormElement | null>(null);
  /** 点「生成方案」后，把本次提交的参考图 + 提示词回显到会话里（流式体验的一部分）。
   *  绑定 conversationId：出片完成后回显会保留，切换会话时不能串到别的对话。 */
  const [videoRequestEcho, setVideoRequestEcho] = useState<{
    prompt: string;
    images: string[];
    conversationId: string;
    /** 文章模式下才有：来源与是否允许联网补充。 */
    article?: { sourceType: string; label: string; allowSearch: boolean };
  } | null>(null);
  const isPinnedRef = useRef(true); // 用户是否在底部附近（用于自动滚动判断）
  const lastScrollHeightRef = useRef(0); // 上一次看到的内容总高度，用来区分「内容变长」和「用户主动上滑」
  const [activeTurnIndex, setActiveTurnIndex] = useState(-1);
  const [tocCollapsed, setTocCollapsed] = useState(true);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const [contentItems, setContentItems] = useState<ContentItem[]>([]);
  const [activeContent, setActiveContent] = useState<ContentItem | null>(null);
  const [visibleContentCount, setVisibleContentCount] = useState(LIBRARY_PAGE_SIZE);
  const [contentFilter, setContentFilter] = useState<ContentFilterKey>("all");
  const libraryScrollRef = useRef<HTMLElement | null>(null);
  const librarySentinelRef = useRef<HTMLDivElement | null>(null);
  const [copyHint, setCopyHint] = useState("");
  const copyHintTimerRef = useRef<number | null>(null);
  const [copiedButton, setCopiedButton] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState<"title" | "body" | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [editingTitle, setEditingTitle] = useState("");
  const [contentSaving, setContentSaving] = useState(false);
  const [publishingContent, setPublishingContent] = useState(false);
  const [publishingHealing, setPublishingHealing] = useState(false);
  const [publishingFrontier, setPublishingFrontier] = useState(false);
  const [regeneratingImage, setRegeneratingImage] = useState<string | null>(null);
  const [wechatBinding, setWechatBinding] = useState<WechatBinding | null>(null);
  const [profileQr, setProfileQr] = useState<QrData | null>(null);
  const [profileQrLoading, setProfileQrLoading] = useState(false);
  const [profileUnbinding, setProfileUnbinding] = useState(false);
  const [confirmingUnbind, setConfirmingUnbind] = useState(false);
  const [profileError, setProfileError] = useState("");
  // 模型选择：当前会话实际使用的模型 + 网关可用模型列表
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [currentModel, setCurrentModel] = useState<CurrentModel>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [switchingModel, setSwitchingModel] = useState(false);
  const [modelNotice, setModelNotice] = useState<{ text: string; status: "running" | "done" | "error" } | null>(null);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [profileHint, setProfileHint] = useState("");
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [rewriteUrlModal, setRewriteUrlModal] = useState(false);
  const [rewriteUrl, setRewriteUrl] = useState("");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0],
    [activeConversationId, conversations]
  );

  // 详情页灯箱图片列表：多主图优先，否则单封面
  const detailLightboxImages = useMemo(() => {
    if (!activeContent) return [] as string[];
    const masters = parseInlineImages(activeContent.inlineImagesJson);
    if (masters.length > 0) return masters;
    return activeContent.coverImageUrl ? [activeContent.coverImageUrl] : [];
  }, [activeContent]);

  // 切换内容时关闭灯箱
  useEffect(() => {
    setLightboxIndex(null);
  }, [activeContent?.id]);

  // 灯箱键盘导航：← 上一张 / → 下一张 / Esc 关闭（首尾循环）
  useEffect(() => {
    if (lightboxIndex === null) return;
    const count = detailLightboxImages.length;
    if (count === 0) {
      setLightboxIndex(null);
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLightboxIndex(null);
      } else if (event.key === "ArrowLeft") {
        setLightboxIndex((current) => (current === null ? null : (current - 1 + count) % count));
      } else if (event.key === "ArrowRight") {
        setLightboxIndex((current) => (current === null ? null : (current + 1) % count));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIndex !== null, detailLightboxImages.length]);

  const userMessages = useMemo(
    () => (activeConversation?.messages ?? []).filter((message) => message.role === "USER"),
    [activeConversation]
  );

  function scrollToMessage(messageId: string) {
    const container = messageListRef.current;
    const el = document.getElementById(`message-${messageId}`);
    if (!el || !container) return;
    const containerTop = container.getBoundingClientRect().top;
    const elTop = el.getBoundingClientRect().top;
    container.scrollTo({ top: container.scrollTop + (elTop - containerTop - 12), behavior: "smooth" });
  }

  /**
   * 把消息列表滚到最底部：两次 rAF 兜住「同一帧内先变大后滚动」的时序，
   * 再延时补贴两次，兜住封面图/字体加载把内容撑高的情形。
   * 每步都检查 isPinnedRef，用户已手动上滑时不会把人拽回底部。
   */
  function scrollListToBottom() {
    const stick = () => {
      if (!isPinnedRef.current) return;
      const container = messageListRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    };
    requestAnimationFrame(() => {
      stick();
      requestAnimationFrame(stick);
    });
    window.setTimeout(stick, 140);
    window.setTimeout(stick, 460);
  }

  /**
   * 发送消息（含点击快捷指令）时，立刻把消息列表定位到底部——也就是最新一条回复
   * 开始输出的位置，并重新开启跟随，让流式输出从第一行起就可见。
   */
  function pinMessageListToBottom() {
    isPinnedRef.current = true;
    setShowScrollBottom(false);
    scrollListToBottom();
  }

  async function refreshMe() {
    try {
      const data = await api<{ user: User; wechatBinding: WechatBinding | null }>("/api/me", undefined, 3000);
      setUser(data.user);
      setWechatBinding(data.wechatBinding);
    } catch {
      setUser(null);
    } finally {
      setCheckingSession(false);
    }
  }

  async function refreshConversations() {
    const data = await api<{ conversations: Conversation[] }>("/api/conversations");
    setConversations(data.conversations);
    // 无论是否为空都重设当前会话：切换登录用户时上一个用户的 activeConversationId 会残留，
    // 不重设会导致 UI 停留在旧账号的会话上（即使列表已换成新用户的）。
    setActiveConversationId(data.conversations[0]?.id ?? null);
  }

  async function refreshContent() {
    const data = await api<{ contentItems: ContentItem[] }>("/api/content");
    setContentItems(data.contentItems);
    return data.contentItems;
  }

  useEffect(() => {
    void refreshMe();
  }, []);

  /**
   * 拉取当前用户自己配置的模型服务列表与「对话与写作」的当前分配。
   * 失败时记下原因，供「选择模型」面板在打开时重试——不能只拉一次就静默放弃。
   */
  async function loadModels() {
    if (modelsLoading) return;
    setModelsLoading(true);
    try {
      const data = await api<{ current: CurrentModel; models: ModelOption[] }>("/api/models", undefined, 30000);
      setModelOptions(data.models ?? []);
      setCurrentModel(data.current);
      setModelsError("");
    } catch (error) {
      // 模型信息拿不到不影响主流程，但要把原因显示出来，否则用户只看到空列表
      const text = error instanceof Error ? error.message : String(error);
      setModelsError(text);
      console.warn("[models] 加载模型列表失败：", error);
    } finally {
      setModelsLoading(false);
    }
  }

  // 登录后加载模型信息
  useEffect(() => {
    if (!user) return;
    void loadModels();
  }, [user]);

  // 输入框被清空后，把自动增高的行高收回去
  useEffect(() => {
    if (chatInput) return;
    const el = chatInputRef.current;
    if (el) el.style.height = "";
  }, [chatInput]);

  /**
   * 把聊天输入区的**实际高度**写进 CSS 变量 --chat-input-height。
   *
   * 背景：消息列表用 `padding-bottom: var(--chat-input-height)` 给输入框留位，
   * 而该变量原本是写死的 140px。一旦输入框里展开面板（视频方案确认、一键剪视频等），
   * 实际高度可能到 500px+，底部消息会被输入框盖住，面板自身的按钮也可能被推出视口
   * —— 用户看到的现象是「按钮看不到，聊天对话框也看不到，要缩放网页才行」。
   *
   * 用 ResizeObserver 而非在渲染后量一次：面板是异步展开的
   * （生成方案要等 1~2 分钟），且文本域会随输入自动增高，都需要实时跟随。
   */
  useEffect(() => {
    const box = chatInputBoxRef.current;
    if (!box) return;

    const sync = () => {
      // offsetHeight 含 padding 与 border，正是消息列表需要让出的总高度
      const height = Math.ceil(box.offsetHeight);
      document.documentElement.style.setProperty("--chat-input-height", `${height}px`);
    };

    sync();
    if (typeof ResizeObserver === "undefined") {
      // 极端老浏览器兜底：窗口尺寸变化时重算（面板展开不会触发 resize，但比没有好）
      window.addEventListener("resize", sync);
      return () => window.removeEventListener("resize", sync);
    }
    const observer = new ResizeObserver(sync);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  /**
   * 切换模型：切换期间锁定输入框，并在对话流里展示切换过程
   * （切换只是改会话配置，不会触发一次模型调用）。
   */
  async function handleSwitchModel(modelId: string, label: string, providerRowId: string) {
    if (switchingModel || sending) return;
    setSwitchingModel(true);
    setModelNotice({ text: `正在切换到 ${label}…`, status: "running" });
    try {
      const data = await api<{ current: CurrentModel }>(
        "/api/models/switch",
        { method: "POST", body: JSON.stringify({ model: modelId, providerRowId }) },
        40000
      );
      setCurrentModel(data.current);
      setModelNotice({ text: `已切换到 ${data.current?.model ?? label}`, status: "done" });
      window.setTimeout(() => setModelNotice(null), 4000);
    } catch (error) {
      setModelNotice({
        text: `切换失败：${error instanceof Error ? error.message : "未知错误"}`,
        status: "error"
      });
    } finally {
      setSwitchingModel(false);
      void loadModels();
    }
  }

  // 瀑布流列数跟随窗口宽度（4 / 3 / 2 / 1）
  // 各类型内容条数（用于筛选胶囊上的计数）
  const contentFilterCounts = useMemo(() => {
    const counts: Record<ContentFilterKey, number> = {
      all: contentItems.length,
      xhs: 0,
      wechat: 0,
      toutiao: 0,
      video: 0,
      other: 0
    };
    for (const item of contentItems) counts[contentKindOf(item)] += 1;
    return counts;
  }, [contentItems]);

  // 按类型筛选后的内容（分页基于筛选结果）
  const filteredContentItems = useMemo(
    () => (contentFilter === "all" ? contentItems : contentItems.filter((item) => contentKindOf(item) === contentFilter)),
    [contentItems, contentFilter]
  );

  // 等高网格：固定 4 列由 CSS 控制，一行四个、同一行卡片等高
  const visibleContentItems = useMemo(
    () => filteredContentItems.slice(0, visibleContentCount),
    [filteredContentItems, visibleContentCount]
  );

  // 进入内容库列表（含从详情退回）时重置为第一页，并回到顶部
  useEffect(() => {
    if (section !== "library" || activeContent) return;
    setVisibleContentCount(LIBRARY_PAGE_SIZE);
    libraryScrollRef.current?.scrollTo({ top: 0 });
  }, [section, activeContent]);

  // 切换筛选时回到第一页并滚回顶部
  useEffect(() => {
    setVisibleContentCount(LIBRARY_PAGE_SIZE);
    libraryScrollRef.current?.scrollTo({ top: 0 });
  }, [contentFilter]);

  // 滚动加载：哨兵进入可视区就再放出一页
  useEffect(() => {
    if (section !== "library" || activeContent) return;
    const sentinel = librarySentinelRef.current;
    const root = libraryScrollRef.current;
    if (!sentinel || !root || visibleContentCount >= filteredContentItems.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisibleContentCount((count) => Math.min(count + LIBRARY_PAGE_SIZE, filteredContentItems.length));
      },
      { root, rootMargin: "160px 0px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [section, activeContent, visibleContentCount, filteredContentItems.length]);

  useEffect(() => {
    if (!user) {
      // 退出登录：清空会话与内容库缓存，避免残留上一个用户的数据。
      setConversations([]);
      setActiveConversationId(null);
      setContentItems([]);
      return;
    }
    void refreshConversations();
    void refreshContent();
  }, [user]);

  // 页面长期开着（比如早上 9:00 定时任务跑的时候）时，回到前台就重新拉一次内容库，
  // 省得用户以为内容没生成。5 秒内重复触发只拉一次，避免 focus 抖动刷太勤。
  useEffect(() => {
    if (!user) return;
    let lastAt = 0;
    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastAt < 5000) return;
      lastAt = now;
      void refreshContent();
    };
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [user]);

  useEffect(() => {
    if (authMode !== "register" || !registerQr || registerBound || registerBinding || registerLoading) return;
    void checkRegisterBinding();
  }, [authMode, registerQr, registerBound, registerBinding]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /**
   * 视频 CLI 进度轮询（方案 C）。
   *
   * CLI 是 OpenClaw spawn 的独立进程，不经 Next.js，所以拿不到 SSE，
   * 只能按 3 秒间隔查 cli-status。终态（成功/失败）后停轮询并刷新会话列表，
   * 让 from-cli 落库的那条 assistant 消息显示出来。
   */
  useEffect(() => {
    if (!videoTaskProgress || videoTaskProgress.terminal) return;
    if (!activeConversation) return;
    const conversationId = activeConversation.id;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await api<{
          ok: boolean;
          data?:
            | { status: "pending" }
            | {
                status: "ok";
                stage: string;
                percent: number;
                message: string;
                terminal: boolean;
                videoUrl: string | null;
              };
          error?: string;
        }>(`/api/conversations/${conversationId}/gen-video/cli-status?token=${encodeURIComponent(videoTaskProgress.token)}`);
        if (cancelled) return;
        if (!res.ok || !res.data || res.data.status === "pending") return;
        // 提到局部变量：TS 不会把 res.data 的收窄带进 setState 闭包。
        const snapshot = res.data;
        if (snapshot.status !== "ok") return;
        setVideoTaskProgress((prev) =>
          prev
            ? {
                ...prev,
                stage: snapshot.stage,
                percent: snapshot.percent,
                message: snapshot.message,
                terminal: snapshot.terminal,
                videoUrl: snapshot.videoUrl,
              }
            : null,
        );
        if (snapshot.terminal) {
          // 终态：刷新会话，把 from-cli 落库的成片消息显示出来
          await refreshConversations();
        }
      } catch {
        // 轮询失败不打扰用户：下一轮会重试，终态时自然停止。
      }
    };

    void poll();
    const timer = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [videoTaskProgress?.token, videoTaskProgress?.terminal, activeConversation?.id]);

  // 切换对话、或从其它分区（内容库等）切回「对话」时，定位到最新一条回复的末尾并重置高亮。
  // 注意：对话面板是条件渲染，切走会整块卸载，切回来时滚动位置会归零，所以这里必须补一次贴底。
  useEffect(() => {
    if (section !== "chat") return;
    lastScrollHeightRef.current = 0;
    isPinnedRef.current = true;
    setShowScrollBottom(false);
    setActiveTurnIndex(userMessages.length > 0 ? 0 : -1);
    scrollListToBottom();
    // 只在切换对话 / 切回对话分区时触发，避免发送消息时频繁重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, section]);

  // 滚动时更新当前高亮的目录项
  useEffect(() => {
    const container = messageListRef.current;
    if (!container || userMessages.length === 0) {
      return;
    }

    function handleScroll() {
      if (!container) return;
      const containerTop = container.getBoundingClientRect().top;
      const activeLine = containerTop + 80;

      let activeIdx = -1;
      for (let i = 0; i < userMessages.length; i++) {
        const el = document.getElementById(`message-${userMessages[i].id}`);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= activeLine) {
          activeIdx = i;
        } else {
          break;
        }
      }
      if (activeIdx !== -1) setActiveTurnIndex(activeIdx);

      // 检测是否在底部附近（80px 容差）
      const height = container.scrollHeight;
      const contentGrew = height > lastScrollHeightRef.current + 1;
      lastScrollHeightRef.current = height;

      const isNearBottom = height - container.scrollTop - container.clientHeight < 80;
      if (isNearBottom) {
        isPinnedRef.current = true;
      } else if (!contentGrew) {
        // 位置变化不是「内容变长」造成的，就是用户自己上滑/拖滚动条 → 停止跟随
        isPinnedRef.current = false;
      }
      // 内容变长导致的偏移不算用户上滑：保持跟随，交给跟随 effect 重新贴底，
      // 避免长回复（如热点列表）落地时长高一大截被误判成「用户滚上去了」。
      setShowScrollBottom(!isNearBottom && !isPinnedRef.current);
    }

    container.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();

    return () => container.removeEventListener("scroll", handleScroll);
  }, [userMessages]);

  // 流式输出时自动滚动到底部（仅在用户未上滑时跟随）
  useEffect(() => {
    if (!messageListRef.current) return;
    if (isPinnedRef.current) scrollListToBottom();
  }, [streamingContent, isThinking, sending, activeConversation?.messages.length, planProgressLines.length]);

  async function ensureRegisterQr(force = false) {
    if (registerLoading) return;
    if (registerQr && !force) return;
    setRegisterLoading(true);
    setAuthError("");
    setAuthHint(registerQr ? "二维码已生成，请用微信扫描并确认。" : "正在向微信申请绑定二维码，请稍候…");
    try {
      const data = await api<QrData>("/api/wechat/binding/qr", { method: "POST", body: "{}" }, qrRequestTimeoutMs);
      setRegisterQr(data);
      setAuthHint("请使用微信扫码绑定 AI 员工通道。");
    } catch (error) {
      setRegisterQr(null);
      setAuthHint("");
      setAuthError(error instanceof Error ? error.message : "生成微信绑定二维码失败。");
    } finally {
      setRegisterLoading(false);
    }
  }

  function changeAuthMode(mode: AuthMode) {
    setAuthMode(mode);
    setAuthError("");
    setAuthHint(mode === "login" ? "演示账号已预填，可直接登录。" : "请先扫码绑定 AI 员工通道。");
    if (mode === "register") void ensureRegisterQr();
  }

  async function checkRegisterBinding() {
    if (!registerQr) {
      await ensureRegisterQr();
      return;
    }
    setRegisterLoading(true);
    setAuthError("");
    setAuthHint("已发起检查，请在微信中完成扫码确认…");
    try {
      const status = await api<BindingCheckStatus>(`/api/wechat/binding/status?ticketId=${encodeURIComponent(registerQr.ticketId)}`, undefined, bindingWaitTimeoutMs);
      if (status.status !== "bound") {
        setAuthHint("OpenClaw 尚未确认微信绑定，请扫码后再检查。");
        return;
      }
      setRegisterBinding(status);
      setRegisterBound(true);
      setAuthHint("微信通道已绑定，请设置手机号和密码完成注册。");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "查询微信绑定状态失败。");
      setAuthHint("二维码约 5 分钟内有效，扫不出或已过期请点「重新生成二维码」。");
    } finally {
      setRegisterLoading(false);
    }
  }

  /**
   * 回到扫码状态重新绑定（用于更换微信，或本地凭据失效需要重新扫描的场景）。
   * 之前一旦 registerBound 为 true 就没有回退入口，用户会被卡在注册表单上。
   */
  function resetRegisterBinding() {
    setRegisterBound(false);
    setRegisterBinding(null);
    setRegisterQr(null);
    setAuthError("");
    setAuthHint("正在向微信申请绑定二维码，请稍候…");
    void ensureRegisterQr(true);
  }

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError("");
    try {
      if (authMode === "register") {
        if (!registerBound || !registerBinding) {
          setAuthError("请先扫码绑定 AI 员工通道。");
          return;
        }
        await api<{ user: User }>("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({ phone, password, binding: registerBinding })
        });
      } else {
        await api<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify({ phone, password }) });
      }
      await refreshMe();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "认证失败。");
    }
  }

  async function logout() {
    await api<{ success: boolean }>("/api/auth/logout", { method: "POST", body: "{}" });
    setUser(null);
    setConversations([]);
    setContentItems([]);
  }

  async function createConversation() {
    const data = await api<{ conversation: Conversation }>("/api/conversations", { method: "POST", body: "{}" });
    setConversations((items) => [data.conversation, ...items]);
    setActiveConversationId(data.conversation.id);
  }

  /**
   * 把一段文本作为 assistant 消息即时追加到当前会话的本地状态。
   * 用于「规划阶段方案回显」：服务端已把方案写进对话流（持久化），
   * 这里再在本地追加一条，让用户在聊天里立刻看到，不必等刷新。
   */
  function appendLocalAssistantMessage(content: string) {
    const conversationId = activeConversation?.id;
    if (!conversationId || !content.trim()) return;
    const echoMessage: Message = {
      id: `echo-${Date.now()}`,
      role: "ASSISTANT",
      content,
      createdAt: new Date().toISOString(),
    };
    setConversations((prev) =>
      prev.map((conv) =>
        conv.id === conversationId ? { ...conv, messages: [...conv.messages, echoMessage] } : conv,
      ),
    );
    pinMessageListToBottom();
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendChatContent(chatInput);
  }

  async function sendChatContent(content: string, url?: string) {
    if (!content.trim() || sending) return;

    // 「一键生成视频 / 文章转视频」收敛到同一个面板：只切换 Tab 并打开，不往会话里发消息。
    const videoShortcut = content.trim();
    if (videoShortcut === "一键生成视频" || videoShortcut === "文章转视频") {
      // 新一轮生成：清掉上一轮保留的回显与方案，弹窗从干净状态开始。
      setGenVideoPlan(null);
      setVideoRequestEcho(null);
      setVideoInputTab(videoShortcut === "文章转视频" ? "article" : "image");
      setGenVideoPanelOpen(true);
      return;
    }

    if (hotTopicPrompts.includes(content.trim())) {
      setMontagePanelOpen(false);
      setMontageVideoFiles([]);
      setRemakePanelOpen(false);
      setReferenceVideoUrl("");
      setReferenceVideoFile(null);
      setRemakeMaterials([]);
    }

    // 没有对话时自动创建一个
    let conversationId = activeConversation?.id;
    if (!conversationId) {
      try {
        const data = await api<{ conversation: Conversation }>("/api/conversations", { method: "POST", body: "{}" });
        setConversations((items) => [data.conversation, ...items]);
        setActiveConversationId(data.conversation.id);
        conversationId = data.conversation.id;
      } catch (error) {
        setChatError(error instanceof Error ? error.message : "创建对话失败。");
        return;
      }
    }

    setChatInput("");
    setSending(true);
    setIsThinking(true);
    setChatError("");
    setStreamingContent("");
    // 立刻定位到会话最末尾（新回复的起始行），保证流式输出可见
    pinMessageListToBottom();

    const tempUserMessage: Message = {
      id: `temp-${Date.now()}`, role: "USER", content, createdAt: new Date().toISOString()
    };
    setConversations((prev) => prev.map((conv) =>
      conv.id === conversationId
        ? { ...conv, messages: [...conv.messages, tempUserMessage] }
        : conv
    ));

    const controller = new AbortController();
    abortControllerRef.current = controller;
    let localStreamContent = "";
    let stoppedByUser = false;

    try {
      const response = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, ...(url ? { url } : {}) }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({ error: "发送失败。" }));
        throw new Error(errorPayload.error || "发送失败。");
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const eventBlock of events) {
          const dataLine = eventBlock.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const data = JSON.parse(dataLine.slice(6));

          if (data.type === "delta") {
            setIsThinking(false);
            localStreamContent += data.text;
            setStreamingContent((prev) => prev + data.text);
          } else if (data.type === "final") {
            setStreamingContent("");
            setIsThinking(false);
            setLastVideoUrl(data.videoUrl || null);
            await refreshConversations();
            if (data.contentSaved) {
              const all = await refreshContent();
              const saved = all.find((c) => c.id === data.contentSaved.id);
              if (saved) setLastSavedContent(saved);
            }
            if (content === "一键剪视频") {
              setMontagePanelOpen(true);
            }
            if (content === "一键生成视频") {
              setVideoInputTab("image");
              setGenVideoPanelOpen(true);
            }
            if (content === "一键复刻爆款视频") {
              setRemakePanelOpen(true);
            }
            // 「文章转视频」已合并进一键生成视频：输入这个词就打开面板的「参考文章」Tab。
            if (content === "文章转视频") {
              setVideoInputTab("article");
              setGenVideoPanelOpen(true);
            }
            // 方案 C：OpenClaw 可能 spawn 了平台视频 CLI。它回传的 JSON 里带 token，
            // 检测到就启动进度轮询，让用户在看会话的地方看到出片进度。
            const videoToken = extractVideoToken(data.message?.content ?? "");
            if (videoToken) {
              setVideoTaskProgress({
                token: videoToken,
                stage: "pending",
                percent: 0,
                message: "视频任务已启动…",
                terminal: false,
                videoUrl: null,
              });
            }
          } else if (data.type === "error") {
            throw streamError(data.error, data.soft === true);
          }
        }
      }
    } catch (error) {
      // 优先用 controller.signal.aborted 判断，比 instanceof DOMException 更稳
      if (controller.signal.aborted) {
        stoppedByUser = true;
        setIsThinking(false);
        if (localStreamContent) {
          const stoppedContent = `**已停止**\n\n${localStreamContent}`;
          try {
            await api(`/api/conversations/${conversationId}/messages/assistant`, {
              method: "POST",
              body: JSON.stringify({ content: stoppedContent })
            });
            await refreshConversations();
          } catch {
            // Ignore save errors
          }
        }
      } else {
        setChatErrorSoft(isSoftError(error));
        setChatError(error instanceof Error ? error.message : "OpenClaw 调用失败。");
      }
    } finally {
      if (!stoppedByUser) {
        setStreamingContent("");
      }
      setIsThinking(false);
      setSending(false);
      abortControllerRef.current = null;
    }
  }

  // 从整段平台分享文案中提取第一条 URL（兼容抖音/小红书/公众号等带描述文案的复制内容）
  function extractShareUrl(input: string): string {
    const match = input.match(/https?:\/\/[^\s，。、；：！？）】』"'`]+/i);
    return match ? match[0] : input.trim();
  }

  async function confirmRewrite() {
    const raw = rewriteUrl.trim();
    if (!raw) return;
    const url = extractShareUrl(raw);
    setRewriteUrlModal(false);
    setRewriteUrl("");
    await sendChatContent("一键仿写爆款", url);
  }

  async function createMontageEdit() {
    const files = montageVideoFiles;
    const conversationId = activeConversation?.id;
    if (!files.length || !conversationId || sending) return;

    setSending(true);
    setIsThinking(true);
    setChatError("");
    setStreamingContent("");
    setMontagePanelOpen(false);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const form = new FormData();
      // 多段视频按选择顺序提交，服务端会先拼接再剪辑。
      for (const file of files) form.append("video", file);
      const response = await fetch(`/api/conversations/${conversationId}/montage`, { method: "POST", body: form, signal: controller.signal });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: "视频剪辑请求失败。" }))) as ApiResponse<unknown>;
        throw new Error(payload.ok ? "视频剪辑请求失败。" : payload.error);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("视频剪辑未返回进度流。");
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const eventBlock of events) {
          const dataLine = eventBlock.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          const data = JSON.parse(dataLine.slice(6));
          if (data.type === "delta") {
            setIsThinking(false);
            setStreamingContent((previous) => previous + data.text);
          } else if (data.type === "final") {
            setLastVideoUrl(data.videoUrl || null);
            setMontageVideoFiles([]);
            await Promise.all([refreshConversations(), refreshContent()]);
          } else if (data.type === "error") {
            throw streamError(data.error, data.soft === true);
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setChatErrorSoft(isSoftError(error));
        setChatError(error instanceof Error ? error.message : "视频剪辑失败。");
      }
    } finally {
      setStreamingContent("");
      setIsThinking(false);
      setSending(false);
      abortControllerRef.current = null;
    }
  }

  /**
   * 只生成方案，不渲染。
   *
   * 这一步要跑识图 + 风格推断 + 旁白 + 配音 + DeepSeek 分镜，约 1~2 分钟
   * （必须含配音：分镜的时间轴骨架来自 TTS 的句级时间戳）。
   * 产出的是**结构化**方案摘要，不是进度文本 —— 用户据此判断方向对不对，
   * 不对就调效果或改创作要求后重来，而不是等 5 分钟看完一条不喜欢的片子。
   */
  /**
   * 把新闻素材序列化成提交给后端的 JSON。
   *
   * 按当前选中的下标重排 isPrimary，并把选中的那条挪到第一位 ——
   * 后端 narration.ts 只认 isPrimary 的那条为「要写进文案的内容」，
   * 所以这里必须保证标记和用户选择一致，而不是沿用 prepare 时的旧标记。
   */
  function buildNewsItemsPayload(): string | null {
    if (!genVideoNewsItems.length) return null;
    const index = Math.min(Math.max(genVideoPrimaryIndex, 0), genVideoNewsItems.length - 1);
    const ordered = [
      genVideoNewsItems[index],
      ...genVideoNewsItems.filter((_, i) => i !== index),
    ].map((item, i) => ({ ...item, isPrimary: i === 0 }));
    return JSON.stringify(ordered);
  }

  /**
   * 消费「生成方案」的 SSE 流（gen-video/plan 与 gen-article-video/plan 共用）。
   *
   * 规划要 1~2 分钟（识图 + 风格 + 旁白 + 配音 + DSH 分镜）。服务端把每一步
   * 作为 progress 事件推下来，这里实时追加到 planProgressLines，让会话里
   * 能看到「正在做什么」，而不是盯着一个灰掉的按钮干等。
   */
  async function consumePlanStream(response: Response): Promise<GenVideoPlan> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("生成方案未返回进度流。");
    const decoder = new TextDecoder();
    let buffer = "";
    let result: GenVideoPlan | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const block of events) {
        const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        let data: {
          type?: string;
          text?: string;
          error?: string;
          modelConfig?: ModelConfigErrorPayload | null;
          data?: GenVideoPlan;
        };
        try {
          data = JSON.parse(dataLine.slice(6));
        } catch {
          continue;
        }
        if (data.type === "progress" && typeof data.text === "string" && data.text.trim()) {
          const line = data.text;
          // 规划进展并入「对话回复的流式输出」（与普通助手回复同一条气泡），
          // 不再用单独的进度卡片，生成完视频后视频预览才能自然排在最后。
          setStreamingContent((previous) => `${previous}${line}\n`);
        } else if (data.type === "done" && data.data) {
          result = data.data;
        } else if (data.type === "error") {
          if (data.modelConfig) {
            throw new ModelConfigApiError(data.error || "生成方案失败。", {
              kind: data.modelConfig.kind,
              capability: data.modelConfig.capability,
            });
          }
          throw new Error(data.error || "生成方案失败。");
        }
      }
    }
    if (!result) throw new Error("生成方案结束但未收到结果，请重试。");
    return result;
  }

  async function planGenVideo(filesArg?: File[], requirementArg?: string) {
    // 第一步仍是弹窗（上传图 + 写提示词），点「生成方案」后走这里进入流式体验。
    const files = filesArg ?? genVideoImages.map((item) => item.file);
    const requirement = (requirementArg ?? genVideoRequirement).trim();
    const conversationId = activeConversation?.id;
    if (!files.length || !conversationId || genVideoPlanning) return;

    setGenVideoPlanning(true);
    setPlanProgressLines([]);
    setChatError("");
    // 把本次提交的参考图 + 提示词回显到会话，并收起弹窗 —— 之后全程在会话里看进展与方案。
    setVideoRequestEcho({
      prompt: requirement,
      // 用独立 objectURL（从 File 现建），不与 genVideoImages 共用：
      // 出片完成时 clearGenVideoImages 会 revoke 原 URL，独立 URL 才能让回显图继续可见。
      images: files.map((file) => URL.createObjectURL(file)),
      conversationId,
    });
    setGenVideoPanelOpen(false);
    // 兜底超时：规划正常 1~2 分钟；若 DSH / 模型服务异常挂住，6 分钟后强制中断，
    // 保证「生成方案」按钮不会永久灰着。
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6 * 60 * 1000);
    try {
      const form = new FormData();
      for (const file of files) form.append("image", file);
      if (requirement) form.append("requirement", requirement);
      form.append("ttsProvider", genVideoTtsProvider);
      // 空串不传，后端收到即视为「自动选风格」
      if (genVideoTheme) form.append("theme", genVideoTheme);
      form.append("lookEffects", genVideoEffects.join(","));
      form.append("lookMotion", genVideoMotion);
      form.append("captionStyle", genVideoCaptionStyle);
      const newsPayload = buildNewsItemsPayload();
      if (newsPayload) form.append("newsItems", newsPayload);

      const response = await fetch(`/api/conversations/${conversationId}/gen-video/plan`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });

      // 早期校验错误（未登录 / 对话不存在 / 图片格式）仍是 JSON + 非 200；
      // 真正开始规划后才是 SSE 流。这里先兜住非 200 的 JSON 错误。
      if (!response.ok) {
        const raw = await response.text();
        let payload: ApiResponse<GenVideoPlan>;
        try {
          payload = JSON.parse(raw) as ApiResponse<GenVideoPlan>;
        } catch {
          const firstLine = raw.replace(/\s+/g, " ").trim().slice(0, 160);
          throw new Error(
            `生成方案接口返回了非 JSON 响应（HTTP ${response.status}），` +
              `通常是服务端编译或运行报错，请查看 dev server 日志。` +
              (firstLine ? ` 响应开头：${firstLine}` : ""),
          );
        }
        if (!payload.ok) {
          if (isModelConfigError(payload)) throw new ModelConfigApiError(payload.error, payload);
          throw new Error(payload.error);
        }
        throw new Error(`生成方案请求失败（HTTP ${response.status}）。`);
      }

      const plan = await consumePlanStream(response);
      setGenVideoPlan(plan);
      // 方案已出：会话内用方案卡片展示（不再追加文本回显，避免重复）；
      // 服务端仍落了一条 assistant 消息，刷新后可见。
      // 出片时走 planToken 由服务端复用已落盘的素材，这里无需再留 file 句柄
      clearGenVideoImages();
    } catch (error) {
      if (controller.signal.aborted) {
        setChatError("生成方案超时（超过 6 分钟），请重试；若反复超时请检查 DSH 与模型服务是否正常。");
      } else if (!reportApiFailure("生成方案失败", error)) {
        setChatError(error instanceof Error ? error.message : "生成方案失败，请稍后重试。");
      }
      // 失败时把第一步弹窗重新打开（参考图/提示词都还在），方便用户调整后重试。
      setGenVideoPanelOpen(true);
    } finally {
      clearTimeout(timeoutId);
      setGenVideoPlanning(false);
      setPlanProgressLines([]);
      // 规划进度并入了流式气泡，收尾清空，避免残留到出片阶段。
      setStreamingContent("");
    }
  }

  /**
   * 消费出片 SSE 流。
   *
   * 「一键生成视频」与「文章转视频」都用它 —— 出片的进度展示、成片入库、
   * 方案清理三段逻辑完全相同，抽出来而不是复制两遍。
   */
  async function consumeRenderStream(response: Response) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("视频生成未返回进度流。");
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const eventBlock of events) {
        const dataLine = eventBlock.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        const data = JSON.parse(dataLine.slice(6));
        if (data.type === "delta") {
          setIsThinking(false);
          setStreamingContent((previous) => previous + data.text);
        } else if (data.type === "final") {
          setLastVideoUrl(data.videoUrl || null);
          clearGenVideoImages();
          setGenVideoRequirement(DEFAULT_GEN_VIDEO_REQUIREMENT);
          // 方案卡片与参考图/提示词回显都保留：出片完成后仍能看到
          // 「这条视频是按什么方案、哪些图、什么要求做的」。
          // 下次点「一键生成视频」时会统一重置（见该入口的清空逻辑）。
          setGenVideoEffects([]);
          setGenVideoMotion("auto");
          setGenVideoCaptionStyle("classic");
          setGenVideoNewsItems([]);
          setGenVideoPrimaryIndex(0);
          // 文章转视频的表单同样清空，避免下次误用上一篇文章。
          setArticleSourceType("url");
          setArticleUrl("");
          setArticleFile(null);
          setArticleText("");
          setArticleRequirement("");
          setArticleRefImages([]);
          // 视频同样入库；把这条内容记下来，让视频消息显示「已保存到内容库 · 查看」入口
          // （不弹全局提示条，只在该消息上给一个查看按钮）。
          if (data.contentSaved) {
            const all = await refreshContent();
            const saved = all.find((c) => c.id === data.contentSaved.id);
            if (saved) setLastSavedContent(saved);
          }
          await refreshConversations();
        } else if (data.type === "error") {
          throw streamError(data.error, data.soft === true, data.modelConfig);
        }
      }
    }
  }

  /** 出片失败时统一解析响应：500 往往是 Next 的 HTML 错误页，必须把状态码带出来。 */
  async function assertRenderOk(response: Response) {
    if (response.ok) return;
    const raw = await response.text();
    let message = `视频生成请求失败（HTTP ${response.status}）。`;
    try {
      const payload = JSON.parse(raw) as ApiResponse<unknown>;
      if (!payload.ok) message = payload.error;
    } catch {
      const firstLine = raw.replace(/\s+/g, " ").trim().slice(0, 160);
      if (firstLine) message += ` 响应开头：${firstLine}`;
    }
    throw new Error(message);
  }

  /**
   * 按已确认的方案出片（跳过识图/旁白/配音/分镜，直接渲染）。
   *
   * 「一键生成视频」与「文章转视频」共用这条路径 —— 两者的出片阶段本来就没有
   * 区别，区别只在方案是怎么来的。
   */
  async function runPlanRender(planToken: string) {
    const conversationId = activeConversation?.id;
    if (!conversationId || sending) return;

    // 出片期间保留参考图 / 提示词 / 方案卡片，让用户在等待时仍能看到这条片子的上下文。
    setSending(true);
    setIsThinking(true);
    setChatError("");
    setStreamingContent("");
    setGenVideoPanelOpen(false);
    setGenVideoPreviewUrl(null);
    // 视频类功能不展示「已保存到内容库」提示条，先清掉可能残留的旧值。
    setLastSavedContent(null);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const form = new FormData();
      form.append("planToken", planToken);
      // TTS 现在在出片阶段才合成，必须把用户选的引擎带过来（否则会退回后端默认）。
      form.append("ttsProvider", genVideoTtsProvider);
      const response = await fetch(`/api/conversations/${conversationId}/gen-video`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      await assertRenderOk(response);
      await consumeRenderStream(response);
    } catch (error) {
      if (!controller.signal.aborted) {
        reportApiFailure("视频生成失败", error);
      }
    } finally {
      setStreamingContent("");
      setIsThinking(false);
      setSending(false);
      abortControllerRef.current = null;
    }
  }

  /**
   * 文章转视频：生成方案。
   *
   * 服务端会先读懂文章、抽取数据并逐条核对出处（对不上的数字不许上图），
   * 再把数据画成图表当作图片素材，最后走与「一键生成视频」完全相同的
   * 配音与分镜流程。所以这里只负责提交来源，成片确认仍走 createGenVideo。
   */
  async function planArticleVideo() {
    const conversationId = activeConversation?.id;
    if (!conversationId || articlePlanning) return;

    if (articleSourceType === "url" && !articleUrl.trim()) {
      setChatError("请填写文章链接。");
      return;
    }
    if (articleSourceType === "document" && !articleFile) {
      setChatError("请选择要上传的文档。");
      return;
    }
    if (articleSourceType === "paste" && !articleText.trim()) {
      setChatError("请粘贴文章正文。");
      return;
    }

    setArticlePlanning(true);
    setPlanProgressLines([]);
    setChatError("");
    // 回显本次提交：文章来源 +（可选）参考图 + 提示词，展示在会话里（与图片模式一致）。
    const articleLabel =
      articleSourceType === "url"
        ? articleUrl.trim()
        : articleSourceType === "document"
          ? articleFile?.name ?? ""
          : `粘贴正文（${articleText.trim().length} 字）`;
    setVideoRequestEcho({
      prompt: articleRequirement.trim(),
      images: articleRefImages.map((item) => item.url),
      conversationId,
      article: { sourceType: articleSourceType, label: articleLabel, allowSearch: articleAllowSearch },
    });
    // 与参考图模式一致：点「生成方案」立刻收起面板，之后全程在会话里看回显 + 流式进展。
    setGenVideoPanelOpen(false);
    // 兜底超时：文章理解 + 配音 + 分镜正常 1~2 分钟，异常挂住时 6 分钟后强制中断。
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6 * 60 * 1000);
    try {
      const form = new FormData();
      form.append("sourceType", articleSourceType);
      if (articleSourceType === "url") form.append("url", articleUrl.trim());
      if (articleSourceType === "document" && articleFile) form.append("file", articleFile);
      if (articleSourceType === "paste") form.append("text", articleText);
      const requirement = articleRequirement.trim();
      if (requirement) form.append("requirement", requirement);
      form.append("ttsProvider", genVideoTtsProvider);
      // 空串不传，后端收到即视为「自动选风格」
      if (genVideoTheme) form.append("theme", genVideoTheme);
      form.append("lookEffects", genVideoEffects.join(","));
      form.append("lookMotion", genVideoMotion);
      form.append("captionStyle", genVideoCaptionStyle);
      if (articleAllowSearch) form.append("allowSearch", "1");
      // 可选参考图：作为画面素材补充，与文章图表一起进入分镜
      for (const item of articleRefImages) form.append("image", item.file);

      const response = await fetch(`/api/conversations/${conversationId}/gen-article-video/plan`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      // 早期校验错误（未登录 / 对话不存在 / 文章来源无效）仍是 JSON + 非 200；
      // 真正开始规划后才是 SSE 流。这里先兜住非 200 的 JSON 错误。
      if (!response.ok) {
        const raw = await response.text();
        let payload: ApiResponse<GenVideoPlan>;
        try {
          payload = JSON.parse(raw) as ApiResponse<GenVideoPlan>;
        } catch {
          const firstLine = raw.replace(/\s+/g, " ").trim().slice(0, 160);
          throw new Error(
            `文章转视频方案接口返回了非 JSON 响应（HTTP ${response.status}），` +
            `通常是服务端编译或运行报错，请查看 dev server 日志。` +
            (firstLine ? ` 响应开头：${firstLine}` : "")
          );
        }
        if (!payload.ok) {
          if (isModelConfigError(payload)) throw new ModelConfigApiError(payload.error, payload);
          throw new Error(payload.error);
        }
        throw new Error(`文章转视频方案请求失败（HTTP ${response.status}）。`);
      }

      const plan = await consumePlanStream(response);
      // 方案已在会话内用方案卡片展示（setGenVideoPlan），这里收起面板即可。
      setGenVideoPlan(plan);
      setGenVideoPanelOpen(false);
    } catch (error) {
      if (controller.signal.aborted) {
        setChatError("生成方案超时（超过 6 分钟），请重试；若反复超时请检查 DSH 与模型服务是否正常。");
      } else if (!reportApiFailure("文章转视频方案生成失败", error)) {
        setChatError(error instanceof Error ? error.message : "生成方案失败，请稍后重试。");
      }
      // 失败时重新打开文章面板（输入都还在），方便调整后重试。
      setGenVideoPanelOpen(true);
    } finally {
      clearTimeout(timeoutId);
      setArticlePlanning(false);
      setPlanProgressLines([]);
      setStreamingContent("");
    }
  }

  async function createGenVideo() {
    // 已有方案（「一键生成视频」出方案后，或「文章转视频」出方案后）：
    // 服务端按 planToken 复用规划阶段落盘的素材，直接渲染，不重传任何素材。
    if (genVideoPlan) {
      await runPlanRender(genVideoPlan.planToken);
      return;
    }

    const files = genVideoImages.map((item) => item.file);
    const conversationId = activeConversation?.id;
    const requirement = genVideoRequirement.trim();
    if (!files.length || !conversationId || sending) return;

    setSending(true);
    setIsThinking(true);
    setChatError("");
    setStreamingContent("");
    setGenVideoPanelOpen(false);
    // 一键生成视频不展示「已保存到内容库」提示条，先清掉可能残留的旧值。
    setLastSavedContent(null);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const form = new FormData();
      for (const file of files) form.append("image", file);
      if (requirement) form.append("requirement", requirement);
      form.append("ttsProvider", genVideoTtsProvider);
      // 空串不传，后端收到即视为「自动选风格」
      if (genVideoTheme) form.append("theme", genVideoTheme);
      form.append("lookEffects", genVideoEffects.join(","));
      form.append("lookMotion", genVideoMotion);
      form.append("captionStyle", genVideoCaptionStyle);
      const newsPayload = buildNewsItemsPayload();
      if (newsPayload) form.append("newsItems", newsPayload);
      const response = await fetch(`/api/conversations/${conversationId}/gen-video`, { method: "POST", body: form, signal: controller.signal });
      // 同 planGenVideo：非 JSON 响应（500 HTML 错误页）要把状态码带出来，
      // 否则只显示一句「视频生成请求失败」，排查时完全没有线索。
      await assertRenderOk(response);
      await consumeRenderStream(response);
    } catch (error) {
      if (!controller.signal.aborted) {
        reportApiFailure("视频生成失败", error);
      }
    } finally {
      setStreamingContent("");
      setIsThinking(false);
      setSending(false);
      abortControllerRef.current = null;
    }
  }

  /**
   * 热点卡片「一键生成视频」：以后端准备好的创作要求 + 关联配图预填生成面板。
   * 准备阶段由 /gen-video/prepare 完成（agent 联网检索 + 知识库 + 下载新闻配图）；
   * 此处只负责把返回的图片转成 File 填入面板，用户确认后复用 createGenVideo() 出片。
   */
  async function startHotTopicVideo(topic: string) {
    const conversationId = activeConversation?.id;
    if (!conversationId || sending || videoPreparingTopic) return;

    setVideoPreparingTopic(topic);
    setChatError("");
    try {
      const response = await fetch(`/api/conversations/${conversationId}/gen-video/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: "短视频准备失败。" }))) as ApiResponse<unknown>;
        throw new Error(payload.ok ? "短视频准备失败。" : payload.error);
      }
      const payload = (await response.json()) as ApiResponse<{
        requirement: string;
        images: Array<{ url: string; name: string }>;
        /**
         * 本次检索到的新闻素材，第一条是主新闻（这条视频唯一要讲的内容）。
         * 必须带到 gen-video：创作要求只说「怎么做」不含「讲什么」，
         * 旁白要靠这些标题摘要才知道该讲什么，否则只能编。
         */
        newsItems?: GenVideoNewsItem[];
        /** 联网检索不可用，已退化为本地整理创作要求（无配图）。 */
        degraded?: boolean;
        degradedReason?: string;
        /** builtin-hot-boards = 内置公开热榜；user-search-service = 用户自己的搜索服务 */
        sourceKind?: "builtin-hot-boards" | "user-search-service";
        /** 图片检索失败时的原因（图片直链来自图库检索，与热点素材不同源） */
        imageSearchNote?: string;
      }>;
      if (!payload.ok) {
        throw new Error(payload.error || "短视频准备失败。");
      }

      const prepared = payload.data;
      // 关联配图已在后端落到 public 同源目录，这里取回转成 File（复用缩略图/大图逻辑）。
      const files: Array<{ file: File; url: string }> = [];
      for (const image of prepared.images ?? []) {
        try {
          const blob = await fetch(image.url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error("bad image"))));
          const type = blob.type || "image/jpeg";
          const extension = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "jpg";
          const name = image.name || `ref.${extension}`;
          files.push({ file: new File([blob], name, { type }), url: URL.createObjectURL(blob) });
        } catch {
          // 单张取回失败就跳过，不影响其它图
        }
      }

      clearGenVideoImages();
      setGenVideoImages(files);
      setGenVideoRequirement(prepared.requirement ?? "");
      setGenVideoNewsItems(prepared.newsItems ?? []);
      setGenVideoPrimaryIndex(0);
      setGenVideoPanelOpen(true);
      if (prepared.degraded) {
        // 降级模式：没有联网资讯与新闻配图，只有本地整理出的创作要求。
        // 说清代价，否则用户会以为「配图加载失败」是 bug。
        setChatError(
          `联网检索不可用（${prepared.degradedReason ?? "所有公开热榜源都没响应"}），已改用本地模式整理创作要求。` +
            "配图需要你在面板中自行上传参考图，出片不受影响。",
        );
      } else if (!files.length) {
        setChatError(
          prepared.imageSearchNote
            ? `创作要求已整理好，但配图检索未成功（${prepared.imageSearchNote}），请在面板中自行上传参考图。`
            : prepared.sourceKind === "builtin-hot-boards"
              ? "已按内置公开热榜整理好创作要求，但未能取回关联配图，请在面板中自行上传参考图。"
              : "已整理好创作要求，但未能取回关联配图，请在面板中自行上传参考图。"
        );
      }
      // 正常出片时不再提示数据源：内置公开热榜是零配置的默认通道，
      // 每次都提醒「你还没配搜索服务」属于噪音，把它留在「系统配置」里说明即可。
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "短视频准备失败，请稍后重试。");
    } finally {
      setVideoPreparingTopic(null);
    }
  }

  async function createViralRemake() {
    const conversationId = activeConversation?.id;
    if (!conversationId || sending) return;
    if (!referenceVideoUrl.trim() && !referenceVideoFile) {
      setChatError("请填写参考视频链接，或上传一个参考视频。");
      return;
    }
    if (!remakeMaterials.length) {
      setChatError("请至少上传一个用于制作的视频或图片素材。");
      return;
    }

    setSending(true);
    setIsThinking(true);
    setChatError("");
    setStreamingContent("");
    setRemakePanelOpen(false);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const form = new FormData();
      if (referenceVideoUrl.trim()) form.append("referenceUrl", referenceVideoUrl.trim());
      if (referenceVideoFile) form.append("referenceVideo", referenceVideoFile);
      remakeMaterials.forEach((file) => form.append("materials", file));
      const response = await fetch(`/api/conversations/${conversationId}/remake`, { method: "POST", body: form, signal: controller.signal });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: "视频制作请求失败。" }))) as ApiResponse<unknown>;
        throw new Error(payload.ok ? "视频制作请求失败。" : payload.error);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("视频制作未返回进度流。");
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const eventBlock of events) {
          const dataLine = eventBlock.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          const data = JSON.parse(dataLine.slice(6));
          if (data.type === "delta") {
            setIsThinking(false);
            setStreamingContent((previous) => previous + data.text);
          } else if (data.type === "final") {
            setLastVideoUrl(data.videoUrl || null);
            setRemakePanelOpen(false);
            setReferenceVideoUrl("");
            setReferenceVideoFile(null);
            setRemakeMaterials([]);
            await Promise.all([refreshConversations(), refreshContent()]);
          } else if (data.type === "error") {
            throw streamError(data.error, data.soft === true);
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setChatErrorSoft(isSoftError(error));
        setChatError(error instanceof Error ? error.message : "视频制作失败。");
      }
    } finally {
      setStreamingContent("");
      setIsThinking(false);
      setSending(false);
      abortControllerRef.current = null;
    }
  }

  function stopGeneration() {
    // 防止重入：若已经 abort，直接 return
    if (!abortControllerRef.current || abortControllerRef.current.signal.aborted) return;
    abortControllerRef.current.abort();
  }

  /** 统一的复制结果提示：底部浮动 toast，2 秒后自动消失（重复触发会重置计时）。 */
  function showCopyHint(text: string) {
    setCopyHint(text);
    if (copyHintTimerRef.current) window.clearTimeout(copyHintTimerRef.current);
    copyHintTimerRef.current = window.setTimeout(() => setCopyHint(""), 2200);
  }

  /**
   * 正文复制到外部平台（如小红书）前的纯文本化：
   * 去掉 markdown 标记符号（标题 #、加粗 **、斜体 *、删除线 ~~、行内代码 `、分隔线 ---），
   * 只保留文字本身——否则粘贴出去会带上「##」这类符号。
   */
  function toPlainTextForPublish(body: string): string {
    return body
      .split("\n")
      .map((line) => {
        // 去掉行首标题符号（## 标题 → 标题）
        let l = line.replace(/^ {0,3}#{1,6}\s+/, "").replace(/ {0,3}#{1,6}\s+$/, "");
        // 分隔线（--- / ***）整行去掉
        if (/^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(l)) return "";
        return l;
      })
      .join("\n")
      .replace(/\*\*\s*([^*]+?)\s*\*\*/g, "$1")
      .replace(/(^|[^*])\*\s*([^*\n]+?)\s*\*(?!\*)/g, "$1$2")
      .replace(/~~\s*([^~]+?)\s*~~/g, "$1")
      .replace(/`\s*([^`]+?)\s*`/g, "$1")
      .replace(/\n{3,}/g, "\n\n");
  }

  async function copyText(text: string, buttonKey: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // 非安全上下文（http 局域网访问）兜底
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("复制失败，请手动选择文本复制");
      }
      setCopiedButton(buttonKey);
      showCopyHint("已复制");
      window.setTimeout(() => setCopiedButton(null), 1600);
    } catch {
      setCopiedButton(null);
      showCopyHint("复制失败，请重试");
    }
  }

  async function humanizeMessage(message: Message) {
    const conversationId = activeConversation?.id;
    if (!conversationId) return;

    setHumanizingMessageId(message.id);
    setSending(true);
    setIsThinking(true);
    setChatError("");
    setStreamingContent("");

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch(`/api/conversations/${conversationId}/humanize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: message.id
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({ error: "去 AI 味处理失败。" }));
        throw new Error(errorPayload.error || "去 AI 味处理失败。");
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const eventBlock of events) {
          const dataLine = eventBlock.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const data = JSON.parse(dataLine.slice(6));

          if (data.type === "user_message") {
            // 「一键去AI味」作为一次对话指令先出现在会话里
            setIsThinking(true);
            await refreshConversations();
            isPinnedRef.current = true;
            requestAnimationFrame(() => {
              const container = messageListRef.current;
              if (container) container.scrollTop = container.scrollHeight;
            });
          } else if (data.type === "delta") {
            setIsThinking(false);
            setStreamingContent((prev) => prev + data.text);
          } else if (data.type === "final") {
            setStreamingContent("");
            setIsThinking(false);
            await refreshConversations();
            if (data.contentSaved) {
              const all = await refreshContent();
              const saved = all.find((c) => c.id === data.contentSaved.id);
              if (saved) setLastSavedContent(saved);
            }
            // 结果已经作为新消息落在会话里了，滚到底部让用户直接看到
            isPinnedRef.current = true;
            requestAnimationFrame(() => {
              const container = messageListRef.current;
              if (container) container.scrollTop = container.scrollHeight;
            });
          } else if (data.type === "error") {
            throw streamError(data.error, data.soft === true);
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setChatErrorSoft(isSoftError(error));
        setChatError(error instanceof Error ? error.message : "去 AI 味处理失败。");
      }
    } finally {
      setStreamingContent("");
      setIsThinking(false);
      setSending(false);
      setHumanizingMessageId(null);
      abortControllerRef.current = null;
    }
  }

  async function copyRichContent(item: ContentItem) {
    const images = parseInlineImages(item.inlineImagesJson);
    const allImages = [
      item.coverImageUrl ?? fallbackImages[0],
      ...images
    ].filter(Boolean) as string[];

    const htmlParts: string[] = [];
    htmlParts.push(`<h1>${escapeHtml(item.title)}</h1>`);
    for (const img of allImages) {
      htmlParts.push(`<img src="${escapeAttr(img)}" alt="配图" />`);
    }
    htmlParts.push(renderMarkdown(item.body));
    const html = htmlParts.join("\n");
    const plain = `${item.title}\n\n${item.body}`;

    try {
      const htmlBlob = new Blob([html], { type: "text/html" });
      const textBlob = new Blob([plain], { type: "text/plain" });
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": htmlBlob,
          "text/plain": textBlob
        })
      ]);
      showCopyHint("图文已复制");
    } catch {
      await navigator.clipboard.writeText(plain);
      showCopyHint("已复制（纯文本）");
    }
  }

  async function copyImage(contentId: string, buttonKey: string, imageUrl?: string | null) {
    // 本地封面（/uploads/...）同源直取，远程封面走代理
    const src = imageUrl && imageUrl.startsWith("/") ? imageUrl : `/api/content/${contentId}/image`;
    let pngCache: Blob | null = null;
    try {
      // 1. Fetch image blob
      const response = await fetch(src);
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "获取图片失败" }));
        throw new Error(error.error || "获取图片失败");
      }
      let blob = await response.blob();
      if (!blob.size) {
        throw new Error("图片为空，请重新生成封面");
      }

      // 2. Check clipboard API support
      if (!navigator.clipboard || !navigator.clipboard.write) {
        throw new Error("浏览器不支持复制图片，请右键图片另存为");
      }

      // 3. Convert to PNG if needed (ClipboardItem typically only supports PNG)
      blob = await toPngBlob(blob);
      pngCache = blob;

      // 4. Write to clipboard
      const item = new ClipboardItem({ "image/png": blob });
      await navigator.clipboard.write([item]);
      setCopiedButton(buttonKey);
      showCopyHint("图片已复制，可粘贴到 Word/微信等");
      window.setTimeout(() => setCopiedButton(null), 1600);
    } catch (err) {
      // 兜底：部分浏览器/环境不允许写入图片，改用 data URL 的 HTML 片段，
      // 粘贴到 Word/公众号编辑器/微信时仍能还原为图片。
      try {
        const png = pngCache ?? (await toPngBlob(await (await fetch(src)).blob()));
        const dataUrl = await blobToDataUrl(png);
        const html = `<img src="${dataUrl}" alt="图片" />`;
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([`【图片】${src}`], { type: "text/plain" }),
          }),
        ]);
        setCopiedButton(buttonKey);
        showCopyHint("已复制（HTML 图片），可粘贴到公众号编辑器");
        window.setTimeout(() => setCopiedButton(null), 1600);
        return;
      } catch {
        // 继续走下面的错误提示
      }
      setCopiedButton(null);
      const msg = err instanceof Error ? err.message : "复制失败，请重试";
      const isClipboardError = /NotAllowed|permission|denied|clipboard/i.test(msg);
      showCopyHint(
        isClipboardError
          ? "复制失败：浏览器未授权剪贴板，请允许后重试（或右键图片另存为）"
          : msg
      );
    }
  }

  function startEditContent(target: "title" | "body") {
    if (!activeContent) return;
    if (target === "title") setEditingTitle(activeContent.title);
    if (target === "body") setEditingBody(activeContent.body);
    setEditingContent(target);
  }

  function cancelEditContent() {
    setEditingContent(null);
    setEditingBody("");
    setEditingTitle("");
  }

  /** 退出详情、回到内容库列表（同时清掉编辑态）。 */
  function exitContentDetail() {
    setActiveContent(null);
    setEditingContent(null);
    setEditingBody("");
    setEditingTitle("");
    setCopyHint("");
  }

  /**
   * 从会话里的「去内容库查看」入口跳转：能定位到刚保存/更新的那篇文章就直接打开详情，
   * 否则退回内容库列表（例如刷新页面后内存里已没有这条记录）。
   */
  function openLibraryFromMessage(target: ContentItem | null) {
    // 目标文章还在内容库列表里才打开详情，否则退回列表页，避免打开一条已删除的内容
    const item = target && contentItems.some((c) => c.id === target.id) ? target : null;
    if (item) {
      setActiveContent(item);
    } else {
      exitContentDetail();
    }
    setSection("library");
  }

  /** 左侧菜单切换：点「内容库」时始终回到列表页，点「知识库」时也始终回到列表页。 */
  function selectSection(key: Section) {
    setSection(key);
    if (key === "library") {
      exitContentDetail();
      // 定时任务会在后台往内容库写内容（每天 9:00 那批）。进内容库时重新拉一次，
      // 否则看到的是打开页面时那份旧列表，会误以为内容没生成。
      void refreshContent();
    }
    if (key === "knowledge") setKnowledgeResetToken((token) => token + 1);
    if (key === "publish") setPublishResetToken((token) => token + 1);
    if (key === "analytics") setAnalyticsResetToken((token) => token + 1);
    if (key === "accounts") setAccountsResetToken((token) => token + 1);
    if (key === "settings") {
      setSettingsResetToken((token) => token + 1);
      // 模型配置改完，回到对话页时 model 选择器要 reflect 最新的 chat 分配
      void loadModels();
    }
  }

  /**
   * 统一处理「缺模型配置」类错误。
   *
   * 为什么要单独抽出来：这类错误用户**能自己解决**，但错误文案本身
   * 只是一句「未配置 X」，他不知道该点哪里。所以除了文案，还必须给一个
   * 可点击的「去系统配置」入口 —— 否则用户只能去翻菜单找。
   *
   * 同时走两处提示（不重复）：
   *  - setChatError：常驻输入框上方，处理完不走；
   *  - setToast：带跳转按钮，4 秒后自动消失，视线离开输入框也能看到。
   */
  function reportModelConfigError(payload: ModelConfigErrorPayload) {
    const guidance = modelConfigGuidance(payload);
    setChatError(guidance);
    setToast({ message: guidance, linkLabel: "去系统配置", linkSection: "settings" });
  }

  /**
   * 把 fetch 失败 / 业务错误统一转成用户可读提示。
   * 返回 true 表示「这是缺配置错误，已给出指引」。
   *
   * 同时认两种来源：
   *  - `ModelConfigApiError`：JSON 接口（/gen-video/plan）直接抛出的
   *  - `error.modelConfig`：SSE 流（/gen-video）在 error 事件里挂上来的
   */
  function reportApiFailure(context: string, error: unknown): boolean {
    const payload =
      (error as { modelConfig?: ModelConfigErrorPayload } | null)?.modelConfig ??
      (error instanceof ModelConfigApiError ? error.payload : undefined);
    if (payload && isModelConfigError(payload)) {
      reportModelConfigError(payload);
      return true;
    }
    setChatErrorSoft(isSoftError(error));
    setChatError(`${context}：${error instanceof Error ? error.message : "未知错误"}`);
    return false;
  }

  async function saveContentEdit() {
    if (!activeContent) return;
    setContentSaving(true);
    setCopiedButton(null);
    setCopyHint("");
    try {
      const data = await api<{ contentItem: ContentItem }>(`/api/content/${activeContent.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: editingContent === "title" ? editingTitle : activeContent.title,
          body: editingContent === "body" ? editingBody : activeContent.body
        })
      });
      setActiveContent(data.contentItem);
      setEditingContent(null);
      await refreshContent();
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setContentSaving(false);
    }
  }

  async function downloadAllImages(contentId: string) {
    try {
      const res = await fetch(`/api/content/${contentId}/images-zip`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "下载失败" }));
        showCopyHint(err.error || "主图下载失败");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${((activeContent?.title || "主图").replace(/[\\/:*?"<>|]/g, "_") || "主图")}_主图.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showCopyHint("已开始下载主图 zip");
    } catch {
      showCopyHint("主图下载失败，请重试");
    }
  }

  async function regenerateImage(imageType: "cover" | "inline", imageIndex: number) {
    if (!activeContent) return;
    const key = `${imageType}-${imageIndex}`;
    setRegeneratingImage(key);
    setCopiedButton(null);
    setCopyHint("");
    try {
      const data = await api<{ contentItem: ContentItem; imageUrl: string }>(
        `/api/content/${activeContent.id}/regenerate-image`,
        {
          method: "POST",
          body: JSON.stringify({ imageType, imageIndex })
        }
      );
      setActiveContent(data.contentItem);
      await refreshContent();
      showCopyHint("图片已重新生成");
    } catch (error) {
      showCopyHint(error instanceof Error ? error.message : "图片重新生成失败。");
    } finally {
      setRegeneratingImage(null);
    }
  }

  /** 把当前这篇图文发布到官网「好物推荐」板块（hgwx.aimemory.cafe）。 */
  async function publishToSite() {
    if (!activeContent || publishingContent) return;
    setPublishingContent(true);
    setCopiedButton(null);
    setCopyHint("");
    try {
      const data = await api<{ skipped?: boolean; message?: string; title: string }>(
        `/api/content/${activeContent.id}/publish`,
        { method: "POST", body: JSON.stringify({ channel: "hgwx" }) }
      );
      if (data.skipped) {
        showCopyHint(data.message || "该内容已发布过。");
      } else {
        showCopyHint("已发布到官网好物推荐");
      }
    } catch (error) {
      showCopyHint(error instanceof Error ? error.message : "发布失败。");
    } finally {
      setPublishingContent(false);
    }
  }

  /** 把当前这篇图文推送到 AI回忆录官网「心灵驿站」频道（aimemory.cafe/healing.html）。 */
  async function publishToHealing() {
    if (!activeContent || publishingHealing) return;
    setPublishingHealing(true);
    setCopiedButton(null);
    setCopyHint("");
    try {
      const data = await api<{ skipped?: boolean; message?: string; title: string }>(
        `/api/content/${activeContent.id}/publish`,
        { method: "POST", body: JSON.stringify({ channel: "healing" }) }
      );
      if (data.skipped) {
        showCopyHint(data.message || "该内容已推送到心灵驿站。");
      } else {
        showCopyHint(data.message || "已推送到官网心灵驿站");
      }
    } catch (error) {
      showCopyHint(error instanceof Error ? error.message : "推送失败。");
    } finally {
      setPublishingHealing(false);
    }
  }

  /** 把当前这篇图文推送到 AI员工官网「AI最前沿」频道（aiworker.aimemory.cafe/frontier.html）。 */
  async function publishToFrontier() {
    if (!activeContent || publishingFrontier) return;
    setPublishingFrontier(true);
    setCopiedButton(null);
    setCopyHint("");
    try {
      const data = await api<{ skipped?: boolean; message?: string; title: string }>(
        `/api/content/${activeContent.id}/publish`,
        { method: "POST", body: JSON.stringify({ channel: "aiworker" }) }
      );
      if (data.skipped) {
        showCopyHint(data.message || "该内容已推送到 AI最前沿。");
      } else {
        showCopyHint(data.message || "已推送到 AI最前沿");
      }
    } catch (error) {
      showCopyHint(error instanceof Error ? error.message : "推送失败。");
    } finally {
      setPublishingFrontier(false);
    }
  }

  async function ensureProfileQr() {
    if (profileQrLoading) return;
    setProfileQrLoading(true);
    setProfileError("");
    try {
      const data = await api<QrData>("/api/wechat/binding/qr", { method: "POST", body: "{}" }, qrRequestTimeoutMs);
      setProfileQr(data);
    } catch (error) {
      setProfileQr(null);
      setProfileError(error instanceof Error ? error.message : "生成微信绑定二维码失败。");
    } finally {
      setProfileQrLoading(false);
    }
  }

  async function checkProfileBinding() {
    if (!profileQr) return;
    setProfileError("");
    try {
      await api<BindingCheckStatus>(`/api/wechat/binding/status?ticketId=${encodeURIComponent(profileQr.ticketId)}`, undefined, bindingWaitTimeoutMs);
      await refreshMe();
      setProfileQr(null);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "查询微信绑定状态失败。");
    }
  }

  async function unbindWechat() {
    if (profileUnbinding) return;
    setProfileUnbinding(true);
    setProfileError("");
    try {
      await api<{ success: boolean }>("/api/wechat/binding", { method: "DELETE", body: "{}" });
      await refreshMe();
      setProfileQr(null);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "解除绑定失败。");
    } finally {
      setProfileUnbinding(false);
      setConfirmingUnbind(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await api<{ success: boolean }>("/api/profile/password", { method: "PATCH", body: JSON.stringify({ oldPassword, newPassword }) });
      setOldPassword("");
      setNewPassword("");
      setProfileHint("密码已修改成功。");
      setShowPasswordModal(false);
    } catch (error) {
      setProfileHint(error instanceof Error ? error.message : "修改密码失败。");
    }
  }

  function openPasswordModal() {
    setOldPassword("");
    setNewPassword("");
    setProfileHint("密码修改后，下次登录请使用新密码。");
    setShowPasswordModal(true);
  }

  function closePasswordModal() {
    setShowPasswordModal(false);
  }

  if (checkingSession) return <main className="auth-shell"><div className="auth-card">正在进入创星云...</div></main>;

  if (!user) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="auth-promo">
            <span className="eyebrow">AI Digital Workforce</span>
            <h1>创星云-AI数字员工平台</h1>
            <p className="sub">快速创建你的AI数字员工军团</p>

            <div className="stats">
              <div className="stat">
                <span className="value">24/7</span>
                <span className="label">随时响应</span>
              </div>
              <div className="stat">
                <span className="value">12+</span>
                <span className="label">岗位模板</span>
              </div>
              <div className="stat">
                <span className="value">3min</span>
                <span className="label">创建员工</span>
              </div>
            </div>

            <div className="employee-list">
              <div className="employee-card">
                <div className="avatar">AI-01</div>
                <div className="info">
                  <span className="name">选题策略员</span>
                  <span className="desc">正在生成明日公众号选题</span>
                </div>
              </div>
              <div className="employee-card">
                <div className="avatar">AI-02</div>
                <div className="info">
                  <span className="name">图文创作员</span>
                  <span className="desc">已完成 4 篇内容草稿</span>
                </div>
              </div>
              <div className="employee-card">
                <div className="avatar">AI-03</div>
                <div className="info">
                  <span className="name">微信指挥中枢</span>
                  <span className="desc">等待移动端任务调度</span>
                </div>
              </div>
            </div>
          </div>

          <div className="auth-panel">
            <div className="auth-tabs">
              <button className={authMode === "login" ? "active" : ""} onClick={() => changeAuthMode("login")}>登录</button>
              <button className={authMode === "register" ? "active" : ""} onClick={() => changeAuthMode("register")}>注册</button>
            </div>
            {authMode === "register" && !registerBound && (
              <div className="qr-panel">
                <strong>请先绑定微信通道</strong>
                <p>扫码绑定后，即可在微信里指挥 AI 员工完成选题推荐、图文生成和内容改写。</p>
                {renderQr(registerQr, registerLoading)}
                <button
                  type="button"
                  onClick={() => { void (registerQr ? checkRegisterBinding() : ensureRegisterQr(true)); }}
                  disabled={registerLoading}
                >
                  {registerLoading
                    ? (registerQr ? "等待微信扫码确认…" : "正在生成二维码…")
                    : (registerQr ? "检查绑定状态" : "重新生成二维码")}
                </button>
                {registerQr && !registerLoading && (
                  <button type="button" className="qr-secondary" onClick={() => { void ensureRegisterQr(true); }}>
                    二维码扫不出？重新生成
                  </button>
                )}
              </div>
            )}
            {authMode === "register" && registerBound && (
              <div className="binding-status">
                <span className="binding-status-info">
                  <span className="binding-dot" aria-hidden="true" />
                  微信通道已绑定
                </span>
                <button type="button" className="qr-secondary" onClick={resetRegisterBinding}>
                  更换微信
                </button>
              </div>
            )}
            {(authMode === "login" || registerBound) && (
              <form className="auth-form" onSubmit={handleAuth}>
                <label>手机号<input value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
                <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
                <button type="submit">{authMode === "login" ? "登录" : "注册并登录"}</button>
              </form>
            )}
            <p className="hint">{authHint}</p>
            {authError && <p className="error-text">{authError}</p>}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar" aria-label="主菜单">
        <div className="sidebar-top">
          <div className="sidebar-brand">
            <div className="brand-avatar">AI</div>
            <div className="brand-text">
              <span className="brand-title">创星云</span>
              <span className="brand-sub">AI数字员工平台</span>
            </div>
          </div>
          <button className="sidebar-toggle" type="button" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? "展开左侧菜单" : "收起左侧菜单"} title={sidebarCollapsed ? "展开菜单" : "收起菜单"}>{sidebarCollapsed ? "›" : "‹"}</button>
        </div>
        <nav>
          {navItems.map(([key, label, icon]) => (
            <button key={key} className={section === key ? "active" : ""} onClick={() => selectSection(key)} title={label}><span className="nav-icon" aria-hidden="true">{icon}</span><span className="nav-label">{label}</span></button>
          ))}
        </nav>
      </aside>

      <section className="workspace">
        {section === "chat" && (
          <div className="chat-layout">
            <aside className="history-panel">
              <div className="history-panel-head">
                <span className="title">历史列表</span>
                <button className="new-button" onClick={createConversation}>＋ 新建</button>
              </div>
              {conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  className={`history-item ${activeConversation?.id === conversation.id ? "active" : ""}`}
                  onClick={() => { setActiveConversationId(conversation.id); setLastSavedContent(null); setLastVideoUrl(null); }}
                >
                  <strong>{conversation.title}</strong>
                  <span className="preview">{conversation.messages.at(-1)?.content ?? "尚未发送消息"}</span>
                  <span className="meta">{formatDate(conversation.updatedAt)}</span>
                </button>
              ))}
            </aside>
            <section className="chat-panel">
              <div className="chat-head">
                <div className="left">
                  <h3>{activeConversation?.title ?? "请新建对话"}</h3>
                  <span className="date">{activeConversation ? formatDate(activeConversation.updatedAt) : "—"}</span>
                </div>
                {activeConversation && (
                  <div className="right">
                    <span className="continue-pill">● 可继续对话</span>
                  </div>
                )}
              </div>
              <div className="chat-body">
                <div className="chat-stream">
                  <div className="message-list" ref={messageListRef}>
                    {(() => {
                      const messages = activeConversation?.messages ?? [];
                      const lastAssistantId = messages.filter((m) => m.role === "ASSISTANT").slice(-1)[0]?.id;
                      return messages.map((message, messageIndex) => {
                        const messageVideoUrl = message.role === "ASSISTANT" ? videoUrlFromMessage(message.content) : null;
                        const previousMessage = messages[messageIndex - 1];
                        const isHotTopicsReply =
                          message.role === "ASSISTANT" &&
                          ((previousMessage?.role === "USER" &&
                            hotTopicPrompts.includes(previousMessage.content.trim())) ||
                            isHotTopicResultText(message.content));
                        // 热点推荐是列表型结果、非图文成品，不提供「一键去 AI 味」
                        const showHumanize =
                          message.role === "ASSISTANT" &&
                          message.id === lastAssistantId &&
                          !isHotTopicsReply &&
                          // 视频消息不做「去 AI 味」：它没有可改写的正文，
                          // 只保留「已保存到内容库 · 查看」入口即可。
                          !messageVideoUrl &&
                          isHumanizableArticle(message.content);
                        // 「一键去 AI 味」的产物：正文已回写内容库，给一个明确的查看入口
                        const isHumanizeResult = message.role === "ASSISTANT" && isHumanizeResultText(message.content);
                        const isLastAssistant = message.role === "ASSISTANT" && message.id === lastAssistantId;
                        // 这条消息对应刚写入内容库的那篇文章（用于「查看」直接打开详情）
                        const savedContentForMessage = isLastAssistant ? lastSavedContent : null;
                        // 去 AI 味回复的正文/报告里也有编号列表，绝不能渲染成热点选题卡片
                        const hotTopics =
                          isHotTopicsReply && !isHumanizeResult ? extractHotTopics(message.content) : null;
                        return (
                        <article
                          key={message.id}
                          id={`message-${message.id}`}
                          className={`message ${message.role === "USER" ? "user" : "assistant"}`}
                          // 出片结果是对话里最后要看到的东西：用 order 把它排到回显/方案/进度之后
                          // （.message-list 是 grid）。仅在「无任何进行中的生成/规划」时生效——
                          // 否则重新生成方案/出片时，进行中的流式进度气泡（order:1000）会被旧视频压到上方。
                          style={
                            messageVideoUrl && isLastAssistant && !sending && !genVideoPlanning && !articlePlanning
                              ? { order: 999 }
                              : undefined
                          }
                        >
                          {message.role === "ASSISTANT" ? (
                            <>
                              <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(hotTopics ? hotTopics.remainder : message.content) }} />
                              {hotTopics && hotTopics.topics.length >= 1 && (
                                <div className="topic-actions">
                                  {hotTopics.topics.map((topic, topicIndex) => (
                                    <div className="topic-action-row" key={`${message.id}-topic-${topicIndex}`}>
                                      <div className="topic-action-main">
                                        <span className="topic-action-label">{topicIndex + 1}. {topic.text}</span>
                                        {topic.evidence && <span className="topic-action-evidence">{topic.evidence}</span>}
                                      </div>
                                      <div className="topic-gen-buttons">
                                        <button
                                          type="button"
                                          className="topic-gen-btn"
                                          disabled={sending}
                                          onClick={() => void sendChatContent(`根据这个选题写一篇小红书风格的图文：${topic.text}`)}
                                        >
                                          小红书创作
                                        </button>
                                        <button
                                          type="button"
                                          className="topic-gen-btn topic-gen-btn-wechat"
                                          disabled={sending}
                                          onClick={() => void sendChatContent(`根据这个选题写一篇公众号风格的图文：${topic.text}`)}
                                        >
                                          公众号创作
                                        </button>
                                        <button
                                          type="button"
                                          className="topic-gen-btn topic-gen-btn-video"
                                          disabled={sending || videoPreparingTopic !== null}
                                          onClick={() => void startHotTopicVideo(topic.text)}
                                        >
                                          {videoPreparingTopic === topic.text ? "准备中…" : "一键生成视频"}
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {messageVideoUrl && (
                                <>
                                  <div className="video-player-wrap">
                                    <video controls src={messageVideoUrl} className="inline-video-player" />
                                  </div>
                                  <a
                                    className="video-open-link"
                                    href={messageVideoUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    打开视频 / 下载 →
                                  </a>
                                </>
                              )}
                            </>
                          ) : (
                            message.content
                          )}
                          {message.role === "ASSISTANT" && (isHumanizeResult || savedContentForMessage || showHumanize) && (
                            <div className={`message-actions${messageVideoUrl ? " message-actions-left" : ""}`}>
                              {isHumanizeResult ? (
                                <button
                                  className="message-saved-link humanize-saved-link"
                                  onClick={() => openLibraryFromMessage(isLastAssistant ? savedContentForMessage : null)}
                                >
                                  ✓ 已去 AI 味并更新到内容库 · 去查看
                                </button>
                              ) : (
                                savedContentForMessage && (
                                  <button
                                    className="message-saved-link"
                                    onClick={() => openLibraryFromMessage(savedContentForMessage)}
                                  >
                                    ✓ 已保存到内容库 · 查看
                                  </button>
                                )
                              )}
                              {showHumanize && (
                                <button
                                  className="message-copy-button humanize-button"
                                  disabled={humanizingMessageId === message.id}
                                  onClick={() => humanizeMessage(message)}
                                >
                                  {humanizingMessageId === message.id ? "去 AI 味中..." : "一键去 AI 味"}
                                </button>
                              )}
                            </div>
                          )}
                        </article>
                      );
                      });
                    })()}
                    {/* 对话内「一键生成视频」：先回显用户提交的参考图 + 提示词 */}
                    {videoRequestEcho && videoRequestEcho.conversationId === activeConversation?.id && (
                      <article className="message user video-request-echo">
                        <div className="video-request-prompt">
                          {videoRequestEcho.prompt || "（未填写创作要求，按素材自动生成）"}
                        </div>
                        {videoRequestEcho.article && (
                          <div className="video-request-article">
                            <span className="video-request-article-badge">参考文章</span>
                            <span className="video-request-article-label">{videoRequestEcho.article.label}</span>
                            {videoRequestEcho.article.allowSearch && (
                              <span className="video-request-search-badge">允许联网补充（≤1 次）</span>
                            )}
                          </div>
                        )}
                        {videoRequestEcho.images.length > 0 && (
                          <>
                            <div className="video-request-images-label">
                              {videoRequestEcho.article ? "参考图（可选）" : "参考图"}
                            </div>
                            <div className="video-request-images">
                              {videoRequestEcho.images.map((src, index) => (
                                <img
                                  key={index}
                                  src={src}
                                  alt={`参考图 ${index + 1}`}
                                  onClick={() => setGenVideoPreviewUrl(src)}
                                />
                              ))}
                            </div>
                          </>
                        )}
                      </article>
                    )}
                    {planProgressLines.length > 0 && (
                      <article className="message assistant streaming plan-progress">
                        <div className="plan-progress-head">
                          <span className="thinking-indicator">
                            <span className="thinking-dots">
                              <span className="thinking-dot" />
                              <span className="thinking-dot" />
                              <span className="thinking-dot" />
                            </span>
                            正在生成视频方案…
                          </span>
                        </div>
                        <ul className="plan-progress-list">
                          {planProgressLines.map((line, index) => (
                            <li
                              key={index}
                              className={index === planProgressLines.length - 1 ? "current" : ""}
                            >
                              {line}
                            </li>
                          ))}
                        </ul>
                      </article>
                    )}
                    {/* 对话内方案卡片：图片 / 文章两种输入都走这里（合并后统一展示） */}
                    {genVideoPlan && !genVideoPanelOpen && (
                      <article className="message assistant gen-video-plan-inline">
                        <div className="gen-video-plan">
                          <div className="gen-video-plan-head">
                            <strong>AI 视频方案</strong>
                            <span className="gen-video-plan-meta">
                              {genVideoPlan.summary.scenes.length} 个镜头 · 约{" "}
                              {genVideoPlan.summary.durationSeconds.toFixed(1)} 秒
                              {genVideoPlan.audioSeconds > 0
                                ? ` · 配音 ${genVideoPlan.audioSeconds.toFixed(1)} 秒`
                                : " · 无配音"}
                            </span>
                          </div>
                          {genVideoPlan.title && (
                            <div className="gen-video-plan-row">
                              <span className="gen-video-plan-key">标题</span>
                              <span className="gen-video-plan-val">{genVideoPlan.title}</span>
                            </div>
                          )}
                          <div className="gen-video-plan-row">
                            <span className="gen-video-plan-key">建议风格</span>
                            <span className="gen-video-plan-val">
                              {genVideoPlan.summary.themeLabel}
                              {genVideoPlan.themeReason && (
                                <span className="gen-video-plan-note">{genVideoPlan.themeReason}</span>
                              )}
                            </span>
                          </div>
                          {genVideoPlan.article && (
                            <div className="gen-video-plan-block">
                              <div className="gen-video-plan-key">
                                参考文章
                                <span className="article-source-badge">
                                  {genVideoPlan.article.sourceType === "url"
                                    ? "链接"
                                    : genVideoPlan.article.sourceType === "document"
                                      ? "文档"
                                      : "粘贴"}
                                  · {genVideoPlan.article.sourceLabel}
                                </span>
                                {genVideoPlan.article.sourceUrl && (
                                  <a
                                    className="article-source-link"
                                    href={genVideoPlan.article.sourceUrl}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                  >
                                    查看原文
                                  </a>
                                )}
                              </div>
                              {genVideoPlan.article.summary && (
                                <p className="article-plan-summary">{genVideoPlan.article.summary}</p>
                              )}
                              <span className="gen-video-engine-hint">
                                共 {genVideoPlan.article.charts?.length ?? 0} 张数据图表作为画面素材；
                                带数值的图表都经过原文核对，补充数据标注来源链接。
                              </span>
                            </div>
                          )}
                          <div className="gen-video-plan-block">
                            <div className="gen-video-plan-key">镜头安排</div>
                            <div className="gen-video-scene-list">
                              {genVideoPlan.summary.scenes.map((scene, index) => (
                                <div key={scene.id} className="gen-video-scene">
                                  <span className="gen-video-scene-no">{index + 1}</span>
                                  <span className="gen-video-scene-time">
                                    {scene.startSeconds.toFixed(1)}–{scene.outSeconds.toFixed(1)}s
                                  </span>
                                  <span className="gen-video-scene-body">
                                    {scene.imageIndexes.length > 0 && (
                                      <span className="gen-video-scene-imgs">
                                        图 {scene.imageIndexes.join("、")}
                                      </span>
                                    )}
                                    <span className="gen-video-scene-motion">{scene.motion}</span>
                                    {scene.overlays
                                      .filter((overlay) => overlay.text)
                                      .map((overlay, k) => (
                                        <span key={k} className="gen-video-scene-overlay">
                                          {overlay.text}
                                        </span>
                                      ))}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                          {genVideoPlan.narration && (
                            <details className="gen-video-plan-narration" open>
                              <summary>旁白文案（{genVideoPlan.summary.beatCount} 句）</summary>
                              <p>{genVideoPlan.narration}</p>
                            </details>
                          )}
                          {genVideoPlan.summary.fallback && (
                            <div className="gen-video-plan-warnings">
                              <span className="gen-video-plan-warn">
                                DeepSeek 分镜不可用，这份方案用的是固定节奏兜底（不影响出片）。
                              </span>
                            </div>
                          )}
                          <div className="viral-remake-actions">
                            <button
                              type="button"
                              onClick={() => {
                                setGenVideoPlan(null);
                                setGenVideoEffects([]);
                                setGenVideoPreviewUrl(null);
                                setVideoRequestEcho(null);
                                setGenVideoImages([]);
                                setGenVideoRequirement(DEFAULT_GEN_VIDEO_REQUIREMENT);
                              }}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              disabled={genVideoPlanning || sending}
                              onClick={() => {
                                // 回到第一步弹窗（参考图 / 提示词 / 效果都还在），改完再点「生成方案」。
                                setGenVideoPlan(null);
                                setGenVideoEffects([]);
                                setVideoRequestEcho(null);
                                setGenVideoPanelOpen(true);
                              }}
                            >
                              重新规划
                            </button>
                            <button
                              type="button"
                              disabled={sending}
                              onClick={() => void createGenVideo()}
                            >
                              {sending ? "生成中…" : "确认并生成"}
                            </button>
                          </div>
                        </div>
                      </article>
                    )}
                    {(sending || genVideoPlanning || articlePlanning) && (isThinking || streamingContent) && (
                      <article
                        className="message assistant streaming"
                        // 进行中的流式进度永远压在消息列表最底：高于已出片视频的 order:999，
                        // 这样无论上次有没有视频，本次生成的进度都落在最下方。
                        style={{ order: 1000 }}
                      >
                        {isThinking && !streamingContent ? (
                          <span className="thinking-indicator">
                            <span className="thinking-dots">
                              <span className="thinking-dot" />
                              <span className="thinking-dot" />
                              <span className="thinking-dot" />
                            </span>
                            思考中...
                          </span>
                        ) : (
                          <>
                            <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(streamingContent) }} />
                            <span className="streaming-cursor" />
                          </>
                        )}
                      </article>
                    )}
                    {modelNotice && (
                      <article className={`message assistant model-switch-notice ${modelNotice.status}`}>
                        {modelNotice.status === "running" ? (
                          <span className="thinking-indicator">
                            <span className="thinking-dots">
                              <span className="thinking-dot" />
                              <span className="thinking-dot" />
                              <span className="thinking-dot" />
                            </span>
                            {modelNotice.text}
                          </span>
                        ) : (
                          <span className="model-switch-text">{modelNotice.text}</span>
                        )}
                      </article>
                    )}
                    {!activeConversation && <p className="hint">你可以直接发送你的问题即可</p>}
                  </div>
                  {showScrollBottom && (
                    <button
                      className="scroll-bottom-btn"
                      onClick={() => {
                        const container = messageListRef.current;
                        if (container) {
                          container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
                        }
                      }}
                      aria-label="滚动到底部"
                      title="滚动到底部"
                    >
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                        <path d="M10 4v10m0 0l4-4m-4 4l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                  <form className="chat-input" ref={chatInputBoxRef} onSubmit={sendMessage}>
                    {chatError && (
                      <p className={chatErrorSoft ? "chat-error-inline chat-notice-warn" : "error-text chat-error-inline"}>
                        {chatError}
                      </p>
                    )}
                    {videoTaskProgress && (
                      <div className={`video-task-progress${videoTaskProgress.terminal ? " terminal" : ""}`}>
                        <div className="video-task-progress-head">
                          <span className="video-task-progress-label">
                            {videoTaskProgress.stage === "failed"
                              ? "视频生成失败"
                              : videoTaskProgress.terminal
                                ? "视频已生成"
                                : "视频生成中"}
                          </span>
                          <span className="video-task-progress-percent">{videoTaskProgress.percent}%</span>
                        </div>
                        <div className="video-task-progress-bar">
                          <div
                            className="video-task-progress-fill"
                            style={{ width: `${videoTaskProgress.percent}%` }}
                          />
                        </div>
                        <p className="video-task-progress-message">{videoTaskProgress.message}</p>
                        {videoTaskProgress.videoUrl && (
                          <a className="video-task-progress-link" href={videoTaskProgress.videoUrl} target="_blank" rel="noreferrer">
                            查看成片 →
                          </a>
                        )}
                        {videoTaskProgress.terminal && (
                          <button
                            type="button"
                            className="video-task-progress-dismiss"
                            onClick={() => setVideoTaskProgress(null)}
                          >
                            知道了
                          </button>
                        )}
                      </div>
                    )}
                    {montagePanelOpen && (
                      <div className="viral-remake-panel montage-upload-panel">
                        <div className="viral-remake-title">一键剪视频</div>
                        <p>请选择要剪辑的视频，支持一次选择多段（按选择顺序拼接为一条成片）。上传后会在当前会话中展示完整的分析、字幕、音频、画面和成片制作进度。</p>
                        <label className="viral-remake-file">上传待剪视频（可多选）<input type="file" multiple accept="video/mp4,video/quicktime,video/webm,video/x-m4v" onChange={(event) => setMontageVideoFiles(Array.from(event.target.files ?? []))} /></label>
                        <div className="viral-remake-summary">
                          {montageVideoFiles.length === 0
                            ? "暂未选择视频"
                            : montageVideoFiles.length === 1
                              ? `已选择：${montageVideoFiles[0].name}`
                              : `已选择 ${montageVideoFiles.length} 段视频：${montageVideoFiles.map((file) => file.name).join("、")}`}
                        </div>
                        <div className="viral-remake-actions"><button type="button" onClick={() => setMontagePanelOpen(false)}>取消</button><button type="button" disabled={!montageVideoFiles.length || sending} onClick={() => void createMontageEdit()}>开始剪辑</button></div>
                      </div>
                    )}
                    {remakePanelOpen && (
                      <div className="viral-remake-panel">
                        <div className="viral-remake-title">一键复刻爆款视频</div>
                        <p>填写抖音、小红书、视频号、快手等平台的视频链接，或上传参考视频；再上传用于制作的视频或图片素材。</p>
                        <input value={referenceVideoUrl} onChange={(event) => setReferenceVideoUrl(event.target.value)} placeholder="粘贴参考视频链接或完整平台分享口令" type="text" />
                        <label className="viral-remake-file">上传参考视频（可选）<input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-m4v" onChange={(event) => setReferenceVideoFile(event.target.files?.[0] ?? null)} /></label>
                        <label className="viral-remake-file">上传制作素材（视频或图片，可多选）<input type="file" multiple accept="video/mp4,video/quicktime,video/webm,video/x-m4v,image/jpeg,image/png,image/webp" onChange={(event) => setRemakeMaterials(Array.from(event.target.files ?? []))} /></label>
                        <div className="viral-remake-summary">{referenceVideoFile ? `参考：${referenceVideoFile.name}` : ""}{remakeMaterials.length ? `  素材：${remakeMaterials.length} 个` : ""}</div>
                        <div className="viral-remake-actions"><button type="button" onClick={() => setRemakePanelOpen(false)}>取消</button><button type="button" disabled={sending} onClick={() => void createViralRemake()}>开始制作</button></div>
                      </div>
                    )}
                    {/* 合并后：同一面板顶部用 Tab 二选一（参考图 / 参考文章） */}
                    {genVideoPanelOpen && (
                      <div className="article-source-tabs" role="tablist" style={{ marginBottom: 8 }}>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={videoInputTab === "image"}
                          className={videoInputTab === "image" ? "active" : ""}
                          onClick={() => setVideoInputTab("image")}
                        >
                          参考图
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={videoInputTab === "article"}
                          className={videoInputTab === "article" ? "active" : ""}
                          onClick={() => setVideoInputTab("article")}
                        >
                          参考文章
                        </button>
                      </div>
                    )}
                    {genVideoPanelOpen && videoInputTab === "article" && (
                      <div className="viral-remake-panel article-video-panel">
                        <div className="viral-remake-title">参考文章</div>
                        <p>
                          提交一篇文章（链接 / 文档 / 正文）。系统会先读懂文章、抽取其中的数据并逐条核对出处，
                          再把数据画成柱状图、折线图、数字卡、时间线等画面，规划好解说脚本后请你确认，
                          最后生成带解说与背景乐的竖屏短视频。
                        </p>

                        <div className="article-source-tabs" role="tablist">
                          <button
                            type="button"
                            role="tab"
                            aria-selected={articleSourceType === "url"}
                            className={articleSourceType === "url" ? "active" : ""}
                            onClick={() => setArticleSourceType("url")}
                          >
                            文章链接
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={articleSourceType === "document"}
                            className={articleSourceType === "document" ? "active" : ""}
                            onClick={() => setArticleSourceType("document")}
                          >
                            上传文档
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={articleSourceType === "paste"}
                            className={articleSourceType === "paste" ? "active" : ""}
                            onClick={() => setArticleSourceType("paste")}
                          >
                            粘贴正文
                          </button>
                        </div>

                        {articleSourceType === "url" && (
                          <input
                            value={articleUrl}
                            onChange={(event) => setArticleUrl(event.target.value)}
                            placeholder="粘贴文章链接（http/https）"
                            type="text"
                          />
                        )}
                        {articleSourceType === "document" && (
                          <label className="viral-remake-file">
                            上传文章文档（docx / pdf / txt / md，单个不超过 20MB）
                            <input
                              type="file"
                              accept=".docx,.pdf,.txt,.md,.markdown"
                              onChange={(event) => setArticleFile(event.target.files?.[0] ?? null)}
                            />
                          </label>
                        )}
                        {articleSourceType === "paste" && (
                          <textarea
                            value={articleText}
                            onChange={(event) => setArticleText(event.target.value)}
                            placeholder="把文章正文粘贴到这里（至少 80 字）"
                            style={{
                              minHeight: 140,
                              resize: "vertical",
                              border: "1px solid var(--line)",
                              borderRadius: 7,
                              padding: "8px 10px",
                              fontSize: 12,
                              fontFamily: "inherit",
                              lineHeight: 1.6,
                            }}
                          />
                        )}

                        <div className="viral-remake-summary">
                          {articleSourceType === "url" && (articleUrl.trim() ? `链接：${articleUrl.trim()}` : "暂未填写链接")}
                          {articleSourceType === "document" && (articleFile ? `已选择：${articleFile.name}` : "暂未选择文档")}
                          {articleSourceType === "paste" && (articleText.trim() ? `已输入 ${articleText.trim().length} 字` : "暂未粘贴正文")}
                        </div>

                        <label className="gen-video-engine">
                          <span className="gen-video-engine-label">解说语音引擎</span>
                          <select
                            value={genVideoTtsProvider}
                            onChange={(event) => {
                              const v = event.target.value;
                              setGenVideoTtsProvider(v === "zhipu" ? "zhipu" : v === "edge" ? "edge" : "qwen");
                            }}
                          >
                            <option value="edge">免费合成音（免费）</option>
                            <option value="qwen">千问 TTS</option>
                            <option value="zhipu">智谱 GLM-TTS（中文自然）</option>
                          </select>
                        </label>

                        <label className="gen-video-engine">
                          <span className="gen-video-engine-label">视频风格</span>
                          <select value={genVideoTheme} onChange={(event) => setGenVideoTheme(event.target.value)}>
                            <option value="">自动（按图表配色挑选）</option>
                            <option value="warm-default">温暖治愈</option>
                            <option value="cool-night">冷调夜色</option>
                            <option value="clean-light">明亮清新</option>
                            <option value="film-revive">胶片复古</option>
                            <option value="acid-graphics">酸性设计</option>
                            <option value="glitch-art">故障艺术</option>
                            <option value="collage-zine">拼贴胶带</option>
                            <option value="swiss-grid">瑞士网格</option>
                            <option value="mono-ink">单色水墨</option>
                          </select>
                          <span className="gen-video-engine-hint">
                            图表会用同一套配色绘制，所以这里的风格同时决定画面与图表的颜色。
                          </span>
                        </label>

                        <label className="viral-remake-file" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <input
                            type="checkbox"
                            checked={articleAllowSearch}
                            onChange={(event) => setArticleAllowSearch(event.target.checked)}
                            style={{ width: "auto" }}
                          />
                          数据不够时联网补充（全文最多搜索一次，补充的数据会标注来源链接）
                        </label>

                        {/* 可选参考图：文章模式也能补充画面素材（位于提示词上方） */}
                        <label className="viral-remake-file">
                          参考图（可选，作为画面素材补充）
                          <input
                            type="file"
                            multiple
                            accept="image/jpeg,image/png,image/webp"
                            onChange={(event) => {
                              const picked = Array.from(event.target.files ?? []).map((file) => ({
                                file,
                                url: URL.createObjectURL(file),
                              }));
                              setArticleRefImages((previous) => [...previous, ...picked]);
                              event.target.value = "";
                            }}
                          />
                        </label>
                        {articleRefImages.length > 0 && (
                          <div className="gen-video-thumbs">
                            {articleRefImages.map((item, index) => (
                              <div className="gen-video-thumb" key={item.url}>
                                <img
                                  src={item.url}
                                  alt={item.file.name}
                                  title={item.file.name}
                                  onClick={() => setGenVideoPreviewUrl(item.url)}
                                />
                                <button
                                  type="button"
                                  className="gen-video-thumb-remove"
                                  onClick={() =>
                                    setArticleRefImages((previous) => previous.filter((_, i) => i !== index))
                                  }
                                  aria-label="移除这张参考图"
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                        )}

                        <label className="viral-remake-file" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                          额外创作要求（可选）
                          <textarea
                            value={articleRequirement}
                            onChange={(event) => setArticleRequirement(event.target.value)}
                            placeholder={"例如：时长 40 秒，重点讲增长那部分\n口播偏理性，不要太煽情"}
                            style={{
                              minHeight: 72,
                              resize: "vertical",
                              border: "1px solid var(--line)",
                              borderRadius: 7,
                              padding: "8px 10px",
                              fontSize: 12,
                              fontFamily: "inherit",
                              lineHeight: 1.6,
                            }}
                          />
                        </label>

                        {/* ---- 效果微调：与「一键生成视频」共用同一份 look 状态 ----
                            方案一旦生成就把 look 写进分镜，之后改只能重新规划，所以必须放在生成方案之前。 */}
                        <div className="gen-video-look">
                          <div className="gen-video-look-title">效果微调（可选）</div>
                          <div className="gen-video-look-row">
                            <span className="gen-video-look-label">叠加特效层</span>
                            <div className="gen-video-look-chips">
                              {(genVideoPlan?.options.effects ?? DEFAULT_LOOK_EFFECTS).map((opt) => {
                                const active = genVideoEffects.includes(opt.value);
                                const full = genVideoEffects.length >= 2 && !active;
                                return (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    className={`gen-video-look-chip${active ? " active" : ""}`}
                                    disabled={full}
                                    title={full ? "最多叠加 2 层，多了画面会糊" : opt.label}
                                    aria-pressed={active}
                                    onClick={() =>
                                      setGenVideoEffects((prev) =>
                                        prev.includes(opt.value)
                                          ? prev.filter((v) => v !== opt.value)
                                          : prev.length >= 2
                                            ? [prev[1], opt.value]
                                            : [...prev, opt.value],
                                      )
                                    }
                                  >
                                    {opt.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          <div className="gen-video-look-row">
                            <span className="gen-video-look-label">统一运镜</span>
                            <div className="gen-video-look-chips">
                              {(genVideoPlan?.options.motions ?? DEFAULT_LOOK_MOTIONS).map((opt) => (
                                <button
                                  key={opt.value}
                                  type="button"
                                  className={`gen-video-look-chip${genVideoMotion === opt.value ? " active" : ""}`}
                                  aria-pressed={genVideoMotion === opt.value}
                                  onClick={() => setGenVideoMotion(opt.value)}
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="gen-video-look-row">
                            <span className="gen-video-look-label">字幕样式</span>
                            <div className="gen-video-look-chips">
                              {(genVideoPlan?.options.captions ?? DEFAULT_LOOK_CAPTIONS).map((opt) => (
                                <button
                                  key={opt.value}
                                  type="button"
                                  className={`gen-video-look-chip${genVideoCaptionStyle === opt.value ? " active" : ""}`}
                                  aria-pressed={genVideoCaptionStyle === opt.value}
                                  onClick={() => setGenVideoCaptionStyle(opt.value)}
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>

                        {articlePlanning && (
                          <div className="gen-video-plan-loading">
                            <span className="video-preparing-dot" />
                            <span>
                              正在读懂文章并规划方案：抽取数据 → 核对数据出处 → 按需联网补充 → 绘制图表 →
                              写解说 → 合成配音 → 排分镜，约需 1~2 分钟…
                            </span>
                          </div>
                        )}

                        <div className="viral-remake-actions">
                          <button type="button" onClick={() => setGenVideoPanelOpen(false)} disabled={articlePlanning}>
                            取消
                          </button>
                          <button type="button" disabled={articlePlanning || sending} onClick={() => void planArticleVideo()}>
                            {articlePlanning ? "正在生成方案…" : "生成方案"}
                          </button>
                        </div>
                      </div>
                    )}
                    {videoPreparingTopic && (
                      <div className="video-preparing">
                        <span className="video-preparing-dot" />
                        <span>正在围绕「{videoPreparingTopic}」收集信息、整理短视频创作要求并挑选关联配图，请稍候…</span>
                      </div>
                    )}
                    {genVideoPanelOpen && videoInputTab === "image" && (
                      <div className="viral-remake-panel">
                        <div className="viral-remake-title">一键生成视频（参考图）</div>
                        <p>上传多张参考图，并在下方统一填写整体创作要求。点击开始生成后，系统会自动配文、合成女声配音与字幕，并调用 Remotion 视频技能渲染画面，全程在当前会话中实时展示。</p>
                        <label className="viral-remake-file">上传参考图（可多选）<input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => setGenVideoImages((previous) => [...previous, ...Array.from(event.target.files ?? []).map((file) => ({ file, url: URL.createObjectURL(file) }))])} /></label>
                        <div className="gen-video-thumbs">
                          {genVideoImages.map((item, index) => (
                            <div className="gen-video-thumb" key={item.url}>
                              <img src={item.url} alt={item.file.name} title={item.file.name} onClick={() => setGenVideoPreviewUrl(item.url)} />
                              <button type="button" className="gen-video-thumb-remove" onClick={() => removeGenVideoImage(index)} aria-label="删除这张图">×</button>
                            </div>
                          ))}
                        </div>
                        <div className="viral-remake-summary">{genVideoImages.length === 0 ? "暂未选择参考图（点击缩略图可看大图）" : `已选择 ${genVideoImages.length} 张参考图：点击缩略图看大图，右上角 × 可删除`}</div>
                        <label className="viral-remake-file" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>整体创作要求（多行）<textarea value={genVideoRequirement} onChange={(event) => setGenVideoRequirement(event.target.value)} placeholder={"例如：竖版 1080×1920，时长 30 秒左右，轻松治愈口播风\n第一张图做开场封面，配文案「爸，我又想你了」\n第二张图做正文，强调一个温暖细节\n结尾引导关注 + 品牌落版"} style={{ minHeight: 88, resize: "vertical", border: "1px solid var(--line)", borderRadius: 7, padding: "8px 10px", fontSize: 12, fontFamily: "inherit", lineHeight: 1.6 }} /></label>
                        <label className="gen-video-engine">
                          <span className="gen-video-engine-label">解说语音引擎</span>
                          <select
                            value={genVideoTtsProvider}
                            onChange={(event) => {
                              const v = event.target.value;
                              setGenVideoTtsProvider(v === "zhipu" ? "zhipu" : v === "edge" ? "edge" : "qwen");
                            }}
                          >
                            <option value="edge">免费合成音（免费）</option>
                            <option value="qwen">千问 TTS（英文更好）</option>
                            <option value="zhipu">智谱 GLM-TTS（中文自然）</option>
                          </select>
                          <span className="gen-video-engine-hint">
                            {genVideoTtsProvider === "edge"
                              ? "免费合成音（edge-tts）：不消耗任何云端额度；若不可用自动回退本机语音。"
                              : genVideoTtsProvider === "zhipu"
                                ? "中文解说用智谱更自然；若智谱不可用会自动切到千问。"
                                : "千问 TTS；若不可用会自动切回智谱，保证不断音。"}
                          </span>
                        </label>
                        <label className="gen-video-engine">
                          <span className="gen-video-engine-label">视频风格</span>
                          <select value={genVideoTheme} onChange={(event) => setGenVideoTheme(event.target.value)}>
                            <option value="">自动（按素材色调挑选）</option>
                            <option value="warm-default">温暖治愈</option>
                            <option value="cool-night">冷调夜色</option>
                            <option value="clean-light">明亮清新</option>
                            <option value="film-revive">胶片复古</option>
                            <option value="acid-graphics">酸性设计</option>
                            <option value="glitch-art">故障艺术</option>
                            <option value="collage-zine">拼贴胶带</option>
                            <option value="swiss-grid">瑞士网格</option>
                            <option value="mono-ink">单色水墨</option>
                          </select>
                          <span className="gen-video-engine-hint">
                            {genVideoTheme
                              ? VIDEO_THEME_HINTS[genVideoTheme] ?? ""
                              : "自动模式会先识别参考图的色调与情绪，再挑一套最协调的风格；识别不可用时退回温暖治愈。"}
                          </span>
                        </label>

                        {/* ---- 效果微调：主题之外的加法与覆盖 ----
                            设计取舍：主题定基调，这里只开放三个互不冲突的维度 ——
                            外挂特效层（加法）、统一运镜（覆盖）、字幕样式（ffmpeg 通道）。
                            不开放配色/字体/spring：那三个是主题的定义本身，拆开会让 9 套主题失去意义。 */}
                        <div className="gen-video-look">
                          <div className="gen-video-look-title">效果微调（可选）</div>
                          <div className="gen-video-look-row">
                            <span className="gen-video-look-label">叠加特效层</span>
                            <div className="gen-video-look-chips">
                              {(genVideoPlan?.options.effects ?? DEFAULT_LOOK_EFFECTS).map((opt) => {
                                const active = genVideoEffects.includes(opt.value);
                                const full = genVideoEffects.length >= 2 && !active;
                                return (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    className={`gen-video-look-chip${active ? " active" : ""}`}
                                    disabled={full}
                                    title={full ? "最多叠加 2 层，多了画面会糊" : opt.label}
                                    aria-pressed={active}
                                    onClick={() => setGenVideoEffects((prev) =>
                                      prev.includes(opt.value)
                                        ? prev.filter((v) => v !== opt.value)
                                        : prev.length >= 2
                                          ? [prev[1], opt.value]
                                          : [...prev, opt.value],
                                    )}
                                  >
                                    {opt.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          <div className="gen-video-look-row">
                            <span className="gen-video-look-label">画面运镜</span>
                            <select value={genVideoMotion} onChange={(event) => setGenVideoMotion(event.target.value)}>
                              {(genVideoPlan?.options.motions ?? DEFAULT_LOOK_MOTIONS).map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="gen-video-look-row">
                            <span className="gen-video-look-label">字幕样式</span>
                            <select value={genVideoCaptionStyle} onChange={(event) => setGenVideoCaptionStyle(event.target.value)}>
                              {(genVideoPlan?.options.captions ?? DEFAULT_LOOK_CAPTIONS).map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </div>
                          <span className="gen-video-engine-hint">
                            特效层与主题自带的取并集（如暖色主题也能叠故障感）；运镜选「跟随分镜」则由 AI 逐镜头挑选。
                          </span>
                        </div>

                        {/* ---- 主新闻选择 ----
                            一条视频只讲一条新闻。联网检索（尤其内置热榜）会带回十几条彼此
                            不相干的新闻，早期版本把它们全喂给写稿模型，结果一条视频里讲了好几件事。
                            现在由 prepare 阶段选出主新闻，并在这里让用户核对/改选。 */}
                        {genVideoNewsItems.length > 0 && (
                          <div className="gen-video-news-picker">
                            <div className="gen-video-news-picker-title">
                              这条视频讲哪条新闻
                              <span className="gen-video-news-picker-hint">
                                旁白只会讲选中的这一条，其余仅作背景参考，不会写进文案
                              </span>
                            </div>
                            <div className="gen-video-news-options">
                              {genVideoNewsItems.map((item, i) => {
                                const active = i === genVideoPrimaryIndex;
                                return (
                                  <label key={`${item.title}-${i}`} className={`gen-video-news-option${active ? " active" : ""}`}>
                                    <input
                                      type="radio"
                                      name="genVideoPrimaryNews"
                                      checked={active}
                                      onChange={() => setGenVideoPrimaryIndex(i)}
                                    />
                                    <span className="gen-video-news-option-body">
                                      <span className="gen-video-news-option-title">{item.title}</span>
                                      {item.snippet && !/^来自\s*\S+\s*热榜/.test(item.snippet) && (
                                        <span className="gen-video-news-option-snippet">{item.snippet}</span>
                                      )}
                                    </span>
                                    {active && <span className="gen-video-news-option-badge">主新闻</span>}
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* ---- 方案确认区 ----
                            需求原文：「先理解素材 → 出方案 → 用户选 → 再生成」。
                            改造前这些全藏在 runVideoPipeline 里，点开始就跑，用户全程看不到方案。 */}
                        {genVideoPlanning && (
                          <div className="gen-video-plan-loading">
                            <span className="video-preparing-dot" />
                            <span>
                              正在理解素材并规划方案：识别图片内容 → 挑选风格 → 写旁白 → 合成配音 → DeepSeek 排分镜，约需 1~2 分钟…
                            </span>
                          </div>
                        )}

                        {genVideoPlan && (
                          <div className="gen-video-plan">
                            <div className="gen-video-plan-head">
                              <strong>AI 视频方案</strong>
                              <span className="gen-video-plan-meta">
                                {genVideoPlan.summary.scenes.length} 个镜头 · 约 {genVideoPlan.summary.durationSeconds.toFixed(1)} 秒
                                {genVideoPlan.audioSeconds > 0 ? ` · 配音 ${genVideoPlan.audioSeconds.toFixed(1)} 秒` : " · 无配音"}
                              </span>
                            </div>

                            {genVideoPlan.title && (
                              <div className="gen-video-plan-row">
                                <span className="gen-video-plan-key">标题</span>
                                <span className="gen-video-plan-val">{genVideoPlan.title}</span>
                              </div>
                            )}

                            <div className="gen-video-plan-row">
                              <span className="gen-video-plan-key">建议风格</span>
                              <span className="gen-video-plan-val">
                                {genVideoPlan.summary.themeLabel}
                                <span className="gen-video-plan-note">{genVideoPlan.themeReason}</span>
                              </span>
                            </div>

                            {(genVideoPlan.newsItems?.length ?? 0) > 0 && (
                              <div className="gen-video-plan-block">
                                <div className="gen-video-plan-key">文案依据的新闻</div>
                                <div className="gen-video-news-list">
                                  {genVideoPlan.newsItems.map((item, i) => (
                                    <div key={i} className="gen-video-news-item">
                                      <span className="gen-video-news-no">{i + 1}</span>
                                      <span className="gen-video-news-body">
                                        <span className="gen-video-news-title">{item.title}</span>
                                        {item.snippet && !/^来自\s*\S+\s*热榜/.test(item.snippet) && (
                                          <span className="gen-video-news-snippet">{item.snippet}</span>
                                        )}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                                <span className="gen-video-engine-hint">
                                  旁白围绕上面这些新闻事实撰写，并要求不编造未出现的人物、数字与结论。
                                </span>
                              </div>
                            )}

                            {(genVideoPlan.insights?.length ?? 0) > 0 && (
                              <div className="gen-video-plan-block">
                                <div className="gen-video-plan-key">AI 理解到的素材</div>
                                <div className="gen-video-insight-list">
                                  {genVideoPlan.insights.map((item) => (
                                    <div key={item.index} className="gen-video-insight">
                                      <span className="gen-video-insight-no">{item.index}</span>
                                      {item.dominantColor && (
                                        <span className="gen-video-insight-swatch" style={{ background: item.dominantColor }} aria-hidden="true" />
                                      )}
                                      <span className="gen-video-insight-text">
                                        {item.caption}
                                        {item.mood && <em>·{item.mood}</em>}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {genVideoPlan.article && (
                              <div className="gen-video-plan-block">
                                <div className="gen-video-plan-key">
                                  文章转视频
                                  <span className="article-source-badge">
                                    {genVideoPlan.article.sourceType === "url"
                                      ? "链接"
                                      : genVideoPlan.article.sourceType === "document"
                                        ? "文档"
                                        : "粘贴"}
                                    · {genVideoPlan.article.sourceLabel}
                                  </span>
                                  {genVideoPlan.article.sourceUrl && (
                                    <a
                                      className="article-source-link"
                                      href={genVideoPlan.article.sourceUrl}
                                      target="_blank"
                                      rel="noreferrer noopener"
                                    >
                                      查看原文
                                    </a>
                                  )}
                                </div>

                                {genVideoPlan.article.summary && (
                                  <p className="article-plan-summary">{genVideoPlan.article.summary}</p>
                                )}

                                {(genVideoPlan.article.keyPoints?.length ?? 0) > 0 && (
                                  <div className="article-key-points">
                                    {genVideoPlan.article.keyPoints.map((point, index) => (
                                      <div key={index} className="article-key-point">
                                        <span>{index + 1}</span>
                                        {point}
                                      </div>
                                    ))}
                                  </div>
                                )}

                                <div className="gen-video-plan-key" style={{ marginTop: 10 }}>
                                  图表清单（{genVideoPlan.article.charts?.length ?? 0} 张）
                                </div>
                                {(genVideoPlan.article.charts?.length ?? 0) === 0 ? (
                                  <p className="article-notice">
                                    文章里没有可用的数据，本次不生成图表，画面以字幕与原文配图为主。
                                  </p>
                                ) : (
                                  <div className="article-chart-list">
                                    {genVideoPlan.article.charts.map((chart, index) => (
                                      <div key={chart.id} className="article-chart-item">
                                        <img
                                          className="article-chart-thumb"
                                          src={chart.webPath}
                                          alt={`${chart.kindLabel}：${chart.title}`}
                                          onClick={() => setGenVideoPreviewUrl(chart.webPath)}
                                        />
                                        <div className="article-chart-body">
                                          <div className="article-chart-head">
                                            <span className="article-chart-index">{index + 1}</span>
                                            <span className="article-chart-kind">{chart.kindLabel}</span>
                                            <strong>{chart.title}</strong>
                                          </div>
                                          {chart.dataSummary && (
                                            <div className="article-chart-data">{chart.dataSummary}</div>
                                          )}
                                          <div
                                            className={`article-chart-verify${chart.downgraded ? " warn" : chart.verified ? " ok" : ""}`}
                                          >
                                            {chart.downgraded
                                              ? `数据无法溯源，已降级为不含数值的图卡${chart.downgradeReason ? `（${chart.downgradeReason}）` : ""}`
                                              : chart.verified
                                                ? "画面上的每个数字都已在原文里核对过"
                                                : "这张图不含具体数值"}
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {(genVideoPlan.article.notices?.length ?? 0) > 0 && (
                                  <div className="article-notice-list">
                                    {genVideoPlan.article.notices.map((notice, index) => (
                                      <p key={index} className="article-notice">
                                        {notice}
                                      </p>
                                    ))}
                                  </div>
                                )}

                                <span className="gen-video-engine-hint">
                                  图表会作为画面素材进入分镜。带数值的图表都经过「原文逐字核对」这道程序闸门，
                                  对不上的数字不会出现在画面上。
                                </span>
                              </div>
                            )}

                            <div className="gen-video-plan-block">
                              <div className="gen-video-plan-key">镜头安排</div>
                              <div className="gen-video-scene-list">
                                {genVideoPlan.summary.scenes.map((scene, i) => (
                                  <div key={scene.id} className="gen-video-scene">
                                    <span className="gen-video-scene-no">{i + 1}</span>
                                    <span className="gen-video-scene-time">{scene.startSeconds.toFixed(1)}–{scene.outSeconds.toFixed(1)}s</span>
                                    <span className="gen-video-scene-body">
                                      {scene.imageIndexes.length > 0 && (
                                        <span className="gen-video-scene-imgs">图 {scene.imageIndexes.join("、")}</span>
                                      )}
                                      <span className="gen-video-scene-motion">{scene.motion}</span>
                                      {scene.overlays.filter((o) => o.text).map((o, k) => (
                                        <span key={k} className="gen-video-scene-overlay">{o.text}</span>
                                      ))}
                                      {scene.imageNotes.length > 0 && (
                                        <span className="gen-video-scene-note">{scene.imageNotes.join("；")}</span>
                                      )}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>

                            {genVideoPlan.narration && (
                              <details className="gen-video-plan-narration" open>
                                <summary>旁白文案（{genVideoPlan.summary.beatCount} 句）</summary>
                                <p>{genVideoPlan.narration}</p>
                              </details>
                            )}

                            <div className="gen-video-plan-warnings">
                              {/* 版本自检：DSH 换了版本时必须主动说，否则受限 profile
                                  的插件 id 可能已对不上而静默失效。 */}
                              {genVideoPlan.diagnostics.dshVersionNote && (
                                <span className="gen-video-plan-warn">
                                  {genVideoPlan.diagnostics.dshVersionNote}
                                  {genVideoPlan.diagnostics.dshVersion
                                    ? `（当前：${genVideoPlan.diagnostics.dshVersion}）`
                                    : ""}
                                </span>
                              )}
                              {genVideoPlan.summary.fallback && (
                                <span className="gen-video-plan-warn">
                                  DeepSeek 分镜不可用，这份方案用的是固定节奏兜底（不影响出片）。
                                </span>
                              )}
                              {genVideoPlan.diagnostics.visionTotal > 0 && genVideoPlan.diagnostics.visionRecognized === 0 && (
                                <span className="gen-video-plan-warn">
                                  未配置识图模型，AI 没能理解素材内容，方案仅按图片顺序安排。
                                </span>
                              )}
                            </div>
                          </div>
                        )}

                        <div className="viral-remake-actions">
                          <button type="button" onClick={() => { setGenVideoPanelOpen(false); setGenVideoPreviewUrl(null); setGenVideoPlan(null); }}>取消</button>
                          {!genVideoPlan ? (
                            <button
                              type="button"
                              disabled={!genVideoImages.length || genVideoPlanning || sending}
                              onClick={() => void planGenVideo()}
                            >
                              {genVideoPlanning ? "正在生成方案…" : "生成方案"}
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={genVideoPlanning || sending}
                                onClick={() => { setGenVideoPlan(null); setGenVideoEffects([]); }}
                                title="丢弃当前方案，回到上传素材重新开始"
                              >
                                重新规划
                              </button>
                              <button type="button" disabled={sending} onClick={() => void createGenVideo()}>
                                {sending ? "生成中…" : "确认并生成"}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                    {genVideoPreviewUrl && (
                      <div className="gen-video-lightbox" onClick={() => setGenVideoPreviewUrl(null)}>
                        <img src={genVideoPreviewUrl} alt="参考图预览" onClick={(event) => event.stopPropagation()} />
                        <button type="button" className="gen-video-lightbox-close" onClick={() => setGenVideoPreviewUrl(null)} aria-label="关闭预览">×</button>
                      </div>
                    )}
                    <div className="chat-input-topbar">
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => void sendChatContent("今日产品热点")}>今日产品热点</button>
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => void sendChatContent("今日全网热点")}>今日全网热点</button>
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => setRewriteUrlModal(true)}>一键仿写爆款</button>
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => void sendChatContent("一键生成视频")}>一键生成视频</button>
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => void sendChatContent("一键剪视频")}>一键剪视频</button>
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => void sendChatContent("一键复刻爆款视频")}>一键复刻爆款视频</button>
                    </div>
                    <div className="chat-input-wrap">
                      <textarea
                        ref={chatInputRef}
                        value={chatInput}
                        onChange={(event) => {
                          const el = event.target;
                          setChatInput(el.value);
                          // 随内容自动增高（上限由 CSS 的 max-height 兜底）
                          el.style.height = "auto";
                          el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }
                        }}
                        placeholder={switchingModel ? "正在切换模型，请稍候…" : "你可以直接发送你的问题即可（Enter 发送，Shift+Enter 换行）"}
                        disabled={switchingModel}
                      />
                      <div className="chat-input-actions">
                        <ModelPicker
                          models={modelOptions}
                          current={currentModel}
                          switching={switchingModel}
                          busy={sending}
                          onSwitch={handleSwitchModel}
                          onGoToSettings={() => selectSection("settings")}
                          onRefresh={loadModels}
                          refreshing={modelsLoading}
                          errorText={modelsError}
                        />
                        {sending ? (
                          <button type="button" className="stop-button" onClick={stopGeneration}>停止</button>
                        ) : (
                          <button type="submit" disabled={!chatInput.trim() || switchingModel}>发送</button>
                        )}
                      </div>
                    </div>
                  </form>
                </div>

                {userMessages.length > 0 && (
                  <aside className={`turn-toc ${tocCollapsed ? "collapsed" : ""}`}>
                    <div className="turn-toc-head">
                      {!tocCollapsed && <span className="turn-toc-title">对话目录</span>}
                      <button
                        className="turn-toc-toggle"
                        onClick={() => setTocCollapsed((v) => !v)}
                        aria-label={tocCollapsed ? "展开目录" : "收起目录"}
                        title={tocCollapsed ? "展开目录" : "收起目录"}
                      >
                        {tocCollapsed ? "◀" : "▶"}
                      </button>
                    </div>
                    {!tocCollapsed && (
                      <nav className="turn-toc-list">
                        {userMessages.map((msg, idx) => {
                          const raw = msg.content.replace(/\n/g, " ").trim();
                          const title = raw.length > 28 ? `${raw.slice(0, 28)}…` : raw;
                          return (
                            <button
                              key={msg.id}
                              className={`turn-toc-item ${activeTurnIndex === idx ? "active" : ""}`}
                              onClick={() => scrollToMessage(msg.id)}
                              title={raw}
                            >
                              <span className="turn-toc-num">{idx + 1}</span>
                              <span className="turn-toc-text">{title}</span>
                            </button>
                          );
                        })}
                      </nav>
                    )}
                  </aside>
                )}
              </div>
            </section>
          </div>
        )}

        {section === "library" && (
          activeContent ? (
            <section className={`content-detail${activeContent.videoUrl ? " content-detail--video" : ""}`}>
              <button className="back-to-library-btn" onClick={exitContentDetail} title="返回内容库列表">
                <span className="back-to-library-icon" aria-hidden="true">←</span>
                返回内容库
              </button>
              <button className="back-to-library-float" onClick={exitContentDetail} title="返回内容库列表">
                <span aria-hidden="true">←</span> 返回
              </button>
              <div className="detail-title-row">
                {editingContent === "title" ? (
                  <input
                    className="title-edit-input"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (!contentSaving) saveContentEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEditContent();
                      }
                    }}
                    onBlur={() => {
                      if (!contentSaving) saveContentEdit();
                    }}
                    autoFocus
                  />
                ) : (
                  <h1>{activeContent.title}</h1>
                )}
                <div className="detail-title-actions">
                  <button
                    className={copiedButton === "title" ? "copied-button" : ""}
                    onClick={() => copyText(activeContent.title, "title")}
                  >
                    {copiedButton === "title" ? "已复制" : "复制"}
                  </button>
                  <button
                    className="publish-site-button"
                    disabled={publishingContent}
                    onClick={() => void publishToSite()}
                    title="发布到官网好物推荐板块（hgwx.aimemory.cafe）"
                  >
                    {publishingContent ? "发布中..." : "发布官网"}
                  </button>
                  <button
                    className="publish-site-button publish-healing-button"
                    disabled={publishingHealing}
                    onClick={() => void publishToHealing()}
                    title="推送到 AI回忆录官网「心灵驿站」频道（aimemory.cafe/healing.html），需先在「平台授权管理」配置官网 + 心灵驿站令牌"
                  >
                    {publishingHealing ? "推送中..." : "推送心灵驿站"}
                  </button>
                  <button
                    className="publish-site-button publish-frontier-button"
                    disabled={publishingFrontier}
                    onClick={() => void publishToFrontier()}
                    title="推送到 AI员工官网「AI最前沿」频道（aiworker.aimemory.cafe/frontier.html），需先在「平台授权管理」配置官网-AI员工（域名 + API Key）"
                  >
                    {publishingFrontier ? "推送中..." : "推送 AI最前沿"}
                  </button>
                  {editingContent === "title" ? (
                    <button onClick={saveContentEdit} disabled={contentSaving}>{contentSaving ? "保存中..." : "保存"}</button>
                  ) : (
                    <button onClick={() => startEditContent("title")}>编辑</button>
                  )}
                </div>
              </div>
              <span>{formatDate(activeContent.createdAt)}</span>

              {activeContent.videoUrl ? (
                /* 视频内容：居中放大展示 */
                <div className="detail-video-block">
                  <video controls src={activeContent.videoUrl} className="detail-video-player" />
                </div>
              ) : (
                <>
              <div className="detail-image-block">
                {(() => {
                  const masterImages = parseInlineImages(activeContent.inlineImagesJson);
                  if (masterImages.length > 0) {
                    return (
                      <>
                        <div className="detail-image-head">
                          <span className="detail-image-label">主图</span>
                          <button className="dl-all-btn" onClick={() => void downloadAllImages(activeContent.id)}>
                            ⬇ 一键下载全部图片（zip）
                          </button>
                        </div>
                        <div className="master-grid">
                          {masterImages.map((img, i) => (
                            <div className="master-cell" key={`${activeContent.id}-${i}`}>
                              <img className="master-img" src={img} alt={`主图${i + 1}`} loading="lazy" onClick={() => setLightboxIndex(i)} />
                              <div className="master-acts">
                                <button onClick={() => void copyImage(activeContent.id, `master-${i}`, img)}>复制</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    );
                  }
                  return (
                    <>
                      <span className="detail-image-label">主图</span>
                      <img
                        className="detail-cover"
                        src={activeContent.coverImageUrl ?? fallbackImages[0]}
                        alt="内容配图"
                        onClick={() => { if (activeContent.coverImageUrl) setLightboxIndex(0); }}
                      />
                      <div className="detail-image-actions">
                        <button
                          className={copiedButton === "image" ? "copied-button" : ""}
                          onClick={() => copyImage(activeContent.id, "image", activeContent.coverImageUrl)}
                        >
                          {copiedButton === "image" ? "已复制" : "复制"}
                        </button>
                        <button
                          className="regen-image-button"
                          disabled={regeneratingImage === "cover-0"}
                          onClick={() => regenerateImage("cover", 0)}
                        >
                          {regeneratingImage === "cover-0" ? "生成中..." : "重新生成"}
                        </button>
                      </div>
                      {regeneratingImage === "cover-0" && (
                        <p className="detail-image-progress">正在生成新图，完成后自动替换...</p>
                      )}
                    </>
                  );
                })()}
              </div>

              <div className="detail-body-row">
                <h2>正文</h2>
                <div className="detail-body-actions">
                  {editingContent === "body" ? (
                    <>
                      <button onClick={saveContentEdit} disabled={contentSaving}>{contentSaving ? "保存中..." : "保存"}</button>
                      <button className="ghost-button" onClick={cancelEditContent}>取消</button>
                    </>
                  ) : (
                    <>
                      <button
                        className={copiedButton === "body" ? "copied-button" : ""}
                        onClick={() => copyText(toPlainTextForPublish(activeContent.body), "body")}
                      >
                        {copiedButton === "body" ? "已复制" : "复制"}
                      </button>
                      <button onClick={() => startEditContent("body")}>编辑</button>
                    </>
                  )}
                </div>
              </div>
              {editingContent === "body" ? (
                <textarea
                  className="content-edit-area"
                  value={editingBody}
                  onChange={(event) => setEditingBody(event.target.value)}
                />
              ) : (
                <article className="article-body markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(activeContent.body) }} />
              )}
                </>
              )}
              {copyHint && <p className="copy-toast" role="status">{copyHint}</p>}
            </section>
          ) : (
            <section className="library-scroll" ref={libraryScrollRef}>
              <div className="library-filters" role="group" aria-label="按内容类型筛选">
                {contentFilterOptions.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className={`library-filter-chip${contentFilter === option.key ? " active" : ""}`}
                    onClick={() => setContentFilter(option.key)}
                    title={`只看${option.label}（${contentFilterCounts[option.key]} 条）`}
                    aria-pressed={contentFilter === option.key}
                  >
                    {option.key !== "all" && <span className={`filter-dot dot-${option.key}`} aria-hidden="true" />}
                    {option.label}
                    <span className="library-filter-count">{contentFilterCounts[option.key]}</span>
                  </button>
                ))}
              </div>
              <div className="library-grid">
                {visibleContentItems.map((item, index) => {
                  const kindMeta = contentKindMeta(item);
                  return (
                  <article
                    key={item.id}
                    className="content-card"
                    onClick={() => setActiveContent(item)}
                  >
                    <img src={item.coverImageUrl ?? fallbackImages[index % fallbackImages.length]} alt="内容封面" loading="lazy" />
                    <div className="content-card-head">
                      <span className={`category-tag ${kindMeta.tagClass}`}>{kindMeta.label}</span>
                      <span className="content-date">{formatDate(item.createdAt)}</span>
                    </div>
                    <h3>{item.title}</h3>
                    <p className="content-preview">{item.videoUrl ? "▶ 视频作品" : (item.body.replace(/[*#`>_~]/g, "").trim().slice(0, 20) || "暂无预览")}{!item.videoUrl && item.body.length > 20 ? "..." : ""}</p>
                  </article>
                  );
                })}
              </div>
              {visibleContentCount < filteredContentItems.length && (
                <div className="library-load-more" ref={librarySentinelRef} aria-hidden="true">
                  <span className="library-loading-dot" />
                  向下滚动加载更多
                </div>
              )}
              {!!filteredContentItems.length && visibleContentCount >= filteredContentItems.length && (
                <p className="library-end">已经到底啦 · 共 {filteredContentItems.length} 条内容</p>
              )}
              {!contentItems.length && <p className="hint">暂无生成内容。先在对话里让 AI 员工生成一篇图文。</p>}
              {!!contentItems.length && !filteredContentItems.length && (
                <p className="hint">该类型下还没有内容，换个标签看看。</p>
              )}
            </section>
          )
        )}

        {section === "knowledge" && <KnowledgePanel resetToken={knowledgeResetToken} />}
        {section === "publish" && <PublishPanel resetToken={publishResetToken} />}
        {section === "analytics" && <AnalyticsPanel resetToken={analyticsResetToken} />}
        {section === "accounts" && <AccountsPanel resetToken={accountsResetToken} />}
        {section === "settings" && <SettingsPanel resetToken={settingsResetToken} />}

        {prototypeSections.includes(section) && (
          <div className="prototype-frame">
            <iframe key={section} src={`/prototype/platform#embed=${section}`} title={sectionTitles[section]} />
          </div>
        )}

        {section === "profile" && (
          <section className="profile-grid">
            <article className="profile-card">
              <h3>账号信息</h3>
              <div className="profile-identity">
                <span className="profile-avatar" aria-hidden="true">{(user.phone || "AI").slice(-2)}</span>
                <div className="profile-identity-text">
                  <strong>{user.phone}</strong>
                  <span className="profile-sub">创星云 AI 数字员工平台</span>
                </div>
              </div>
              <dl className="profile-rows">
                <div className="profile-row"><dt>手机号</dt><dd>{user.phone}</dd></div>
                <div className="profile-row">
                  <dt>微信通道</dt>
                  <dd className={wechatBinding?.status === "BOUND" ? "state-on" : "state-off"}>
                    {wechatBinding?.status === "BOUND" ? "已绑定" : "未绑定"}
                  </dd>
                </div>
              </dl>
            </article>

            <article className="profile-card">
              <h3>账号安全</h3>
              <div className="profile-action">
                <div className="profile-action-text">
                  <strong>登录密码</strong>
                  <span className="hint">修改后，下次登录请使用新密码。</span>
                </div>
                <button className="profile-btn" onClick={openPasswordModal}>修改密码</button>
              </div>
              <div className="profile-action">
                <div className="profile-action-text">
                  <strong>退出登录</strong>
                  <span className="hint">退出后需要重新输入手机号和密码。</span>
                </div>
                <button className="profile-btn danger" onClick={() => { void logout(); }}>退出登录</button>
              </div>
              {profileHint && <p className="hint">{profileHint}</p>}
            </article>

            <article className="profile-card wide">
              <div className="profile-card-head">
                <h3>微信通道</h3>
                {wechatBinding?.status === "BOUND" && (
                  confirmingUnbind ? (
                    <button
                      className="profile-btn danger"
                      disabled={profileUnbinding}
                      onClick={() => { void unbindWechat(); }}
                    >
                      {profileUnbinding ? "解除中…" : "确认解除？"}
                    </button>
                  ) : (
                    <button
                      className="profile-btn danger"
                      onClick={() => {
                        setConfirmingUnbind(true);
                        window.setTimeout(() => setConfirmingUnbind(false), 4000);
                      }}
                    >
                      解除绑定
                    </button>
                  )
                )}
              </div>
              {wechatBinding?.status === "BOUND" ? (
                <div className="profile-wechat-body">
                  <div className="profile-wechat-info">
                    <div className="profile-wechat-head">
                      <span className="profile-status-dot" aria-hidden="true" />
                      <strong>已绑定：{wechatBinding.wechatNickname ?? "AI 员工指挥官"}</strong>
                    </div>
                    <dl className="profile-rows">
                      <div className="profile-row"><dt>微信号</dt><dd>{wechatBinding.wechatNo ?? wechatBinding.wechatOpenId ?? "OpenClaw 微信通道"}</dd></div>
                      <div className="profile-row"><dt>绑定时间</dt><dd>{formatDate(wechatBinding.boundAt)}</dd></div>
                    </dl>
                  </div>
                  <div className="profile-wechat-usage">
                    <p className="hint">绑定后，在微信里直接发消息就能调遣 AI 员工，例如：</p>
                    <div className="profile-prompt-chips">
                      <span>帮我推荐明天公众号选题</span>
                      <span>生成一篇小红书探店图文</span>
                      <span>把这段内容改成更适合朋友圈的口吻</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="profile-bind-empty">
                  <p className="hint">绑定后可随时随地在微信里调遣 AI 员工。</p>
                  {profileQr || profileQrLoading ? (
                    renderQr(profileQr, profileQrLoading)
                  ) : (
                    <button className="profile-btn" onClick={() => { void ensureProfileQr(); }}>{profileError ? "重新生成二维码" : "立即绑定"}</button>
                  )}
                  {profileQr && <button className="profile-btn" onClick={() => { void checkProfileBinding(); }}>检查绑定状态</button>}
                </div>
              )}
              {profileError && <p className="error-text">{profileError}</p>}
            </article>
          </section>
        )}
      </section>
      {toast && (
        <div className="toast">
          <span>{toast.message}</span>
          {toast.linkLabel && toast.linkSection && (
            <button className="toast-link" onClick={() => { setSection(toast.linkSection!); setToast(null); }}>
              {toast.linkLabel}
            </button>
          )}
        </div>
      )}
      {showPasswordModal && (
        <div className="humanizer-modal-overlay" onClick={(event) => { if (event.target === event.currentTarget) closePasswordModal(); }}>
          <div className="humanizer-modal password-modal">
            <div className="humanizer-modal-head">
              <h3>修改密码</h3>
              <div className="humanizer-modal-actions">
                <button onClick={closePasswordModal}>取消</button>
              </div>
            </div>
            <div className="humanizer-modal-body">
              <form onSubmit={changePassword} className="auth-form">
                <label>旧密码
                  <input type="password" placeholder="请输入旧密码" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} />
                </label>
                <label>新密码
                  <input type="password" placeholder="请输入新密码" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
                </label>
                <button type="submit">保存</button>
              </form>
              <p className="hint">{profileHint || "密码修改后，下次登录请使用新密码。"}</p>
            </div>
          </div>
        </div>
      )}
      {rewriteUrlModal && (
        <div className="humanizer-modal-overlay" onClick={(event) => { if (event.target === event.currentTarget) setRewriteUrlModal(false); }}>
          <div className="humanizer-modal password-modal">
            <div className="humanizer-modal-head">
              <h3>一键仿写爆款</h3>
              <div className="humanizer-modal-actions">
                <button onClick={() => setRewriteUrlModal(false)}>取消</button>
              </div>
            </div>
            <div className="humanizer-modal-body">
              <p>粘贴要仿写的爆款内容链接（小红书 / 公众号 / 抖音等），确认后系统会先拆解该爆款结构，再结合你的产品知识与账号定位仿写一篇全新内容并自动保存到内容库。</p>
              <label className="rewrite-url-label">爆款链接
                <textarea
                  className="rewrite-url-input"
                  rows={4}
                  placeholder="可粘贴整段平台分享文案，系统会自动提取其中的链接（小红书 / 抖音 / 公众号等）"
                  value={rewriteUrl}
                  onChange={(event) => setRewriteUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !sending) {
                      event.preventDefault();
                      void confirmRewrite();
                    }
                  }}
                  autoFocus
                />
              </label>
              <div className="humanizer-modal-actions rewrite-actions">
                <button onClick={() => setRewriteUrlModal(false)}>取消</button>
                <button type="button" className="primary" disabled={!rewriteUrl.trim() || sending} onClick={() => void confirmRewrite()}>确认仿写</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {lightboxIndex !== null && detailLightboxImages[lightboxIndex] && (
        <div
          className="lightbox-overlay"
          onClick={(event) => { if (event.target === event.currentTarget) setLightboxIndex(null); }}
        >
          {detailLightboxImages.length > 1 && (
            <>
              <button
                type="button"
                className="lightbox-nav lightbox-prev"
                title="上一张（←）"
                onClick={() => setLightboxIndex((current) => (current === null ? null : (current - 1 + detailLightboxImages.length) % detailLightboxImages.length))}
              >‹</button>
              <button
                type="button"
                className="lightbox-nav lightbox-next"
                title="下一张（→）"
                onClick={() => setLightboxIndex((current) => (current === null ? null : (current + 1) % detailLightboxImages.length))}
              >›</button>
            </>
          )}
          <button type="button" className="lightbox-close" title="关闭（Esc）" onClick={() => setLightboxIndex(null)}>×</button>
          <img
            className="lightbox-img"
            src={detailLightboxImages[lightboxIndex]}
            alt={`大图 ${lightboxIndex + 1} / ${detailLightboxImages.length}`}
          />
          {detailLightboxImages.length > 1 && (
            <div className="lightbox-counter">{lightboxIndex + 1} / {detailLightboxImages.length}</div>
          )}
        </div>
      )}
    </main>
  );
}
