"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "@/lib/markdown";
import { escapeHtml, escapeAttr } from "@/lib/escape";
import KnowledgePanel from "./knowledge-panel";

type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };
type AuthMode = "login" | "register";
type Section =
  | "chat"
  | "library"
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
  analytics: "效果分析",
  knowledge: "知识库",
  accounts: "平台授权管理",
  settings: "系统配置",
  users: "账号管理",
  profile: "个人中心"
};

/** 尚未落地实现、以静态原型（iframe）方式引入平台的分区 */
const prototypeSections: Section[] = ["analytics", "accounts", "settings", "users"];
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
/** 触发热点选题列表渲染的快捷指令 */
const hotTopicPrompts = ["今日全网热点推荐", "今日产品热点推荐"];
const fallbackImages = [
  "https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1469334031218-e382a71b716b?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1551836022-d5d88e9218df?auto=format&fit=crop&w=1200&q=80"
];

async function api<T>(path: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
    });
    const payload = (await response.json()) as ApiResponse<T>;
    if (!payload.ok) throw new Error(payload.error);
    return payload.data;
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

function isHumanizableArticle(content: string): boolean {
  // 已经带着「去 AI 味报告」的内容不再重复处理
  if (/AI\s?味[^\n]{0,4}报告|去\s?AI\s?味报告|质检报告/.test(content)) return false;
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

function extractHotTopics(content: string): { topics: string[]; remainder: string } {
  const topics: string[] = [];
  const kept: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const topic = matchTopicLine(rawLine.trim());
    if (topic) {
      topics.push(topic);
    } else {
      kept.push(rawLine);
    }
  }
  return { topics, remainder: kept.join("\n") };
}

