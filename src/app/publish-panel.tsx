"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 「发布管理」面板 —— 查看已发布内容：标题 / 发布渠道 / 发布人 / 发布时间。
 * 数据来自 GET /api/publish-records（发布记录由发布动作落库）。
 */

type PublishRecord = {
  id: string;
  contentItemId: string;
  channel: string;
  title: string;
  publisher: string;
  status: string;
  error?: string | null;
  remoteId?: string | null;
  remoteUrl?: string | null;
  publishedAt: string;
};

const SITE_URL = "https://hgwx.aimemory.cafe";

function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay) {
    return `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return `昨天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

type DateFilter = "all" | "today" | "7d" | "30d";

const DATE_FILTERS: { key: DateFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "today", label: "今天" },
  { key: "7d", label: "最近7天" },
  { key: "30d", label: "最近30天" }
];

function inRange(iso: string, f: DateFilter): boolean {
  const t = new Date(iso).getTime();
  if (f === "all") return true;
  const now = Date.now();
  if (f === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return t >= start.getTime();
  }
  const days = f === "7d" ? 7 : 30;
  return t >= now - days * 86400000;
}

export default function PublishPanel({ resetToken }: { resetToken: number }) {
  const [records, setRecords] = useState<PublishRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<DateFilter>("today");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/publish-records?limit=200", { cache: "no-store" });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { records: PublishRecord[] };
        error?: string;
      };
      if (!json.ok || !json.data) throw new Error(json.error || "加载发布记录失败。");
      setRecords(json.data.records);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, resetToken]);

  const filtered = records.filter((r) => inRange(r.publishedAt, filter));
  const successCount = filtered.filter((r) => r.status === "SUCCESS").length;
  const failedCount = filtered.length - successCount;

  return (
    <div className="pub-root">
      <div className="pub-toolbar">
        <div className="pub-title-group">
          <h2>发布管理</h2>
          <p className="pub-subtitle">内容库图文对外发布的执行记录</p>
        </div>
        <div className="pub-actions">
          <a className="pub-site-link" href={SITE_URL} target="_blank" rel="noreferrer" title="打开官网好物推荐板块">
            ↗ 好物推荐
          </a>
          <button className="pub-refresh" onClick={() => void refresh()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      <div className="pub-stats">
        <div className="pub-stat">
          <div className="k">发布总数</div>
          <div className="v">{filtered.length}</div>
        </div>
        <div className="pub-stat">
          <div className="k">成功</div>
          <div className="v ok">{successCount}</div>
        </div>
        <div className="pub-stat">
          <div className="k">失败</div>
          <div className={`v ${failedCount ? "bad" : ""}`}>{failedCount}</div>
        </div>
      </div>

      {error && <div className="pub-alert">{error}</div>}

      <div className="ana-chips pub-filter-bar">
        {DATE_FILTERS.map((f) => {
          const count = records.filter((r) => inRange(r.publishedAt, f.key)).length;
          return (
            <button
              key={f.key}
              className={`ana-chip ${filter === f.key ? "on" : ""}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="ana-chip-n">{count}</span>
            </button>
          );
        })}
      </div>

      {loading && records.length === 0 ? (
        <div className="pub-empty">正在加载发布记录…</div>
      ) : records.length === 0 ? (
        <div className="pub-empty-card">
          <div className="pub-empty-ico">▣</div>
          <p>还没有发布记录。</p>
          <p className="pub-empty-hint">在内容库打开一篇图文点「发布官网」，或等每日定时任务自动发布后，这里会显示记录。</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="pub-empty">所选时间范围内没有发布记录。</div>
      ) : (
        <div className="pub-list">
          <div className="pub-head">
            <span className="col-title">标题</span>
            <span className="col-channel">发布渠道</span>
            <span className="col-publisher">发布人</span>
            <span className="col-time">发布时间</span>
            <span className="col-status">状态</span>
          </div>
          {filtered.map((record) => (
            <div key={record.id} className={`pub-row ${record.status === "FAILED" ? "failed" : ""}`} title={record.error || record.title}>
              <span className="col-title">
                <span className="pub-row-title">{record.title}</span>
              </span>
              <span className="col-channel">
                <span className="pub-channel-tag">{record.channel}</span>
              </span>
              <span className="col-publisher">{record.publisher}</span>
              <span className="col-time">{formatTime(record.publishedAt)}</span>
              <span className="col-status">
                {record.status === "SUCCESS" ? (
                  <span className="pub-badge ok">已发布</span>
                ) : (
                  <span className="pub-badge bad">失败</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
