"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 「平台授权管理」真实面板 —— 官网渠道免授权；小红书 / 头条号通过
 * 创作者后台 Cookie 授权（服务端真实校验后 AES 加密存储）。
 */

type Account = {
  id: string;
  platform: string;
  displayName: string;
  externalId?: string | null;
  status: string;
  statusMsg?: string | null;
  boundBy?: string | null;
  lastSyncAt?: string | null;
  lastVerifyAt?: string | null;
  createdAt: string;
};

const PLATFORMS: Record<string, { name: string; desc: string; cookieGuide: string; badge: string }> = {
  site: {
    name: "官网",
    desc: "和光万象官网 hgwx.aimemory.cafe，服务端令牌直连，无需授权",
    cookieGuide: "",
    badge: "已接入",
  },
  xhs: {
    name: "小红书",
    desc: "授权后自动拉取创作者中心笔记数据",
    cookieGuide:
      "电脑浏览器打开 creator.xiaohongshu.com 登录 → 按 F12 打开开发者工具 → Network 面板刷新页面 → 点任意一个请求 → 在 Request Headers 里复制完整的 Cookie 值，粘贴到下面",
    badge: "未授权",
  },
  toutiao: {
    name: "头条号",
    desc: "授权后自动拉取头条号后台内容数据",
    cookieGuide:
      "电脑浏览器打开 mp.toutiao.com 登录 → 按 F12 打开开发者工具 → Network 面板刷新页面 → 点任意一个请求 → 在 Request Headers 里复制完整的 Cookie 值，粘贴到下面",
    badge: "未授权",
  },
};

function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function AccountsPanel({ resetToken }: { resetToken: number }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [bindPlatform, setBindPlatform] = useState<string | null>(null);
  const [cookieInput, setCookieInput] = useState("");
  const [binding, setBinding] = useState(false);
  const [bindMsg, setBindMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/platform-accounts", { cache: "no-store" });
      const json = (await res.json()) as { ok: boolean; accounts?: Account[]; error?: string };
      if (!json.ok) throw new Error(json.error || "加载授权账号失败。");
      setAccounts(json.accounts || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, resetToken]);

  const accountFor = (platform: string) => accounts.find((a) => a.platform === platform);

  async function submitBind() {
    if (!bindPlatform) return;
    setBinding(true);
    setBindMsg(null);
    try {
      const res = await fetch("/api/platform-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: bindPlatform, cookie: cookieInput }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      if (!json.ok) {
        setBindMsg({ ok: false, text: json.message || "绑定失败，请检查 Cookie 是否完整。" });
        return;
      }
      setBindMsg({ ok: true, text: "绑定成功，平台凭据已加密保存。" });
      setCookieInput("");
      setTimeout(() => {
        setBindPlatform(null);
        setBindMsg(null);
        void refresh();
      }, 1200);
    } catch (err) {
      setBindMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBinding(false);
    }
  }

  /** 解绑二次确认：第一次点击进入确认态（4 秒后自动还原），再点一次才真正解绑 */
  async function removeAccount(id: string) {
    if (confirmRemove?.id === id) {
      clearTimeout(confirmRemove.timer);
      setConfirmRemove(null);
      try {
        await fetch(`/api/platform-accounts/${id}`, { method: "DELETE" });
        void refresh();
      } catch {
        setError("解绑请求失败，请重试。");
      }
      return;
    }
    if (confirmRemove) clearTimeout(confirmRemove.timer);
    const timer = setTimeout(() => setConfirmRemove(null), 4000);
    setConfirmRemove({ id, timer });
  }

  return (
    <div className="pub-root">
      <div className="pub-toolbar">
        <div className="pub-title-group">
          <h2>平台授权管理</h2>
          <p className="pub-subtitle">效果数据的来源渠道授权与凭据状态</p>
        </div>
        <div className="pub-actions">
          <button className="pub-refresh" onClick={() => void refresh()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {error && <div className="pub-alert">{error}</div>}

      <div className="acct-list">
        {Object.entries(PLATFORMS).map(([platform, meta]) => {
          const acc = accountFor(platform);
          const statusLabel =
            platform === "site"
              ? "已接入"
              : acc
                ? acc.status === "active"
                  ? "已授权"
                  : acc.status === "error"
                    ? "异常"
                    : "失效"
                : "未授权";
          return (
            <div key={platform} className="acct-card">
              <div className="acct-head">
                <span className={`acct-plat-badge ${platform}`}>{meta.name}</span>
                <div className="acct-head-main">
                  <div className="acct-name">{acc ? acc.displayName : meta.name}</div>
                  <div className="acct-desc">{meta.desc}</div>
                </div>
                <span className={`pub-badge ${acc || platform === "site" ? "ok" : ""}`}>{statusLabel}</span>
              </div>
              {acc && platform !== "site" && (
                <div className="acct-meta">
                  <span>绑定人：{acc.boundBy || "—"}</span>
                  <span>绑定时间：{formatTime(acc.createdAt)}</span>
                  <span>最近同步：{formatTime(acc.lastSyncAt)}</span>
                </div>
              )}
              {acc?.statusMsg && acc.status !== "active" && <div className="acct-error">{acc.statusMsg}</div>}
              <div className="acct-ops">
                {platform === "site" ? (
                  <span className="acct-note">服务端令牌直连，数据每日自动同步</span>
                ) : acc ? (
                  <button
                    className="acct-btn danger"
                    onClick={() => void removeAccount(acc.id)}
                    disabled={removing === acc.id}
                  >
                    {confirmRemove?.id === acc.id ? "4 秒内再点一次确认解绑" : removing === acc.id ? "解绑中…" : "解除授权"}
                  </button>
                ) : (
                  <button className="acct-btn primary" onClick={() => { setBindPlatform(platform); setBindMsg(null); setCookieInput(""); }}>
                    授权绑定
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {bindPlatform && (
        <div className="acct-mask" onClick={() => !binding && setBindPlatform(null)}>
          <div className="acct-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{PLATFORMS[bindPlatform].name} 授权绑定</h3>
            <p className="acct-guide">{PLATFORMS[bindPlatform].cookieGuide}</p>
            <textarea
              className="acct-cookie-input"
              placeholder="粘贴完整的 Cookie 值（形如 a=1; b=2; ...）"
              value={cookieInput}
              onChange={(e) => setCookieInput(e.target.value)}
              rows={6}
              disabled={binding}
            />
            {bindMsg && <div className={bindMsg.ok ? "acct-msg ok" : "acct-msg bad"}>{bindMsg.text}</div>}
            <div className="acct-dialog-ops">
              <button className="acct-btn" onClick={() => setBindPlatform(null)} disabled={binding}>
                取消
              </button>
              <button
                className="acct-btn primary"
                onClick={() => void submitBind()}
                disabled={binding || cookieInput.trim().length < 20}
              >
                {binding ? "正在验证凭据…" : "验证并绑定"}
              </button>
            </div>
            <p className="acct-security">凭据使用 AES-256-GCM 加密存储，仅用于服务端拉取平台数据。</p>
          </div>
        </div>
      )}
    </div>
  );
}
