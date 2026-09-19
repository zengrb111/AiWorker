"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 「效果分析」真实面板 —— 数据来自各渠道真实采集：
 * 官网（站点 PV/UV + 内容浏览/点击）+ 已授权的小红书 / 头条号创作者数据。
 */

type PerPlatform = {
  platform: string;
  name: string;
  contents: number;
  views: number;
  clicks: number;
  likes: number;
  comments: number;
  collects: number;
  shares: number;
};

type SiteDay = { date: string; pv: number; uv: number };

type MetricItem = {
  platform: string;
  platformName: string;
  contentKey: string;
  title: string;
  category?: string | null;
  metricDate: string;
  views: number;
  clicks: number;
  likes: number;
  comments: number;
  collects: number;
  shares: number;
};

type MetricsData = {
  ok: boolean;
  perPlatform?: PerPlatform[];
  siteDays?: SiteDay[];
  items?: MetricItem[];
  accounts?: Array<{ id: string; platform: string; displayName: string; status: string; lastSyncAt?: string | null }>;
  syncedAt?: string | null;
};

function num(n: number): string {
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, "") + "亿";
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + "w";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

export default function AnalyticsPanel({ resetToken }: { resetToken: number }) {
  const [data, setData] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [channel, setChannel] = useState<"all" | "site" | "xhs" | "toutiao">("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(100);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/platform-metrics", { cache: "no-store" });
      const json = (await res.json()) as MetricsData;
      if (!json.ok) throw new Error("加载效果数据失败。");
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, resetToken]);

  async function syncNow() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/platform-metrics/sync", { method: "POST" });
      const json = (await res.json()) as { ok: boolean; results?: Array<{ platform: string; ok: boolean; message: string }> };
      const lines = (json.results || []).map((r) => `${r.message}`);
      setSyncMsg({ ok: json.ok, text: lines.join("；") || "同步完成" });
      await refresh();
    } catch (err) {
      setSyncMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSyncing(false);
    }
  }

  const perPlatform = data?.perPlatform || [];
  const allItems = data?.items || [];
  const siteDays = data?.siteDays || [];

  // 渠道筛选 + 标题搜索（全量明细，不分渠道截断）
  const filtered = allItems.filter((it) => {
    if (channel !== "all" && it.platform !== channel) return false;
    if (query && !it.title.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
  const items = filtered.slice(0, shown);
  const totalViews = perPlatform.reduce((s, p) => s + p.views, 0);
  const totalInteractions = perPlatform.reduce((s, p) => s + p.likes + p.comments + p.collects + p.shares, 0);
  const maxPv = Math.max(1, ...siteDays.map((d) => d.pv));

  return (
    <div className="pub-root">
      <div className="pub-toolbar">
        <div className="pub-title-group">
          <h2>效果分析</h2>
          <p className="pub-subtitle">官网 · 小红书 · 头条号 三渠道真实投放效果</p>
        </div>
        <div className="pub-actions">
          <button className="pub-refresh primary" onClick={() => void syncNow()} disabled={syncing}>
            {syncing ? "同步中…" : "同步数据"}
          </button>
          <button className="pub-refresh" onClick={() => void refresh()} disabled={loading}>
            刷新
          </button>
        </div>
      </div>

      {syncMsg && <div className={syncMsg.ok ? "pub-alert ok" : "pub-alert"}>{syncMsg.text}</div>}
      {error && <div className="pub-alert">{error}</div>}

      <div className="pub-stats">
        <div className="pub-stat">
          <div className="k">累计浏览</div>
          <div className="v">{num(totalViews)}</div>
        </div>
        <div className="pub-stat">
          <div className="k">累计互动</div>
          <div className="v ok">{num(totalInteractions)}</div>
        </div>
        <div className="pub-stat">
          <div className="k">官网今日 PV</div>
          <div className="v">{num(siteDays.at(-1)?.pv || 0)}</div>
        </div>
        <div className="pub-stat">
          <div className="k">官网今日 UV</div>
          <div className="v">{num(siteDays.at(-1)?.uv || 0)}</div>
        </div>
      </div>

      {loading && !data ? (
        <div className="pub-empty">正在加载效果数据…</div>
      ) : perPlatform.length === 0 ? (
        <div className="pub-empty-card">
          <div className="pub-empty-ico">◫</div>
          <p>还没有效果数据。</p>
          <p className="pub-empty-hint">点右上角「同步数据」拉取官网真实统计；小红书 / 头条号需先在「平台授权管理」完成授权。</p>
        </div>
      ) : (
        <>
          {siteDays.length > 0 && (
            <div className="ana-site-days">
              <div className="ana-section-title">官网流量（近 {siteDays.length} 天）</div>
              <div className="ana-bars">
                {siteDays.map((d) => (
                  <div key={d.date} className="ana-bar-item" title={`${d.date}：PV ${d.pv} / UV ${d.uv}`}>
                    <div className="ana-bar" style={{ height: `${Math.max(6, (d.pv / maxPv) * 72)}px` }} />
                    <div className="ana-bar-date">{d.date.slice(5)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="ana-section-title">各渠道数据对比</div>
          <div className="pub-list">
            <div className="pub-head ana-head">
              <span className="col-plat">渠道</span>
              <span className="col-n">内容数</span>
              <span className="col-n">浏览</span>
              <span className="col-n">点击</span>
              <span className="col-n">点赞</span>
              <span className="col-n">评论</span>
              <span className="col-n">收藏</span>
              <span className="col-n">分享</span>
            </div>
            {perPlatform.map((p) => (
              <div key={p.platform} className="pub-row ana-row">
                <span className="col-plat">
                  <span className={`acct-plat-badge ${p.platform}`}>{p.name}</span>
                </span>
                <span className="col-n">{p.contents}</span>
                <span className="col-n strong">{num(p.views)}</span>
                <span className="col-n">{num(p.clicks)}</span>
                <span className="col-n">{num(p.likes)}</span>
                <span className="col-n">{num(p.comments)}</span>
                <span className="col-n">{num(p.collects)}</span>
                <span className="col-n">{num(p.shares)}</span>
              </div>
            ))}
          </div>

          {allItems.length > 0 && (
            <>
              <div className="ana-section-title">
                内容效果明细（共 {filtered.length} 条{channel !== "all" || query ? ` / 全部 ${allItems.length} 条` : ""}）
              </div>
              <div className="ana-filter-bar">
                <div className="ana-chips">
                  {(
                    [
                      ["all", "全部"],
                      ["xhs", "小红书"],
                      ["toutiao", "头条号"],
                      ["site", "官网"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      className={`ana-chip ${channel === key ? "on" : ""}`}
                      onClick={() => {
                        setChannel(key);
                        setShown(100);
                      }}
                    >
                      {label}
                      <span className="ana-chip-n">
                        {key === "all"
                          ? allItems.length
                          : allItems.filter((it) => it.platform === key).length}
                      </span>
                    </button>
                  ))}
                </div>
                <input
                  className="ana-search"
                  type="search"
                  placeholder="搜索标题…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setShown(100);
                  }}
                />
              </div>
              <div className="pub-list">
                <div className="pub-head ana-head">
                  <span className="col-plat">渠道</span>
                  <span className="col-title">标题</span>
                  <span className="col-n">浏览</span>
                  <span className="col-n">点击</span>
                  <span className="col-n">点赞</span>
                  <span className="col-n">评论</span>
                  <span className="col-n">收藏</span>
                  <span className="col-n">分享</span>
                  <span className="col-n">数据日期</span>
                </div>
                {items.map((it) => (
                  <div key={`${it.platform}-${it.contentKey}`} className="pub-row ana-row">
                    <span className="col-plat">
                      <span className={`acct-plat-badge ${it.platform}`}>{it.platformName}</span>
                    </span>
                    <span className="col-title">
                      <span className="pub-row-title" title={it.title}>{it.title}</span>
                    </span>
                    <span className="col-n strong">{num(it.views)}</span>
                    <span className="col-n">{num(it.clicks)}</span>
                    <span className="col-n">{num(it.likes)}</span>
                    <span className="col-n">{num(it.comments)}</span>
                    <span className="col-n">{num(it.collects)}</span>
                    <span className="col-n">{num(it.shares)}</span>
                    <span className="col-n">{it.metricDate.slice(5)}</span>
                  </div>
                ))}
                {items.length === 0 && <div className="ana-no-match">没有匹配的内容。</div>}
              </div>
              {shown < filtered.length && (
                <div className="ana-more-wrap">
                  <button className="pub-refresh" onClick={() => setShown((n) => n + 200)}>
                    加载更多（已显示 {items.length} / {filtered.length}）
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
