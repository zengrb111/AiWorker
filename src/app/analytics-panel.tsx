"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 「效果分析」真实面板 —— 数据来自各渠道真实采集：
 * 官网（站点 PV/UV + 内容浏览）+ 已授权的小红书 / 头条号 / 公众号 / 视频号数据。
 */

type PerPlatform = {
  platform: string;
  name: string;
  contents: number;
  views: number;
  impressions: number;
  likes: number;
  comments: number;
  collects: number;
  shares: number;
  /** 阅读人数（公众号） */
  readers?: number;
  /** 在看数（公众号） */
  wows?: number;
};

type SiteDay = { date: string; pv: number; uv: number };

/** 账号级日指标（公众号 / 视频号的涨粉、阅读/互动汇总等） */
type DailyMetric = {
  platform: string;
  metricDate: string;
  pv: number;
  uv: number;
  fans: number;
  /** 账号级互动汇总（公众号后台口径） */
  reads: number;
  shares: number;
  likes: number;
  wows: number;
};

/** 拆解库列表项 */
type LibItem = {
  id: string;
  platform: string;
  contentKey: string;
  title: string;
  category?: string | null;
  metricViews: number;
  status: string;
  usedByCron: boolean;
};

type MetricItem = {
  platform: string;
  platformName: string;
  contentKey: string;
  title: string;
  category?: string | null;
  metricDate: string;
  views: number;
  impressions: number;
  likes: number;
  comments: number;
  collects: number;
  shares: number;
  /** 阅读人数（公众号） */
  readers?: number;
  /** 在看数（公众号） */
  wows?: number;
  /** 是否已抓到原文（拆解必须基于原文，没原文不能拆） */
  hasSource?: boolean;
  /** 平台原文链接（标题可点击新标签打开查看实际作品） */
  url?: string | null;
};

type MetricsData = {
  ok: boolean;
  perPlatform?: PerPlatform[];
  siteDays?: SiteDay[];
  items?: MetricItem[];
  /** 非官网渠道的账号级日指标（公众号 / 视频号涨粉） */
  dailyMetrics?: DailyMetric[];
  accounts?: Array<{ id: string; platform: string; displayName: string; status: string; lastSyncAt?: string | null }>;
  syncedAt?: string | null;
};

function num(n: number): string {
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, "") + "亿";
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + "w";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/**
 * 各平台真实能拿到的指标不同，硬塞 0 会误导（比如头条号没有点击量，小红书没有展现量）。
 * 不在该平台指标集里的列显示「—」而不是 0。
 * 「点击」指标已下线：只有官网有真实统计且量级极小（个位数），小红书/头条号平台均不提供，
 * 保留在数据层（PlatformContentMetric.clicks）但不做展示。
 */
const PLATFORM_METRICS: Record<string, string[]> = {
  site: ["views"],
  xhs: ["views", "likes", "comments", "collects", "shares"],
  toutiao: ["views", "impressions", "likes", "comments", "collects"],
  // 公众号 / 视频号：后台不提供内容级明细（只有账号级汇总，见「微信生态数据」区块）→ 内容行全列显示「—」
  wechat: [],
  channels: [],
  // 官网-AI回忆录 / 官网-AI员工：只同步「收录内容」清单，平台不提供阅读/互动统计 → 全列显示「—」
  healing: [],
  aiworker: [],
};

/** 渠道中文名（表格、明细、弹窗统一取用） */
const PLATFORM_LABEL: Record<string, string> = {
  site: "官网",
  xhs: "小红书",
  toutiao: "头条号",
  wechat: "公众号",
  channels: "视频号",
  healing: "官网-AI回忆录",
  aiworker: "官网-AI员工",
};

/** 微信生态渠道：在效果分析里额外展示「阅读人数 / 在看 / 涨粉」专属数据 */
const WECHAT_PLATFORMS = ["wechat", "channels"];

function metricCell(platform: string, key: string, value: number, strong = false) {
  const supported = PLATFORM_METRICS[platform];
  if (supported && !supported.includes(key)) {
    return (
      <span className="col-n na" title="该平台不提供此指标">
        —
      </span>
    );
  }
  return <span className={strong ? "col-n strong" : "col-n"}>{num(value)}</span>;
}

