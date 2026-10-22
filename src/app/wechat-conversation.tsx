"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type WechatTurnRole = "user" | "assistant";

type WechatMessage = {
  role: WechatTurnRole;
  body: string;
  createdAt: string;
  mediaPath: string | null;
  mediaMime: string | null;
};

type ConversationResponse = {
  bound: boolean;
  conversationId: string | null;
  messages: WechatMessage[];
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return "今天";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function WechatConversation() {
  const [messages, setMessages] = useState<WechatMessage[]>([]);
  const [bound, setBound] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const pollingRef = useRef<number | null>(null);
  const sendingRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const load = useCallback(async () => {
    // 发送中不刷新：避免把「已发送待回复」的界面状态冲掉，也少一次无谓渲染。
    if (sendingRef.current) return;
    setLoading(true);
    try {
      const res = await fetch("/api/wechat/conversation", { cache: "no-store" });
      if (!res.ok) {
        setError(`加载失败（${res.status}）。`);
        return;
      }
      // 后端统一包装为 { ok, data }，真实负载在 data 字段里
      const payload = (await res.json()) as { ok: boolean; data?: ConversationResponse };
      const data = payload.data ?? (payload as unknown as ConversationResponse);
      setBound(data.bound);
      setMessages(data.messages ?? []);
      setError("");
      setLastSync(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      scrollToBottom();
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败。");
    } finally {
      setLoading(false);
    }
  }, [scrollToBottom]);

  useEffect(() => {
    void load();
    pollingRef.current = window.setInterval(() => void load(), 5000);
    return () => {
      if (pollingRef.current) window.clearInterval(pollingRef.current);
    };
  }, [load]);

  // 等待回复计时：没有反馈的几十秒最难熬，给个明确的「已等 N 秒」。
  useEffect(() => {
    if (!sending) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [sending]);

  async function send() {
    const text = draft.trim();
    if (!text || sending || !bound) return;

    setSending(true);
    sendingRef.current = true;
    setNotice("");
    setError("");
    setDraft("");

    // 乐观追加自己的这句，点击即有反馈（后端也已同步落库，刷新不会丢）。
    const optimistic: WechatMessage = {
      role: "user",
      body: text,
      createdAt: new Date().toISOString(),
      mediaPath: null,
      mediaMime: null
    };
    setMessages((prev) => [...prev, optimistic]);
    scrollToBottom();

    try {
      const res = await fetch("/api/wechat/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text })
      });
      const payload = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            data?: {
              reply?: string;
              delivered?: boolean;
              questionDelivered?: boolean;
              deliverError?: string | null;
            };
            error?: string;
          }
        | null;

      if (!res.ok || !payload?.ok) {
        setError(payload?.error || `发送失败（${res.status}）。`);
        // 失败时把自己刚发的那句还回输入框，方便改完重发
        setDraft(text);
        return;
      }

      const data = payload.data ?? {};
      const failed: string[] = [];
      if (data.questionDelivered === false) failed.push("追问");
      if (data.delivered === false) failed.push("回复");
      if (failed.length) {
        setNotice(`已回复，但${failed.join("、")}推送到微信失败：${data.deliverError || "未知原因"}`);
      } else {
        setNotice("已回复，追问和回复都已同步到微信。");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "发送失败。");
      setDraft(text);
    } finally {
      sendingRef.current = false;
      setSending(false);
      // 以服务端为准重新拉一次（含 AI 回复）
      void load();
    }
  }

  // 按天分组，每天一条分隔
  const groups: { day: string; items: WechatMessage[] }[] = [];
  for (const m of messages) {
    const day = formatDay(m.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(m);
    else groups.push({ day, items: [m] });
  }

  return (
    <section className="chat-panel wechat-panel">
      <div className="chat-head">
        <div className="left">
          <h3>微信会话</h3>
          <span className="date">
            {bound ? "已绑定微信 · 双向同步" : "尚未绑定微信"} · 最近同步 {lastSync ?? "—"}
          </span>
        </div>
        <div className="right">
          <button
            type="button"
            className="wechat-sync-btn"
            disabled={loading || sending}
            onClick={() => void load()}
          >
            {loading ? "同步中…" : "↻ 同步"}
          </button>
        </div>
      </div>

      <div className="chat-body">
        <div className="message-list wechat-list" ref={listRef}>
          {!bound && (
            <div className="wechat-empty">
              还没有绑定微信，去「个人中心 → 微信绑定」扫码绑定后，这里会显示你和 AI 的微信聊天记录。
            </div>
          )}
          {bound && messages.length === 0 && !loading && (
            <div className="wechat-empty">暂无微信聊天记录。可以直接在下面输入，接着微信里那条对话聊。</div>
          )}
          {groups.map((group) => (
            <div className="wechat-day-group" key={group.day}>
              <div className="wechat-day-divider">
                <span>{group.day}</span>
              </div>
              {group.items.map((m, i) => (
                <div
                  key={`${m.createdAt}-${i}`}
                  className={`wechat-msg ${m.role === "user" ? "outbound" : "inbound"}`}
                >
                  <div className="wechat-bubble">
                    {m.mediaPath ? (
                      <span className="wechat-media">[图片/文件]</span>
                    ) : (
                      <span className="wechat-text">{m.body}</span>
                    )}
                  </div>
                  <span className="wechat-time">{formatTime(m.createdAt)}</span>
                </div>
              ))}
            </div>
          ))}
          {sending && (
            <div className="wechat-msg inbound">
              <div className="wechat-bubble wechat-bubble-typing">
                <span className="wechat-typing-dot" />
                <span className="wechat-typing-dot" />
                <span className="wechat-typing-dot" />
              </div>
              <span className="wechat-time">AI 正在回复 · 已等 {elapsed}s</span>
            </div>
          )}
          {error && <div className="wechat-error">{error}</div>}
          {notice && !error && <div className="wechat-notice">{notice}</div>}
        </div>
      </div>

      <form
        className="wechat-input"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={
            bound
              ? "继续追问，回复会同步到你的微信（Enter 发送，Shift+Enter 换行）"
              : "先绑定微信后才能在这里对话"
          }
          rows={2}
          disabled={!bound || sending}
        />
        <button type="submit" disabled={!bound || sending || !draft.trim()}>
          {sending ? `回复中 ${elapsed}s` : "发送"}
        </button>
      </form>
    </section>
  );
}
