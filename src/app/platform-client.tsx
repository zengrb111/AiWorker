"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "@/lib/markdown";
import { escapeHtml, escapeAttr } from "@/lib/escape";
import KnowledgePanel from "./knowledge-panel";
import PublishPanel from "./publish-panel";
import AnalyticsPanel from "./analytics-panel";
import AccountsPanel from "./accounts-panel";
import ModelPicker, { type ModelOption, type CurrentModel } from "./model-picker";

type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * 把 SSE 里的 error 事件包成带 soft 标记的 Error。
 * soft=true 表示「只是本端等待超时」——网关侧的任务仍在后台继续执行，
 * 不该按失败渲染，否则用户会误以为任务挂了而重复发送。
 */
function streamError(message: string, soft: boolean): Error & { soft?: boolean } {
  const err = new Error(message) as Error & { soft?: boolean };
  err.soft = soft;
  return err;
}

function isSoftError(error: unknown): boolean {
  return (error as { soft?: boolean } | null)?.soft === true;
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

/** 尚未落地实现、以静态原型（iframe）方式引入平台的分区 */
const prototypeSections: Section[] = ["settings", "users"];
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

/** 内容库类型筛选项：全部 / 小红书 / 公众号 / 视频 / 其他。 */
type ContentKind = "xhs" | "wechat" | "video" | "other";
type ContentFilterKey = "all" | ContentKind;
const contentFilterOptions: Array<{ key: ContentFilterKey; label: string }> = [
  { key: "all", label: "全部" },
  { key: "xhs", label: "小红书" },
  { key: "wechat", label: "公众号" },
  { key: "video", label: "视频" },
  { key: "other", label: "其他" }
];

/** 把一条内容归到某一类型：有视频优先算视频，再看 category 文案。 */
function contentKindOf(item: ContentItem): ContentKind {
  if (item.videoUrl || item.category === "视频") return "video";
  const category = item.category ?? "";
  if (category.includes("小红书")) return "xhs";
  if (category.includes("公众号") || category.includes("微信")) return "wechat";
  return "other";
}

/** 卡片角标文案与配色，和筛选项保持一致 */
function contentKindMeta(item: ContentItem): { label: string; tagClass: string } {
  switch (contentKindOf(item)) {
    case "xhs":
      return { label: item.category || "小红书", tagClass: "tag-xhs" };
    case "wechat":
      return { label: item.category || "公众号文章", tagClass: "tag-wechat" };
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
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatError, setChatError] = useState("");
  const [chatErrorSoft, setChatErrorSoft] = useState(false);
  const [sending, setSending] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [toast, setToast] = useState<{ message: string; linkLabel?: string; linkSection?: Section } | null>(null);
  const [lastSavedContent, setLastSavedContent] = useState<ContentItem | null>(null);
  const [humanizingMessageId, setHumanizingMessageId] = useState<string | null>(null);
  const [lastVideoUrl, setLastVideoUrl] = useState<string | null>(null);
  const [montagePanelOpen, setMontagePanelOpen] = useState(false);
  const [montageVideoFile, setMontageVideoFile] = useState<File | null>(null);
  const [remakePanelOpen, setRemakePanelOpen] = useState(false);
  const [referenceVideoUrl, setReferenceVideoUrl] = useState("");
  const [referenceVideoFile, setReferenceVideoFile] = useState<File | null>(null);
  const [remakeMaterials, setRemakeMaterials] = useState<File[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
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
  const [switchingModel, setSwitchingModel] = useState(false);
  const [modelNotice, setModelNotice] = useState<{ text: string; status: "running" | "done" | "error" } | null>(null);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [profileHint, setProfileHint] = useState("");
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [rewriteUrlModal, setRewriteUrlModal] = useState(false);
  const [rewriteUrl, setRewriteUrl] = useState("");

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0],
    [activeConversationId, conversations]
  );

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
    if (!activeConversationId && data.conversations[0]) setActiveConversationId(data.conversations[0].id);
  }

  async function refreshContent() {
    const data = await api<{ contentItems: ContentItem[] }>("/api/content");
    setContentItems(data.contentItems);
    return data.contentItems;
  }

  useEffect(() => {
    void refreshMe();
  }, []);

  /** 拉取网关模型列表与当前会话实际使用的模型。 */
  async function loadModels() {
    try {
      const data = await api<{ current: CurrentModel; models: ModelOption[] }>("/api/models", undefined, 30000);
      setModelOptions(data.models);
      setCurrentModel(data.current);
    } catch (error) {
      // 模型信息拿不到不影响主流程，静默处理
      console.warn("[models] 加载模型列表失败：", error);
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
   * 切换模型：切换期间锁定输入框，并在对话流里展示切换过程
   * （切换只是改会话配置，不会触发一次模型调用）。
   */
  async function handleSwitchModel(modelId: string, label: string) {
    if (switchingModel || sending) return;
    setSwitchingModel(true);
    setModelNotice({ text: `正在切换到 ${label}…`, status: "running" });
    try {
      const data = await api<{ current: CurrentModel }>(
        "/api/models/switch",
        { method: "POST", body: JSON.stringify({ model: modelId }) },
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
      // 模型列表可能因为新接入的供应商而变化，顺手刷新一次
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
    if (user) {
      void refreshConversations();
      void refreshContent();
    }
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
  }, [streamingContent, isThinking, sending, activeConversation?.messages.length]);

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

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendChatContent(chatInput);
  }

  async function sendChatContent(content: string, url?: string) {
    if (!content.trim() || sending) return;

    if (hotTopicPrompts.includes(content.trim())) {
      setMontagePanelOpen(false);
      setMontageVideoFile(null);
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
            if (content === "一键复刻爆款视频") {
              setRemakePanelOpen(true);
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
    const file = montageVideoFile;
    const conversationId = activeConversation?.id;
    if (!file || !conversationId || sending) return;

    setSending(true);
    setIsThinking(true);
    setChatError("");
    setStreamingContent("");
    setMontagePanelOpen(false);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const form = new FormData();
      form.append("video", file);
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
            setMontageVideoFile(null);
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
                        <article key={message.id} id={`message-${message.id}`} className={`message ${message.role === "USER" ? "user" : "assistant"}`}>
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
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {messageVideoUrl && (
                                <div className="video-player-wrap">
                                  <video controls src={messageVideoUrl} className="inline-video-player" />
                                </div>
                              )}
                            </>
                          ) : (
                            message.content
                          )}
                          {message.role === "ASSISTANT" && (isHumanizeResult || savedContentForMessage || showHumanize) && (
                            <div className="message-actions">
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
                    {sending && (isThinking || streamingContent) && (
                      <article className="message assistant streaming">
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
                  <form className="chat-input" onSubmit={sendMessage}>
                    {chatError && (
                      <p className={chatErrorSoft ? "chat-error-inline chat-notice-warn" : "error-text chat-error-inline"}>
                        {chatError}
                      </p>
                    )}
                    {montagePanelOpen && (
                      <div className="viral-remake-panel montage-upload-panel">
                        <div className="viral-remake-title">一键剪视频</div>
                        <p>请选择要剪辑的视频。上传后会在当前会话中展示完整的分析、字幕、音频、画面和成片制作进度。</p>
                        <label className="viral-remake-file">上传待剪视频<input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-m4v" onChange={(event) => setMontageVideoFile(event.target.files?.[0] ?? null)} /></label>
                        <div className="viral-remake-summary">{montageVideoFile ? `已选择：${montageVideoFile.name}` : "暂未选择视频"}</div>
                        <div className="viral-remake-actions"><button type="button" onClick={() => setMontagePanelOpen(false)}>取消</button><button type="button" disabled={!montageVideoFile || sending} onClick={() => void createMontageEdit()}>开始剪辑</button></div>
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
                    <div className="chat-input-topbar">
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => void sendChatContent("今日产品热点")}>今日产品热点</button>
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => void sendChatContent("今日全网热点")}>今日全网热点</button>
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => setRewriteUrlModal(true)}>一键仿写爆款</button>
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
                          onModelsChanged={setModelOptions}
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
                <span className="detail-image-label">推荐标题图</span>
                <img className="detail-cover" src={activeContent.coverImageUrl ?? fallbackImages[0]} alt="内容配图" />
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
                        onClick={() => copyText(activeContent.body, "body")}
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
    </main>
  );
}