export default function AnalyticsPanel({ resetToken }: { resetToken: number }) {
  const [data, setData] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const syncPollRef = useRef<number | null>(null);
  const [channel, setChannel] = useState<"all" | "site" | "xhs" | "toutiao" | "wechat" | "channels" | "healing" | "aiworker">("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(100);

  // 爆款拆解：子视图 + 拆解弹窗
  const [tab, setTab] = useState<"data" | "lib">("data");
  const [lib, setLib] = useState<LibItem[] | null>(null);
  const [modal, setModal] = useState<{
    id?: string; platform: string; contentKey: string; title: string;
    category?: string | null; views: number; text: string; status: string; usedByCron: boolean;
  } | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalMsg, setModalMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refreshLib = useCallback(async () => {
    try {
      const res = await fetch("/api/breakdowns", { cache: "no-store" });
      const json = (await res.json()) as { ok: boolean; items?: any[] };
      if (json.ok) setLib(json.items || []);
    } catch {}
  }, []);

  useEffect(() => {
    if (tab === "lib" && !lib) void refreshLib();
  }, [tab, lib, refreshLib]);

  /**
   * 打开已有拆解的弹窗（效果数据行的「查看拆解」与拆解库的「编辑」共用）。
   * 关键：先清掉上一次操作留下的提示，否则换个条目打开时会看到别的条目的
   * 「已设为每日任务参考」而误以为它已经设为参考。
   * usedByCron 一律以服务端返回为准，不在本地猜。
   */
  async function openBreakdown(b: LibItem) {
    setModalMsg(null);
    setModal({
      id: b.id, platform: b.platform, contentKey: b.contentKey, title: b.title,
      category: b.category, views: b.metricViews, text: "", status: b.status, usedByCron: b.usedByCron,
    });
    setModalLoading(true);
    try {
      const r = await fetch(`/api/breakdowns/${b.id}`, { cache: "no-store" });
      const j = (await r.json()) as { ok: boolean; item?: any; message?: string };
      if (j.ok && j.item) {
        setModal((m) => m ? {
          ...m,
          text: j.item.editedBreakdown || j.item.aiBreakdown || "",
          status: j.item.status ?? m.status,
          usedByCron: !!j.item.usedByCron,
        } : m);
      } else {
        setModalMsg({ ok: false, text: j.message || "读取拆解失败" });
      }
    } catch (e) {
      setModalMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setModalLoading(false);
    }
  }

  /** 点击「拆解」：已拆过则直接打开，否则触发 AI 拆解 */
  async function openDecompose(it: MetricItem) {
    setModalMsg(null);
    const existing = (lib || []).find((b) => b.platform === it.platform && b.contentKey === it.contentKey);
    if (existing) {
      await openBreakdown(existing);
      return;
    }
    setModal({
      platform: it.platform, contentKey: it.contentKey, title: it.title,
      category: it.category, views: it.views, text: "", status: "draft", usedByCron: false,
    });
    setModalLoading(true);
    try {
      const r = await fetch("/api/breakdowns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: it.platform, contentKey: it.contentKey, title: it.title, views: it.views, category: it.category }),
      });
      const j = (await r.json()) as { ok: boolean; item?: any; message?: string };
      if (j.ok && j.item) {
        setModal((m) => m ? {
          ...m,
          id: j.item.id,
          text: j.item.aiBreakdown || "",
          status: j.item.status ?? "draft",
          usedByCron: !!j.item.usedByCron,
        } : m);
        await refreshLib();
      } else {
        setModalMsg({ ok: false, text: j.message || "拆解失败" });
      }
    } catch (e) {
      setModalMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setModalLoading(false);
    }
  }

  /** 保存人工二次编辑 */
  async function saveEdit() {
    if (!modal?.id) return;
    setModalLoading(true);
    setModalMsg(null);
    try {
      const r = await fetch(`/api/breakdowns/${modal.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editedBreakdown: modal.text, status: modal.usedByCron ? "active" : "edited" }),
      });
      const j = (await r.json()) as { ok: boolean; item?: any; message?: string; fileError?: string };
      if (j.ok) {
        setModal((m) => m ? { ...m, status: j.item?.status ?? m.status, usedByCron: !!j.item?.usedByCron } : m);
        setModalMsg({ ok: true, text: j.fileError ? `已保存（写入参考文件失败：${j.fileError}）` : "已保存" });
        await refreshLib();
      } else {
        setModalMsg({ ok: false, text: j.message || "保存失败" });
      }
    } catch (e) {
      setModalMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setModalLoading(false);
    }
  }

  /** 设为 / 取消「每日任务参考」 */
  async function toggleCron() {
    if (!modal?.id) return;
    setModalLoading(true);
    setModalMsg(null);
    try {
      const r = await fetch(`/api/breakdowns/${modal.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: modal.usedByCron ? "edited" : "active" }),
      });
      const j = (await r.json()) as { ok: boolean; item?: any; message?: string; fileError?: string };
      if (j.ok) {
        // 以服务端返回的真实状态为准（item 是写入参考文件后的最终行），不在本地取反猜
        const nowActive = !!j.item?.usedByCron;
        setModal((m) => m ? { ...m, status: j.item?.status ?? m.status, usedByCron: nowActive } : m);
        setModalMsg({
          ok: true,
          text: nowActive
            ? (j.fileError ? `已设为参考（写入参考文件失败：${j.fileError}）` : "已设为每日任务参考，明日内容生产将复用此拆解")
            : "已取消每日任务参考",
        });
        await refreshLib();
      } else {
        setModalMsg({ ok: false, text: j.message || "操作失败" });
      }
    } catch (e) {
      setModalMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setModalLoading(false);
    }
  }

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
    return () => {
      // 面板卸载（切到其它菜单）时停止轮询；同步仍在服务端后台继续，
      // 回到本面板时 mount 检查会从服务端读回「同步中/已完成」状态。
      if (syncPollRef.current) {
        window.clearTimeout(syncPollRef.current);
        syncPollRef.current = null;
      }
    };
  }, [refresh, resetToken]);

  /** 轮询服务端同步状态：running 继续等；结束则展示结果并刷新数据 */
  const pollSyncStatus = useCallback(async () => {
    let stillRunning = false;
    try {
      const res = await fetch("/api/platform-metrics/sync", { cache: "no-store" });
      const json = (await res.json()) as {
        ok: boolean;
        state?: {
          running: boolean;
          finishedAt?: string;
          ok?: boolean;
          results?: Array<{ platform: string; ok: boolean; message: string }>;
          error?: string;
        } | null;
      };
      const st = json.state;
      if (st?.running) {
        stillRunning = true;
      } else if (st && st.finishedAt) {
        const lines = (st.results || []).map((r) => r.message);
        setSyncMsg({
          ok: !!st.ok,
          text: st.error || lines.join("；") || "同步完成",
        });
        await refresh();
      }
    } catch {
      // 单次查询失败不中断轮询
      stillRunning = true;
    }
    if (stillRunning) {
      if (syncPollRef.current) window.clearTimeout(syncPollRef.current);
      syncPollRef.current = window.setTimeout(() => void pollSyncStatus(), 3000);
    } else {
      setSyncing(false);
      syncPollRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // 挂载时读一次服务端同步状态：同步中 → 恢复「同步中」并继续轮询；
  // 刚结束（2 分钟内）→ 恢复结果提示，让用户切走再回来也能看到。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/platform-metrics/sync", { cache: "no-store" });
        const json = (await res.json()) as { state?: { running: boolean; finishedAt?: string } | null };
        if (cancelled || !json.state) return;
        if (json.state.running) {
          setSyncing(true);
          setSyncMsg(null);
          syncPollRef.current = window.setTimeout(() => void pollSyncStatus(), 1500);
        } else if (json.state.finishedAt) {
          const ageMs = Date.now() - new Date(json.state.finishedAt).getTime();
          if (ageMs < 120000) {
            void pollSyncStatus(); // 结束态复用同一逻辑展示结果
          }
        }
      } catch {
        // 状态读取失败按无同步处理
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pollSyncStatus]);

  async function syncNow() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/platform-metrics/sync", { method: "POST" });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error || "触发同步失败。");
      // 已在后台执行（或本就在执行中）→ 轮询状态直到完成
      if (syncPollRef.current) window.clearTimeout(syncPollRef.current);
      syncPollRef.current = window.setTimeout(() => void pollSyncStatus(), 1500);
    } catch (err) {
      setSyncMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
      setSyncing(false);
    }
  }

  const perPlatform = data?.perPlatform || [];
  const allItems = data?.items || [];
  const siteDays = data?.siteDays || [];
  // 「官网今日 PV/UV」按今天的日期取，不能取 siteDays 的最后一行——
  // 最后一行可能是昨天（今天还没产生访问/还没同步），那样会把旧数据当今日展示。
  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const siteToday = siteDays.find((d) => d.date === todayStr) ?? null;

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

  // 微信生态（公众号 / 视频号）：账号级汇总（后台采集器回填）+ 涨粉。
  // 这类后台只提供账号级数据、不提供内容级明细，因此以「账号级汇总」为准展示。
  const wechatRows = perPlatform.filter((p) => WECHAT_PLATFORMS.includes(p.platform));
  const dailyMetrics = data?.dailyMetrics || [];
  const accountStatsOf = (platform: string) => {
    const rows = dailyMetrics.filter((d) => d.platform === platform);
    const latest = rows.length ? rows[rows.length - 1] : null;
    return {
      has: rows.length > 0,
      latest,
      todayFans: rows.find((d) => d.metricDate === todayStr)?.fans ?? 0,
      totalFans: rows.reduce((s, d) => s + d.fans, 0),
    };
  };

  return (
    <div className="pub-root">
      <div className="pub-toolbar">
        <div className="pub-title-group">
          <h2>效果分析</h2>
          <p className="pub-subtitle">官网 · 小红书 · 头条号 · 公众号 · 视频号 真实投放效果</p>
        </div>
        <div className="ana-tabs">
          <button className={tab === "data" ? "ana-tab active" : "ana-tab"} onClick={() => setTab("data")}>效果数据</button>
          <button className={tab === "lib" ? "ana-tab active" : "ana-tab"} onClick={() => { setTab("lib"); void refreshLib(); }}>
            爆款拆解库{lib && lib.length ? `（${lib.length}）` : ""}
          </button>
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
          <div className="v">{siteToday ? num(siteToday.pv) : "—"}</div>
        </div>
        <div className="pub-stat">
          <div className="k">官网今日 UV</div>
          <div className="v">{siteToday ? num(siteToday.uv) : "—"}</div>
        </div>
      </div>

      {tab === "data" && (
        loading && !data ? (
        <div className="pub-empty">正在加载效果数据…</div>
      ) : perPlatform.length === 0 ? (
        <div className="pub-empty-card">
          <div className="pub-empty-ico">◫</div>
          <p>还没有效果数据。</p>
          <p className="pub-empty-hint">点右上角「同步数据」拉取各渠道真实统计；官网 / 小红书 / 头条号 / 公众号 / 视频号需先在「平台授权管理」完成配置（官网填域名 + 令牌，其余粘贴后台 Cookie）。</p>
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

          {wechatRows.length > 0 && (
            <div className="ana-site-days">
              <div className="ana-section-title">微信生态数据（公众号 / 视频号）</div>
              <div className="ana-wechat-grid">
                {wechatRows.map((p) => {
                  const acc = accountStatsOf(p.platform);
                  const L = acc.latest;
                  const isWechat = p.platform === "wechat";
                  const hint = acc.has
                    ? "账号级数据由浏览器采集器回填（该后台只提供账号级汇总，不提供内容级明细）"
                    : "尚未采集到账号级数据：点右上角「同步数据」触发浏览器采集器（约 1-2 分钟）";
                  const show = (n?: number) => (acc.has && typeof n === "number" ? num(n) : "—");
                  return (
                    <div key={p.platform} className="ana-wechat-card">
                      <div className="ana-wechat-head">
                        <span className={`acct-plat-badge ${p.platform}`}>{p.name}</span>
                        <span className="ana-wechat-sub">{p.contents} 篇内容</span>
                      </div>
                      <div className="ana-wechat-stats">
                        <div className="ana-wechat-stat" title={hint}>
                          <span className="k">{isWechat ? "阅读次数" : "播放量"}</span>
                          <span className="v">{show(L?.reads)}</span>
                        </div>
                        <div className="ana-wechat-stat" title="该后台未提供人数口径">
                          <span className="k">阅读人数</span>
                          <span className="v">—</span>
                        </div>
                        <div className="ana-wechat-stat" title={hint}>
                          <span className="k">在看</span>
                          <span className="v">{show(L?.wows)}</span>
                        </div>
                        <div className="ana-wechat-stat" title={hint}>
                          <span className="k">点赞</span>
                          <span className="v">{show(L?.likes)}</span>
                        </div>
                        <div className="ana-wechat-stat" title={hint}>
                          <span className="k">分享</span>
                          <span className="v">{show(L?.shares)}</span>
                        </div>
                        <div className="ana-wechat-stat" title="该后台未提供收藏口径">
                          <span className="k">收藏</span>
                          <span className="v">—</span>
                        </div>
                        <div className="ana-wechat-stat" title={hint + "（涨粉口径待接入用户分析接口）"}>
                          <span className="k">今日涨粉</span>
                          <span className="v">{show(acc.todayFans)}</span>
                        </div>
                        <div className="ana-wechat-stat" title={hint}>
                          <span className="k">累计涨粉</span>
                          <span className="v">{acc.has && acc.totalFans > 0 ? num(acc.totalFans) : "—"}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="ana-section-title">各渠道数据对比</div>
          <div className="pub-list">
            <div className="pub-head ana-head ana-cols-summary">
              <span className="col-plat">渠道</span>
              <span className="col-n">内容数</span>
              <span className="col-n">浏览</span>
              <span className="col-n">展现</span>
              <span className="col-n">点赞</span>
              <span className="col-n">评论</span>
              <span className="col-n">收藏</span>
              <span className="col-n">分享</span>
            </div>
            {perPlatform.map((p) => (
              <div key={p.platform} className="pub-row ana-row ana-cols-summary">
                <span className="col-plat">
                  <span className={`acct-plat-badge ${p.platform}`}>{p.name}</span>
                </span>
                <span className="col-n">{p.contents}</span>
                {metricCell(p.platform, "views", p.views, true)}
                {metricCell(p.platform, "impressions", p.impressions)}
                {metricCell(p.platform, "likes", p.likes)}
                {metricCell(p.platform, "comments", p.comments)}
                {metricCell(p.platform, "collects", p.collects)}
                {metricCell(p.platform, "shares", p.shares)}
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
                      ["wechat", "公众号"],
                      ["channels", "视频号"],
                      ["site", "官网"],
                      ["healing", "官网-AI回忆录"],
                      ["aiworker", "官网-AI员工"],
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
                <div className="pub-head ana-head ana-cols-detail">
                  <span className="col-plat">渠道</span>
                  <span className="col-title">标题</span>
                  <span className="col-n">浏览</span>
                  <span className="col-n">展现</span>
                  <span className="col-n">点赞</span>
                  <span className="col-n">评论</span>
                  <span className="col-n">收藏</span>
                  <span className="col-n">分享</span>
                  <span className="col-n">数据日期</span>
                </div>
                {items.map((it) => {
                  const done = (lib || []).find((b) => b.platform === it.platform && b.contentKey === it.contentKey);
                  return (
                  <div key={`${it.platform}-${it.contentKey}`} className="pub-row ana-row ana-cols-detail">
                    <span className="col-plat">
                      <span className={`acct-plat-badge ${it.platform}`}>{it.platformName}</span>
                    </span>
                    <span className="col-title">
                      {it.url ? (
                        <a className="pub-row-title" href={it.url} target="_blank" rel="noreferrer" title={`${it.title}（点击查看原文）`}>{it.title}</a>
                      ) : (
                        <span className="pub-row-title" title={it.title}>{it.title}</span>
                      )}
                      {it.hasSource ? (
                        <button
                          className={done ? "ana-decomp-btn done" : "ana-decomp-btn"}
                          onClick={() => void openDecompose(it)}
                        >
                          {done ? "查看拆解" : "拆解"}
                        </button>
                      ) : (
                        <button
                          className="ana-decomp-btn disabled"
                          disabled
                          title="该内容暂无原文（视频类没有文字原文，或原文还没采集到）。请先点右上角「同步数据」重新采集。"
                        >
                          无原文
                        </button>
                      )}
                    </span>
                    {metricCell(it.platform, "views", it.views, true)}
                    {metricCell(it.platform, "impressions", it.impressions)}
                    {metricCell(it.platform, "likes", it.likes)}
                    {metricCell(it.platform, "comments", it.comments)}
                    {metricCell(it.platform, "collects", it.collects)}
                    {metricCell(it.platform, "shares", it.shares)}
                    <span className="col-n">{it.metricDate.slice(5)}</span>
                  </div>
                  );
                })}
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
      ))}

      {tab === "lib" && (
        <>
          <div className="ana-section-title">爆款拆解库（共 {(lib || []).length} 条）</div>
          {(lib || []).length === 0 ? (
            <div className="pub-empty-card">
              <div className="pub-empty-ico">◫</div>
              <p>还没有拆解记录。</p>
              <p className="pub-empty-hint">在「效果数据」里对高阅读量内容点「拆解」，AI 会基于原文提炼它的优势点；编辑确认后「设为每日任务参考」，次日内容生产将复用其结构。</p>
            </div>
          ) : (
            <div className="pub-list">
              <div className="pub-head ana-lib-head">
                <span className="col-title">标题</span>
                <span className="col-n">渠道</span>
                <span className="col-n">阅读/播放</span>
                <span className="col-n">状态</span>
                <span className="col-act">操作</span>
              </div>
              {(lib || []).map((b) => (
                <div key={b.id} className="pub-row ana-lib-row">
                  <span className="col-title">
                    <span className="pub-row-title" title={b.title}>{b.title}</span>
                  </span>
                  <span className="col-n">
                    <span className={`acct-plat-badge ${b.platform}`}>
                      {PLATFORM_LABEL[b.platform] || b.platform}
                    </span>
                  </span>
                  <span className="col-n strong">{num(b.metricViews)}</span>
                  <span className="col-n">{({ draft: "草稿", edited: "已编辑", active: "参考中" } as Record<string, string>)[b.status] || b.status}</span>
                  <span className="col-act">
                    <button className="ana-decomp-btn" onClick={() => void openBreakdown(b)}>编辑</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {modal && (
        <div className="bd-modal-mask" onClick={() => setModal(null)}>
          <div className="bd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="bd-modal-head">
              <div>
                <div className="bd-modal-title">{modal.title}</div>
                <div className="bd-modal-sub">
                  {PLATFORM_LABEL[modal.platform] || modal.platform} · 阅读/播放 {num(modal.views)}
                  {modal.usedByCron ? " · 已设为每日任务参考" : ""}
                </div>
              </div>
              <button className="bd-modal-close" onClick={() => setModal(null)}>×</button>
            </div>
            <div className="bd-modal-body">
              {modalLoading ? (
                <div className="bd-loading">优势拆解生成中…（AI 正在读原文，约需数十秒）</div>
              ) : (
                <textarea
                  className="bd-editor"
                  value={modal.text}
                  onChange={(e) => setModal((m) => m ? { ...m, text: e.target.value } : m)}
                  placeholder="AI 从原文提炼的优势点将显示在这里，可人工二次编辑…"
                />
              )}
            </div>
            {modalMsg && <div className={modalMsg.ok ? "bd-modal-msg ok" : "bd-modal-msg"}>{modalMsg.text}</div>}
            <div className="bd-modal-foot">
              <button className={modal.usedByCron ? "ana-decomp-btn done" : "ana-decomp-btn"} disabled={modalLoading || !modal.id} onClick={() => void toggleCron()}>
                {modal.usedByCron ? "取消每日任务参考" : "设为每日任务参考"}
              </button>
              <button className="pub-refresh primary" disabled={modalLoading || !modal.id} onClick={() => void saveEdit()}>保存编辑</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
