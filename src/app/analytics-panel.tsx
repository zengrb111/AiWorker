"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ChinaProvinceMap from "./china-province-map";

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
  /** 各时间窗口的每内容增量（内容型平台：窗口内最新快照 − 窗口前快照）；微信生态无内容级数据为 null。
   *  cumulative = 累计（取每篇内容最新快照的真实值，不受采集断档影响）。 */
  byWindow?: {
    yesterday: WindowDelta | null;
    last7: WindowDelta | null;
    last30: WindowDelta | null;
    cumulative: WindowDelta | null;
  };
};

type WindowDelta = {
  views: number;
  likes: number;
  comments: number;
  collects: number;
  shares: number;
  metricDate: string;
};

type MetricsData = {
  ok: boolean;
  perPlatform?: PerPlatform[];
  siteDays?: SiteDay[];
  items?: MetricItem[];
  /** 非官网渠道的账号级日指标（公众号 / 视频号涨粉） */
  dailyMetrics?: DailyMetric[];
  accounts?: Array<{ id: string; platform: string; displayName: string; status: string; lastSyncAt?: string | null }>;
  /** 已授权渠道集合：效果分析只展示这些渠道 */
  authorizedPlatforms?: string[];
  syncedAt?: string | null;
  /** 时间窗口聚合：各渠道在 昨日 / 最近7天 / 最近30天 的流量矩阵；cumulative 为累计（最新快照原值） */
  windows?: {
    yesterday: Record<string, WindowVec & { name: string }>;
    last7: Record<string, WindowVec & { name: string }>;
    last30: Record<string, WindowVec & { name: string }>;
    cumulative: Record<string, WindowVec & { name: string }>;
  };
  /** 粉丝维度（用户维度 tab）：新增/累计粉丝数 + 地域分布 */
  fanStats?: {
    byPlatform: Array<{ platform: string; name: string; newFansYesterday: number; newFans7: number; newFans30: number; fansTotal: number }>;
    regions: Array<{ platform: string; name: string; metricDate: string; provinces: Array<{ province: string; fans: number }> }>;
  };
};

/** 时间窗口流量向量：阅读 / 点赞❤️ / 微信点赞👍 / 评论 / 分享 / 收藏 */
type WindowVec = {
  views: number;
  likes: number;
  wechatLikes: number;
  comments: number;
  shares: number;
  collects: number;
};

