"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "@/lib/markdown";
import { escapeHtml, escapeAttr } from "@/lib/escape";

type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };
type AuthMode = "login" | "register";
type Section = "chat" | "library" | "profile";
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
  coverImageUrl?: string | null;
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
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatError, setChatError] = useState("");
  const [sending, setSending] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [toast, setToast] = useState<{ message: string; linkLabel?: string; linkSection?: Section } | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [contentItems, setContentItems] = useState<ContentItem[]>([]);
  const [activeContent, setActiveContent] = useState<ContentItem | null>(null);
  const [copyHint, setCopyHint] = useState("");
  const [editingContent, setEditingContent] = useState(false);
  const [editingBody, setEditingBody] = useState("");
  const [contentSaving, setContentSaving] = useState(false);
  const [regeneratingImage, setRegeneratingImage] = useState<string | null>(null);
  const [wechatBinding, setWechatBinding] = useState<WechatBinding | null>(null);
  const [profileQr, setProfileQr] = useState<QrData | null>(null);
  const [profileError, setProfileError] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [profileHint, setProfileHint] = useState("密码修改后，下次登录请使用新密码。");

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0],
    [activeConversationId, conversations]
  );

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
    if (!chatInput.trim() || sending) return;
    const content = chatInput;

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
            await refreshConversations();
            if (data.contentSaved) {
              setToast({ message: "已自动保存到内容库", linkLabel: "查看", linkSection: "library" });
              await refreshContent();
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

  function stopGeneration() {
    // 防止重入：若已经 abort，直接 return
    if (!abortControllerRef.current || abortControllerRef.current.signal.aborted) return;
    abortControllerRef.current.abort();
  }

  async function copyText(text: string, hint: string) {
    await navigator.clipboard.writeText(text);
    setCopyHint(hint);
    window.setTimeout(() => setCopyHint(""), 1600);
  }

  async function copyMessage(message: Message) {
    await navigator.clipboard.writeText(message.content);
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId(null), 1600);
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

  function startEditContent() {
    if (!activeContent) return;
    setEditingBody(activeContent.body);
    setEditingContent(true);
  }

  function cancelEditContent() {
    setEditingContent(false);
    setEditingBody("");
  }

  async function saveContentEdit() {
    if (!activeContent) return;
    setContentSaving(true);
    try {
      const data = await api<{ contentItem: ContentItem }>(`/api/content/${activeContent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ body: editingBody })
      });
      setActiveContent(data.contentItem);
      setEditingContent(false);
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
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "图片重新生成失败。");
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
    } catch (error) {
      setProfileHint(error instanceof Error ? error.message : "修改密码失败。");
    }
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
    <main className="app-shell">
      <aside className="sidebar" aria-label="主菜单">
        <div className="sidebar-brand">
          <div className="brand-avatar">AI</div>
          <div className="brand-text">
            <span className="brand-title">创星云</span>
            <span className="brand-sub">AI数字员工平台</span>
          </div>
        </div>
        <nav>
          {([
            ["chat", "对话"],
            ["library", "内容库"],
            ["profile", "个人中心"]
          ] as const).map(([key, label]) => (
            <button key={key} className={section === key ? "active" : ""} onClick={() => setSection(key)}>{label}</button>
          ))}
        </nav>
        <button className="ghost-button" onClick={logout}>退出</button>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div className="workspace-header-left">
            <span className="crumb">当前页面</span>
            <h2>{section === "chat" ? "对话" : section === "library" ? "内容库" : "个人中心"}</h2>
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
                  onClick={() => setActiveConversationId(conversation.id)}
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
              <div className="message-list">
                {(activeConversation?.messages ?? []).map((message) => (
                  <article key={message.id} className={`message ${message.role === "USER" ? "user" : "assistant"}`}>
                    {message.role === "ASSISTANT" ? (
                      <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
                    ) : (
                      message.content
                    )}
                    {message.role === "ASSISTANT" && (
                      <div className="message-actions">
                        <button
                          className={`message-copy-button ${copiedMessageId === message.id ? "copied" : ""}`}
                          onClick={() => copyMessage(message)}
                        >
                          {copiedMessageId === message.id ? "已复制" : "复制"}
                        </button>
                      </div>
                    )}
                  </article>
                ))}
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
              <form className="chat-input" onSubmit={sendMessage}>
                <textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="你可以直接发送你的问题即可" />
                {sending ? (
                  <button type="button" className="stop-button" onClick={stopGeneration}>停止</button>
                ) : (
                  <button type="submit" disabled={!chatInput.trim()}>发送</button>
                )}
              </form>
              {chatError && <p className="error-text">{chatError}</p>}
            </section>
          </div>
        )}

        {section === "library" && (
          activeContent ? (
            <section className="content-detail">
              <button className="ghost-button" onClick={() => { setActiveContent(null); setEditingContent(false); }}>返回内容库</button>
              <div className="detail-title-row">
                <h1>{activeContent.title}</h1>
                <button onClick={() => copyText(activeContent.title, "标题已复制")}>复制标题</button>
              </div>
              <span>{formatDate(activeContent.createdAt)}</span>

              <div className="detail-image-block">
                <img className="detail-cover" src={activeContent.coverImageUrl ?? fallbackImages[0]} alt="内容配图" />
                <button
                  className="regen-image-button"
                  disabled={regeneratingImage === "cover-0"}
                  onClick={() => regenerateImage("cover", 0)}
                >
                  {regeneratingImage === "cover-0" ? "生成中..." : "重新生成"}
                </button>
              </div>

              {parseInlineImages(activeContent.inlineImagesJson).map((image, index) => (
                <div key={image} className="detail-image-block">
                  <img className="detail-cover" src={image} alt={`正文配图 ${index + 1}`} />
                  <button
                    className="regen-image-button"
                    disabled={regeneratingImage === `inline-${index}`}
                    onClick={() => regenerateImage("inline", index)}
                  >
                    {regeneratingImage === `inline-${index}` ? "生成中..." : "重新生成"}
                  </button>
                </div>
              ))}

              <div className="detail-body-row">
                <h2>正文</h2>
                <div className="detail-body-actions">
                  {editingContent ? (
                    <>
                      <button onClick={saveContentEdit} disabled={contentSaving}>{contentSaving ? "保存中..." : "保存"}</button>
                      <button className="ghost-button" onClick={cancelEditContent}>取消</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => copyRichContent(activeContent)}>复制图文</button>
                      <button onClick={startEditContent}>编辑</button>
                    </>
                  )}
                </div>
              </div>
              {editingContent ? (
                <textarea
                  className="content-edit-area"
                  value={editingBody}
                  onChange={(event) => setEditingBody(event.target.value)}
                />
              ) : (
                <article className="article-body markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(activeContent.body) }} />
              )}
              {copyHint && <p className="hint">{copyHint}</p>}
            </section>
          ) : (
            <section className="library-grid">
              {contentItems.map((item, index) => (
                <article key={item.id} className="content-card" onClick={() => setActiveContent(item)}>
                  <img src={item.coverImageUrl ?? fallbackImages[index % fallbackImages.length]} alt="内容封面" />
                  <span>{formatDate(item.createdAt)}</span>
                  <h3>{item.title}</h3>
                  <p className="content-preview">{item.body.replace(/[*#`>_~]/g, "").trim().slice(0, 20)}{item.body.length > 20 ? "..." : ""}</p>
                </article>
              ))}
              {!contentItems.length && <p className="hint">暂无生成内容。先在对话里让 AI 员工生成一篇图文。</p>}
            </section>
          )
        )}

        {section === "profile" && (
          <section className="profile-grid">
            <article className="profile-card"><h3>账号信息</h3><p>手机号：{user.phone}</p></article>
            <article className="profile-card">
              <h3>修改密码</h3>
              <form onSubmit={changePassword} className="auth-form compact">
                <input type="password" placeholder="旧密码" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} />
                <input type="password" placeholder="新密码" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
                <button>保存</button>
              </form>
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
    </main>
  );
}