function renderQr(data?: QrData | null) {
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
  return <div className="qr-empty">正在等待 OpenClaw 返回真实绑定二维码</div>;
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
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatError, setChatError] = useState("");
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
  const isPinnedRef = useRef(true); // 用户是否在底部附近（用于自动滚动判断）
  const [activeTurnIndex, setActiveTurnIndex] = useState(-1);
  const [tocCollapsed, setTocCollapsed] = useState(true);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const [contentItems, setContentItems] = useState<ContentItem[]>([]);
  const [activeContent, setActiveContent] = useState<ContentItem | null>(null);
  const [copyHint, setCopyHint] = useState("");
  const [copiedButton, setCopiedButton] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState<"title" | "body" | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [editingTitle, setEditingTitle] = useState("");
  const [contentSaving, setContentSaving] = useState(false);
  const [regeneratingImage, setRegeneratingImage] = useState<string | null>(null);
  const [wechatBinding, setWechatBinding] = useState<WechatBinding | null>(null);
  const [profileQr, setProfileQr] = useState<QrData | null>(null);
  const [profileError, setProfileError] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [profileHint, setProfileHint] = useState("密码修改后，下次登录请使用新密码。");
  const [showPasswordModal, setShowPasswordModal] = useState(false);

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

  useEffect(() => {
    if (user) {
      void refreshConversations();
      void refreshContent();
    }
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

  // 切换对话时滚动到底部并重置高亮
  useEffect(() => {
    const container = messageListRef.current;
    if (container) {
      // 使用 requestAnimationFrame 等待 DOM 渲染完成后再滚动
      requestAnimationFrame(() => {
        if (container) container.scrollTop = container.scrollHeight;
      });
    }
    isPinnedRef.current = true;
    setShowScrollBottom(false);
    setActiveTurnIndex(userMessages.length > 0 ? 0 : -1);
    // 只在 activeConversationId 变化时触发，避免发送消息时频繁重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId]);

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
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
      isPinnedRef.current = isNearBottom;
      setShowScrollBottom(!isNearBottom);
    }

    container.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();

    return () => container.removeEventListener("scroll", handleScroll);
  }, [userMessages]);

  // 流式输出时自动滚动到底部（仅在用户未上滑时跟随）
  useEffect(() => {
    const container = messageListRef.current;
    if (!container) return;
    if (isPinnedRef.current) {
      requestAnimationFrame(() => {
        if (container) container.scrollTop = container.scrollHeight;
      });
    }
  }, [streamingContent, isThinking, sending, activeConversation?.messages.length]);

  async function ensureRegisterQr() {
    if (registerQr || registerLoading) return;
    setRegisterLoading(true);
    setAuthError("");
    try {
      const data = await api<QrData>("/api/wechat/binding/qr", { method: "POST", body: "{}" });
      setRegisterQr(data);
      setAuthHint("请使用微信扫码绑定 AI 员工通道。");
    } catch (error) {
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
    } finally {
      setRegisterLoading(false);
    }
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

  async function sendChatContent(content: string) {
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
        body: JSON.stringify({ content }),
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
            throw new Error(data.error);
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
            throw new Error(data.error);
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) setChatError(error instanceof Error ? error.message : "视频剪辑失败。");
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
            throw new Error(data.error);
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) setChatError(error instanceof Error ? error.message : "视频制作失败。");
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

  async function copyText(text: string, buttonKey: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedButton(buttonKey);
      setCopyHint("已复制");
    } catch {
      setCopyHint("复制失败，请重试");
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

          if (data.type === "delta") {
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
            throw new Error(data.error);
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
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
      setCopyHint("图文已复制");
    } catch {
      await navigator.clipboard.writeText(plain);
      setCopyHint("已复制（纯文本）");
    }
    window.setTimeout(() => setCopyHint(""), 1600);
  }

  async function copyImage(contentId: string, buttonKey: string) {
    try {
      // 1. Fetch image blob
      const response = await fetch(`/api/content/${contentId}/image`);
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "获取图片失败" }));
        throw new Error(error.error || "获取图片失败");
      }
      let blob = await response.blob();

      // 2. Check clipboard API support
      if (!navigator.clipboard || !navigator.clipboard.write) {
        throw new Error("浏览器不支持复制图片，请右键图片另存为");
      }

      // 3. Convert to PNG if needed (ClipboardItem typically only supports PNG)
      if (blob.type !== "image/png") {
        const img = new Image();
        img.crossOrigin = "anonymous";
        const objectUrl = URL.createObjectURL(blob);
        try {
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
          blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((b) => {
              if (b) resolve(b);
              else reject(new Error("图片转换失败"));
            }, "image/png");
          });
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      }

      // 4. Write to clipboard
      const item = new ClipboardItem({ "image/png": blob });
      await navigator.clipboard.write([item]);
      setCopiedButton(buttonKey);
      setCopyHint("图片已复制，可粘贴到 Word/微信等");
    } catch (err) {
      setCopiedButton(null);
      const msg = err instanceof Error ? err.message : "复制失败";
      setCopyHint(msg);
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
      setCopyHint("图片已重新生成");
    } catch (error) {
      setCopyHint(error instanceof Error ? error.message : "图片重新生成失败。");
    } finally {
      setRegeneratingImage(null);
    }
  }

  async function ensureProfileQr() {
    setProfileError("");
    try {
      const data = await api<QrData>("/api/wechat/binding/qr", { method: "POST", body: "{}" });
      setProfileQr(data);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "生成微信绑定二维码失败。");
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
    try {
      await api<{ success: boolean }>("/api/wechat/binding", { method: "DELETE", body: "{}" });
      await refreshMe();
      setProfileQr(null);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "解除绑定失败。");
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
                {renderQr(registerQr)}
                <button type="button" onClick={checkRegisterBinding} disabled={registerLoading || !registerQr}>{registerLoading ? "检查中" : "检查绑定状态"}</button>
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
            <button key={key} className={section === key ? "active" : ""} onClick={() => setSection(key)} title={sidebarCollapsed ? label : undefined}><span className="nav-icon" aria-hidden="true">{icon}</span><span className="nav-label">{label}</span></button>
          ))}
        </nav>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div className="workspace-header-left">
            <span className="crumb">当前页面</span>
            <h2>{sectionTitles[section]}</h2>
          </div>
          <div className="user-chip">
            <span>{user.phone}</span>
            <button className="exit" onClick={logout}>退出</button>
          </div>
        </header>

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
                        const showHumanize = message.role === "ASSISTANT" && message.id === lastAssistantId && isHumanizableArticle(message.content);
                        const previousMessage = messages[messageIndex - 1];
                        const isHotTopicsReply =
                          message.role === "ASSISTANT" &&
                          previousMessage?.role === "USER" &&
                          hotTopicPrompts.includes(previousMessage.content.trim());
                        const hotTopics = isHotTopicsReply ? extractHotTopics(message.content) : null;
                        return (
                        <article key={message.id} id={`message-${message.id}`} className={`message ${message.role === "USER" ? "user" : "assistant"}`}>
                          {message.role === "ASSISTANT" ? (
                            <>
                              <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(hotTopics ? hotTopics.remainder : message.content) }} />
                              {hotTopics && hotTopics.topics.length >= 2 && (
                                <div className="topic-actions">
                                  {hotTopics.topics.map((topic, topicIndex) => (
                                    <div className="topic-action-row" key={`${message.id}-topic-${topicIndex}`}>
                                      <span className="topic-action-label">{topicIndex + 1}. {topic}</span>
                                      <button
                                        type="button"
                                        className="topic-gen-btn"
                                        disabled={sending}
                                        onClick={() => void sendChatContent(`根据这个选题写一篇小红书风格的图文：${topic}`)}
                                      >
                                        生成小红书图文
                                      </button>
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
                          {message.role === "ASSISTANT" && ((lastSavedContent && message.id === lastAssistantId) || showHumanize) && (
                            <div className="message-actions">
                              {lastSavedContent && message.id === lastAssistantId && (
                                <>
                                  <button
                                    className="message-saved-link"
                                    onClick={() => { setActiveContent(lastSavedContent); setSection("library"); }}
                                  >
                                    ✓ 已保存到内容库 · 查看
                                  </button>
                                  <button
                                    className="message-copy-button humanize-button"
                                    hidden={showHumanize}
                                    disabled={humanizingMessageId === message.id}
                                    onClick={() => humanizeMessage(message)}
                                  >
                                    {humanizingMessageId === message.id ? "去AI味中..." : "一键去AI味"}
                                  </button>
                                </>
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
                    {chatError && <p className="error-text chat-error-inline">{chatError}</p>}
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
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => void sendChatContent("今日产品热点推荐")}>今日产品热点推荐</button>
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => void sendChatContent("今日全网热点推荐")}>今日全网热点推荐</button>
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => void sendChatContent("一键仿写爆款")}>一键仿写爆款</button>
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => void sendChatContent("一键剪视频")}>一键剪视频</button>
                      <button type="button" className="quick-action-btn" disabled={sending} onClick={() => void sendChatContent("一键复刻爆款视频")}>一键复刻爆款视频</button>
                    </div>
                    <div className="chat-input-wrap">
                      <textarea
                        value={chatInput}
                        onChange={(event) => setChatInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }
                        }}
                        placeholder="你可以直接发送你的问题即可（Enter 发送，Shift+Enter 换行）"
                      />
                      {sending ? (
                        <button type="button" className="stop-button" onClick={stopGeneration}>停止</button>
                      ) : (
                        <button type="submit" disabled={!chatInput.trim()}>发送</button>
                      )}
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
              <button className="back-to-library-btn" onClick={() => { setActiveContent(null); setEditingContent(null); }}>← 返回</button>
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
                    onClick={() => copyImage(activeContent.id, "image")}
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
              {copyHint && <p className="hint">{copyHint}</p>}
            </section>
          ) : (
            <section className="library-grid">
              {contentItems.map((item, index) => (
                <article key={item.id} className="content-card" onClick={() => setActiveContent(item)}>
                  <img src={item.coverImageUrl ?? fallbackImages[index % fallbackImages.length]} alt="内容封面" />
                  <div className="content-card-head">
                    <span className={`category-tag ${
                      item.category === "小红书" ? "tag-xhs" :
                      item.category === "视频" ? "tag-video" :
                      "tag-wechat"
                    }`}>
                      {item.category || "公众号文章"}
                    </span>
                    <span className="content-date">{formatDate(item.createdAt)}</span>
                  </div>
                  <h3>{item.title}</h3>
                  <p className="content-preview">{item.videoUrl ? "▶ 视频作品" : (item.body.replace(/[*#`>_~]/g, "").trim().slice(0, 20) || "暂无预览")}{!item.videoUrl && item.body.length > 20 ? "..." : ""}</p>
                </article>
              ))}
              {!contentItems.length && <p className="hint">暂无生成内容。先在对话里让 AI 员工生成一篇图文。</p>}
            </section>
          )
        )}

        {section === "knowledge" && <KnowledgePanel />}

        {prototypeSections.includes(section) && (
          <div className="prototype-frame">
            <iframe key={section} src={`/prototype/platform#embed=${section}`} title={sectionTitles[section]} />
          </div>
        )}

        {section === "profile" && (
          <section className="profile-grid">
            <article className="profile-card"><h3>账号信息</h3><p>手机号：{user.phone}</p></article>
            <article className="profile-card">
              <h3>修改密码</h3>
              <button onClick={openPasswordModal}>修改密码</button>
              <p className="hint">{profileHint}</p>
            </article>
            <article className="profile-card wide">
              <h3>微信通道</h3>
              {wechatBinding?.status === "BOUND" ? (
                <div>
                  <strong>已绑定：{wechatBinding.wechatNickname ?? "AI 员工指挥官"}</strong>
                  <p>微信号：{wechatBinding.wechatNo ?? wechatBinding.wechatOpenId ?? "OpenClaw 微信通道"}</p>
                  <p>绑定时间：{formatDate(wechatBinding.boundAt)}</p>
                  <ul><li>帮我推荐明天公众号选题</li><li>生成一篇小红书探店图文</li><li>把这段内容改成更适合朋友圈的口吻</li></ul>
                  <button className="danger-button" onClick={unbindWechat}>解除绑定</button>
                </div>
              ) : (
                <div>
                  <p>绑定后可随时随地在微信里调遣 AI 员工。</p>
                  {profileQr ? renderQr(profileQr) : <button onClick={ensureProfileQr}>立即绑定</button>}
                  {profileQr && <button onClick={checkProfileBinding}>检查绑定状态</button>}
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
              <p className="hint">{profileHint}</p>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