function num(n: number): string {
  return n.toLocaleString("en-US");
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

/**
 * 时间窗口流量矩阵里每个指标「哪些平台能提供」。
 * 内容型平台（xhs/toutiao/site）reading 取 views；微信生态（wechat/channels）reading 取 reads、
 * 微信点赞👍 取 wows（在看），且不提供评论/收藏 → 对应格显示「—」而非 0，避免误导。
 */
const WINDOW_METRIC_PLATFORMS: Record<keyof WindowVec, string[]> = {
  views: ["site", "xhs", "toutiao", "wechat", "channels"],
  likes: ["xhs", "toutiao", "wechat", "channels"],
  wechatLikes: ["wechat", "channels"],
  comments: ["xhs", "toutiao"],
  shares: ["xhs", "wechat", "channels"],
  collects: ["xhs", "toutiao"],
};

/** 流量矩阵要展示的 6 个维度（顺序即表格行序，图标即用户要求的表示法） */
const WINDOW_METRIC_ROWS: Array<{ key: keyof WindowVec; label: string; icon: string }> = [
  { key: "views", label: "阅读", icon: "📖" },
  { key: "likes", label: "点赞", icon: "❤️" },
  { key: "wechatLikes", label: "微信点赞", icon: "👍" },
  { key: "comments", label: "评论", icon: "💬" },
  { key: "shares", label: "分享", icon: "🔁" },
  { key: "collects", label: "收藏", icon: "⭐" },
];

const EMPTY_VEC: WindowVec = { views: 0, likes: 0, wechatLikes: 0, comments: 0, shares: 0, collects: 0 };

/** 流量矩阵单格：不支持该指标的平台显示「—」，否则显示数值 */
function winCell(platform: string, key: keyof WindowVec, v: WindowVec) {
  if (!WINDOW_METRIC_PLATFORMS[key].includes(platform)) {
    return (
      <span className="col-n na" title="该平台不提供此指标">
        —
      </span>
    );
  }
  return <span className="col-n">{num(v[key])}</span>;
}

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
  // 内容效果明细分页：每页 10 条
  const [detailPage, setDetailPage] = useState(1);
  const [detailJump, setDetailJump] = useState("");

  // 爆款拆解：子视图 + 拆解弹窗
  const [tab, setTab] = useState<"data" | "lib" | "user">("data");
  // 流量矩阵时间窗口筛选，默认「累计」（保证低频/断档采集的渠道如小红书的观看数始终可见）
  const [winWindow, setWinWindow] = useState<"yesterday" | "last7" | "last30" | "cumulative">("yesterday");
  // 用户维度 · 省级分布表格分页
  const [regionPage, setRegionPage] = useState(1);
  const [regionJump, setRegionJump] = useState("");
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
  // 只展示已授权渠道：未授权渠道的历史数据不再出现在效果分析里
  const authorizedSet = new Set<string>(
    data?.authorizedPlatforms || (data?.accounts || []).map((a) => a.platform),
  );
  const allItems = (data?.items || []).filter(
    (it) => authorizedSet.size === 0 || authorizedSet.has(it.platform),
  );

  const WIN_LABEL: Record<string, string> = { yesterday: "昨日", last7: "最近7天", last30: "最近30天", cumulative: "累计" };

  // 内容效果明细：随顶部时间窗口联动（真实 byWindow：窗口内最新快照 − 窗口前快照）。
  // windowAll = 该窗口内有增量的全部作品（不受渠道/搜索影响，用于 chips 计数）。
  // ⚠️ 兜底：小红书 / 头条号这类低频、断档采集的渠道，常常算不出某窗口的增量
  // （窗口前没有基准快照）。若窗口增量取不到，则回退到「累计」快照（route.ts 已为每个
  // 内容计算最新累计值），保证这些渠道的笔记始终在明细里可见；每行的「数据日期」会
  // 如实显示真实快照日期，不会误导。
  const windowAll = allItems
    .map((it) => ({ it, w: it.byWindow?.[winWindow] ?? it.byWindow?.cumulative ?? null }))
    .filter((x) => x.w !== null);
  const filtered = windowAll.filter(({ it }) => {
    if (channel !== "all" && it.platform !== channel) return false;
    if (query && !it.title.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
  const detailList = [...filtered].sort((a, b) => b.w!.views - a.w!.views);
  const DETAIL_PAGE_SIZE = 10;
  const detailTotalPages = Math.max(1, Math.ceil(detailList.length / DETAIL_PAGE_SIZE));
  const safeDetailPage = Math.min(detailPage, detailTotalPages);
  const items = detailList.slice(
    (safeDetailPage - 1) * DETAIL_PAGE_SIZE,
    safeDetailPage * DETAIL_PAGE_SIZE,
  );
  // 最近一次采集日期（用于空状态提示，避免用户误以为页面坏了）
  const latestMetricDate = allItems.reduce((m, it) => (it.metricDate > m ? it.metricDate : m), "");

  // 时间窗口流量矩阵：各渠道在 昨日 / 最近7天 / 最近30天 的 6 维流量。
  const windows = data?.windows;
  const fanStats = data?.fanStats;
  // 矩阵要展示的渠道集合：**只取已授权渠道**（未授权的一律不出现）
  const matrixPlatforms = (() => {
    const order = ["site", "xhs", "toutiao", "wechat", "channels", "healing", "aiworker"];
    const set = new Set<string>();
    if (authorizedSet.size > 0) {
      for (const p of authorizedSet) set.add(p);
    } else {
      // 兜底：拿不到授权信息时（未登录/接口异常）用有数据的渠道，避免白屏
      if (windows) {
        for (const w of [windows.yesterday, windows.last7, windows.last30]) {
          for (const k of Object.keys(w)) set.add(k);
        }
      }
      for (const p of perPlatform) set.add(p.platform);
    }
    return [...set].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  })();
  const vecOf = (w: Record<string, WindowVec & { name: string }> | undefined, platform: string): WindowVec & { name: string } =>
    (w && w[platform]) || { ...EMPTY_VEC, name: PLATFORM_LABEL[platform] || platform };

  return (
    <div className="pub-root">
      <div className="pub-toolbar">
        <div className="pub-title-group">
          <h2>效果分析</h2>
          <p className="pub-subtitle">已授权渠道的真实投放效果（未授权渠道不展示）</p>
        </div>
        <div className="ana-tabs">
          <button className={tab === "data" ? "ana-tab active" : "ana-tab"} onClick={() => setTab("data")}>流量维度</button>
          <button className={tab === "user" ? "ana-tab active" : "ana-tab"} onClick={() => setTab("user")}>用户维度</button>
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
          {/* 流量矩阵：单列表，按时间窗口筛选（默认昨日） */}
          <div className="ana-section-title">各渠道流量矩阵（阅读 📖 / 点赞 ❤️ / 微信点赞 👍 / 评论 💬 / 分享 🔁 / 收藏 ⭐）</div>
          {windows ? (
            <>
              <div className="ana-win-filter">
                <span className="ana-win-filter-label">时间范围</span>
                <button className={winWindow === "yesterday" ? "ana-win-seg on" : "ana-win-seg"} onClick={() => setWinWindow("yesterday")}>昨日</button>
                <button className={winWindow === "last7" ? "ana-win-seg on" : "ana-win-seg"} onClick={() => setWinWindow("last7")}>最近7天</button>
                <button className={winWindow === "last30" ? "ana-win-seg on" : "ana-win-seg"} onClick={() => setWinWindow("last30")}>最近30天</button>
              </div>
              <table className="ana-win-list">
                <thead>
                  <tr>
                    <th className="ana-win-list-ch">渠道</th>
                    {WINDOW_METRIC_ROWS.map((m) => (
                      <th key={m.key} title={m.label}>
                        <span className="ana-win-list-ico">{m.icon}</span>
                        <span className="ana-win-list-th-label">{m.label}</span>
                      </th>
                    ))}
                    <th className="ana-win-list-cn">内容数</th>
                  </tr>
                </thead>
                <tbody>
                  {matrixPlatforms.map((platform) => {
                    const wv = windows?.[winWindow]?.[platform];
                    const hasWinData = !!wv;
                    const v = vecOf(windows[winWindow], platform);
                    const contents = perPlatform.find((p) => p.platform === platform)?.contents ?? 0;
                    return (
                      <tr key={platform}>
                        <td className="ana-win-list-ch">
                          <span className={`acct-plat-badge ${platform}`}>{PLATFORM_LABEL[platform] || platform}</span>
                        </td>
                        {WINDOW_METRIC_ROWS.map((m) => (
                          <td key={m.key}>
                            {hasWinData ? (
                              winCell(platform, m.key, v)
                            ) : (
                              <span className="col-n na" title="该渠道在所选时间范围内还没有采集到数据">—</span>
                            )}
                          </td>
                        ))}
                        <td className="ana-win-list-cn">{num(contents)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!matrixPlatforms.some((p) => windows?.[winWindow]?.[p]) && (
                <p className="pub-empty-hint" style={{ margin: "10px 2px 0" }}>
                  所选时间范围（{WIN_LABEL[winWindow]}）暂时没有采集数据。可切换到「最近7天 / 最近30天」查看，或点右上角「同步数据」。
                </p>
              )}
            </>
          ) : (
            <div className="pub-empty">暂无时间窗口数据，点右上角「同步数据」后查看。</div>
          )}

          {allItems.length > 0 && (
            <>
              <div className="ana-section-title">
                内容效果明细 · {WIN_LABEL[winWindow]}
                <span className="ana-demo-sub">
                  （共 {detailList.length} 条{channel !== "all" || query ? ` / 全部 ${windowAll.length} 条` : ""}）
                </span>
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
                  )
                    // 只列已授权渠道（同矩阵口径）
                    .filter(([key]) => key === "all" || authorizedSet.size === 0 || authorizedSet.has(key))
                    .map(([key, label]) => (
                    <button
                      key={key}
                      className={`ana-chip ${channel === key ? "on" : ""}`}
                      onClick={() => {
                        setChannel(key);
                        setDetailPage(1);
                      }}
                    >
                      {label}
                      <span className="ana-chip-n">
                        {key === "all"
                          ? windowAll.length
                          : windowAll.filter(({ it }) => it.platform === key).length}
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
                    setDetailPage(1);
                  }}
                />
              </div>
              <div className="pub-list">
                <div className="pub-head ana-head ana-cols-detail">
                  <span className="col-plat">渠道</span>
                  <span className="col-title">标题</span>
                  <span className="col-n">阅读</span>
                  <span className="col-n">点赞</span>
                  <span className="col-n">评论</span>
                  <span className="col-n">收藏</span>
                  <span className="col-n">分享</span>
                  <span className="col-n">数据日期</span>
                </div>
                {items.map(({ it, w }) => {
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
                      {metricCell(it.platform, "views", w!.views, true)}
                      {metricCell(it.platform, "likes", w!.likes)}
                      {metricCell(it.platform, "comments", w!.comments)}
                      {metricCell(it.platform, "collects", w!.collects)}
                      {metricCell(it.platform, "shares", w!.shares)}
                      <span className="col-n">{w!.metricDate.slice(5)}</span>
                    </div>
                  );
                })}
                {items.length === 0 && (
                  <div className="ana-no-match">
                    {WIN_LABEL[winWindow]}没有新增作品数据
                    {latestMetricDate ? `（最近一次采集：${latestMetricDate}）` : ""}。
                    可切换上方时间范围查看「最近7天 / 最近30天」，或点右上角「同步数据」重新采集。
                  </div>
                )}
              </div>
              {detailList.length > DETAIL_PAGE_SIZE && (
                <div className="ana-detail-pager">
                  <button
                    disabled={safeDetailPage <= 1}
                    onClick={() => setDetailPage(safeDetailPage - 1)}
                    aria-label="上一页"
                  >
                    ‹
                  </button>
                  <span className="ana-pageno">{safeDetailPage} / {detailTotalPages}</span>
                  <button
                    disabled={safeDetailPage >= detailTotalPages}
                    onClick={() => setDetailPage(safeDetailPage + 1)}
                    aria-label="下一页"
                  >
                    ›
                  </button>
                  <input
                    value={detailJump}
                    onChange={(e) => setDetailJump(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const n = parseInt(detailJump, 10);
                        if (Number.isFinite(n)) setDetailPage(Math.max(1, Math.min(detailTotalPages, n)));
                        setDetailJump("");
                      }
                    }}
                    placeholder="页码"
                  />
                  <button
                    onClick={() => {
                      const n = parseInt(detailJump, 10);
                      if (Number.isFinite(n)) setDetailPage(Math.max(1, Math.min(detailTotalPages, n)));
                      setDetailJump("");
                    }}
                  >
                    跳转
                  </button>
                </div>
              )}
            </>
          )}
        </>
      ))}

      {tab === "user" && (() => {
        const hasData = !!(fanStats && (fanStats.byPlatform?.length || fanStats.regions?.length));
        if (!hasData) {
          return (
            <>
              <div className="ana-section-title">用户维度 · 粉丝增长与地域分布</div>
              <div className="pub-empty-card">
                <div className="pub-empty-ico">👥</div>
                <p>还没有粉丝数据。</p>
                <p className="pub-empty-hint">
                  粉丝数据来自微信生态（公众号 / 视频号）后台「用户分析」。请先在「平台授权管理」确认公众号登录态有效
                  （Cookie 过期需重新授权），再点右上角「同步数据」。采集成功后，这里会显示新增粉丝、累计粉丝与省级分布。
                </p>
              </div>
            </>
          );
        }
        const fs = fanStats!;
        const newFansOf = (p: any) =>
          winWindow === "yesterday" ? p.newFansYesterday : winWindow === "last7" ? p.newFans7 : p.newFans30;
        // 全渠道合计
        const totalNewFans = fs.byPlatform.reduce(
          (s: number, p: any) => s + (p.hasData === false ? 0 : Number(newFansOf(p)) || 0),
          0,
        );
        const totalFansAll = fs.byPlatform.reduce((s: number, p: any) => s + (Number(p.fansTotal) || 0), 0);
        const regionFansOf = (pr: any) => pr.fans ?? 0;
        // 合并各渠道：同一省份的粉丝数跨渠道相加
        const mergedMap = new Map<string, number>();
        for (const r of fs.regions) {
          for (const pr of r.provinces) {
            mergedMap.set(pr.province, (mergedMap.get(pr.province) ?? 0) + regionFansOf(pr));
          }
        }
        const mergedRegions = [...mergedMap.entries()]
          .map(([province, fans]) => ({ province, fans }))
          .filter((x) => x.fans > 0)
          .sort((a, b) => b.fans - a.fans);
        const totalRegionFans = mergedRegions.reduce((s, x) => s + x.fans, 0);
        const REGION_PAGE_SIZE = 10;
        const totalPages = Math.max(1, Math.ceil(mergedRegions.length / REGION_PAGE_SIZE));
        const safePage = Math.min(regionPage, totalPages);
        const pageRegions = mergedRegions.slice((safePage - 1) * REGION_PAGE_SIZE, safePage * REGION_PAGE_SIZE);
        return (
          <>
            <div className="ana-section-title">用户维度 · 粉丝增长与地域分布</div>

            {/* 时间筛选：与「流量维度」tab 一致，默认昨日 */}
            <div className="ana-win-filter">
              <span className="ana-win-filter-label">时间范围</span>
              <button className={winWindow === "yesterday" ? "ana-win-seg on" : "ana-win-seg"} onClick={() => setWinWindow("yesterday")}>昨日</button>
              <button className={winWindow === "last7" ? "ana-win-seg on" : "ana-win-seg"} onClick={() => setWinWindow("last7")}>最近7天</button>
              <button className={winWindow === "last30" ? "ana-win-seg on" : "ana-win-seg"} onClick={() => setWinWindow("last30")}>最近30天</button>
            </div>

            {/* 粉丝增长：单列表（渠道为行，不再每渠道分一块） */}
            <div className="ana-section-title">粉丝增长（{WIN_LABEL[winWindow]}新增）</div>
            <div className="ana-user-list">
              <div className="ana-user-row ana-user-head-row">
                <span className="col-plat">渠道</span>
                <span className="col-n">新增粉丝 · {WIN_LABEL[winWindow]}</span>
                <span className="col-n">累计粉丝数</span>
              </div>
              {fs.byPlatform.map((p: any) => (
                <div key={p.platform} className="ana-user-row">
                  <span className="col-plat">
                    <span className={`acct-plat-badge ${p.platform}`}>{p.name}</span>
                  </span>
                  <span className="col-n strong">{p.hasData === false ? "—" : num(newFansOf(p))}</span>
                  <span className="col-n ok">{p.fansTotal > 0 ? num(p.fansTotal) : "—"}</span>
                </div>
              ))}
              {fs.byPlatform.length > 1 && (
                <div className="ana-user-row ana-user-total-row">
                  <span className="col-plat">全渠道合计</span>
                  <span className="col-n strong">{num(totalNewFans)}</span>
                  <span className="col-n ok">{totalFansAll > 0 ? num(totalFansAll) : "—"}</span>
                </div>
              )}
            </div>

            {/* 省级分布：合并各渠道后，左侧地图 + 右侧地域/用户数/占比表。
                即使暂时没有地域数据也把地图渲染出来（叠加占位提示），避免整块消失。 */}
            {(
              <>
                <div className="ana-section-title">
                  省级分布（已合并各渠道）
                  {fs.regions[0]?.metricDate ? `（${fs.regions[0].metricDate} 快照）` : ""}
                </div>
                <div className="ana-region-card">
                  <div className="ana-region-map">
                    <ChinaProvinceMap data={mergedRegions.map((x) => ({ name: x.province, value: x.fans }))} />
                    {mergedRegions.length === 0 && (
                      <div className="ana-region-empty">
                        暂无地域数据
                        <span>公众号「用户属性」采集到省份分布后会自动着色</span>
                      </div>
                    )}
                  </div>
                  <div className="ana-region-table-wrap">
                    <table className="ana-region-table">
                      <thead>
                        <tr>
                          <th>地域</th>
                          <th>用户数</th>
                          <th>占比</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRegions.map((x) => (
                          <tr key={x.province}>
                            <td className="rg-name">{x.province}</td>
                            <td className="rg-num">{num(x.fans)}</td>
                            <td className="rg-pct">
                              {totalRegionFans > 0 ? ((x.fans / totalRegionFans) * 100).toFixed(2) : "0.00"}%
                            </td>
                          </tr>
                        ))}
                        {pageRegions.length === 0 && (
                          <tr>
                            <td colSpan={3} className="rg-empty">暂无地域数据</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    {mergedRegions.length > 0 && (
                    <div className="ana-region-pager">
                      <button disabled={safePage <= 1} onClick={() => setRegionPage(safePage - 1)} aria-label="上一页">‹</button>
                      <span className="ana-region-pageno">{safePage} / {totalPages}</span>
                      <button disabled={safePage >= totalPages} onClick={() => setRegionPage(safePage + 1)} aria-label="下一页">›</button>
                      <input
                        className="ana-region-jump"
                        value={regionJump}
                        onChange={(e) => setRegionJump(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const n = parseInt(regionJump, 10);
                            if (Number.isFinite(n)) setRegionPage(Math.max(1, Math.min(totalPages, n)));
                            setRegionJump("");
                          }
                        }}
                        placeholder="页码"
                      />
                      <button
                        onClick={() => {
                          const n = parseInt(regionJump, 10);
                          if (Number.isFinite(n)) setRegionPage(Math.max(1, Math.min(totalPages, n)));
                          setRegionJump("");
                        }}
                      >
                        跳转
                      </button>
                    </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        );
      })()}

      {tab === "lib" && (
        <>
          <div className="ana-section-title">爆款拆解库（共 {(lib || []).length} 条）</div>
          {(lib || []).length === 0 ? (
            <div className="pub-empty-card">
              <div className="pub-empty-ico">◫</div>
              <p>还没有拆解记录。</p>
              <p className="pub-empty-hint">在「流量维度」里对高阅读量内容点「拆解」，AI 会基于原文提炼它的优势点；编辑确认后「设为每日任务参考」，次日内容生产将复用其结构。</p>
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
