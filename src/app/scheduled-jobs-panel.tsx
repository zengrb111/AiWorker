"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 「定时任务」面板。
 *
 * 设计上对标 WorkBuddy 的「自动化」，只把通知对象从企业微信换成平台自己的微信通道。
 * 最关键的一条沿用它的经验：**执行结果和通知结果是两件事**——通知失败不影响任务
 * 执行，所以每条任务下面把「执行」和「微信通知」分成两行显示，出了问题是哪一环
 * 一眼能看出来，不用去读一大段文本。
 *
 * 数据来源：GET /api/scheduled-jobs（服务端已算好 nextRunAt）、
 * GET /api/wechat/channel-health（通道是否真通）。
 */

type JobItem = {
  id: string;
  name: string;
  enabled: boolean;
  runOnce: boolean;
  oneShotAt: string | null;
  notifyWechat: boolean;
  cronExpr: string;
  timezone: string;
  prompt: string;
  /** TEXT | VIDEO —— 视频任务到点直接走 huashu-motion 出片并写进内容库 */
  kind: string | null;
  videoSiteUrl: string | null;
  videoImagesJson: string | null;
  videoTargetSeconds: number | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastResult: string | null;
  runCount: number;
  nextRunAt: string | null;
  createdAt: string;
};

type JobRun = {
  id: string;
  status: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  result: string | null;
  error: string | null;
};

type ChannelHealth = {
  ok: boolean;
  botId: string | null;
  accountId: string | null;
  problems: string[];
};

type Freq = "daily" | "weekly" | "monthly" | "custom";

type Draft = {
  id?: string;
  name: string;
  prompt: string;
  /** TEXT | VIDEO */
  kind: "TEXT" | "VIDEO";
  /** 视频任务：产品网站（与参考图至少一个） */
  videoSiteUrl: string;
  /** 视频任务：参考图 URL，一行一个 */
  videoImages: string;
  /** 视频任务：目标时长（秒），null=默认 20 */
  videoTargetSeconds: number | null;
  freq: Freq;
  time: string;
  weekdays: number[];
  monthday: string;
  cronExpr: string;
  runOnce: boolean;
  oneShotAt: string;
  notifyWechat: boolean;
  /**
   * 编辑时带上的只读运行信息。
   *
   * 为什么要放进表单：存量任务的差异几乎都在这里——同名任务可能一个跑了 7 次、
   * 一个从没跑过；上次结果里还藏着「执行成功但通知没送到」。编辑时看不到这些，
   * 就只能靠记忆判断该改什么。
   */
  meta?: {
    enabled: boolean;
    createdAt: string;
    runCount: number;
    lastRunAt: string | null;
    lastStatus: string | null;
    lastError: string | null;
    lastResult: string | null;
    timezone: string;
    runOnce: boolean;
    oneShotAt: string | null;
    notifyWechat: boolean;
  };
};

const WEEK_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const EMPTY_DRAFT: Draft = {
  name: "",
  prompt: "",
  kind: "TEXT",
  videoSiteUrl: "",
  videoImages: "",
  videoTargetSeconds: null,
  freq: "daily",
  time: "09:00",
  weekdays: [1, 2, 3, 4, 5],
  monthday: "1",
  cronExpr: "",
  runOnce: false,
  oneShotAt: "",
  notifyWechat: true
};

async function request<T>(path: string, init?: RequestInit, timeoutMs = 20000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
    });
    const payload = (await res.json()) as { ok?: boolean; data?: T; error?: string };
    if (!payload.ok) throw new Error(payload.error || `请求失败（${res.status}）`);
    return payload.data as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("请求超时，请稍后重试。");
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

/** 毫秒 → 「1 分 20 秒」这种给人看的耗时。 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function pad(n: number | string): string {
  return String(n).padStart(2, "0");
}

/** cron → 「每天 17:30」这种给人看的话。 */
function describeCron(cronExpr: string): string {
  const parts = (cronExpr || "").trim().split(/\s+/);
  if (parts.length !== 5) return cronExpr;
  const [m, h, dom, mon, dow] = parts;
  const hm = `${pad(h)}:${pad(m)}`;
  if (dom === "*" && mon === "*" && dow === "*") return `每天 ${hm}`;
  if (dom === "*" && mon === "*" && dow !== "*") {
    const labels = dow
      .split(",")
      .map((d) => WEEK_LABELS[Number(d) % 7] ?? d)
      .join("、");
    return `每${labels.replace(/^每/, "")} ${hm}`;
  }
  if (dom !== "*" && mon === "*" && dow === "*") return `每月 ${dom} 号 ${hm}`;
  return `${cronExpr}（${hm}）`;
}

/** 把已有 cron 反解成表单状态，编辑时不用重新选一遍。 */
function parseCron(cronExpr: string): Pick<Draft, "freq" | "time" | "weekdays" | "monthday" | "cronExpr"> {
  const parts = (cronExpr || "").trim().split(/\s+/);
  if (parts.length !== 5) {
    return { freq: "custom", time: "09:00", weekdays: [1, 2, 3, 4, 5], monthday: "1", cronExpr };
  }
  const [m, h, dom, mon, dow] = parts;
  const time = `${pad(h)}:${pad(m)}`;
  if (dom === "*" && mon === "*" && dow === "*") {
    return { freq: "daily", time, weekdays: [1, 2, 3, 4, 5], monthday: "1", cronExpr };
  }
  if (dom === "*" && mon === "*" && dow !== "*") {
    return {
      freq: "weekly",
      time,
      weekdays: dow.split(",").map((d) => Number(d) % 7),
      monthday: "1",
      cronExpr
    };
  }
  if (dom !== "*" && mon === "*" && dow === "*") {
    return { freq: "monthly", time, weekdays: [1, 2, 3, 4, 5], monthday: dom, cronExpr };
  }
  return { freq: "custom", time, weekdays: [1, 2, 3, 4, 5], monthday: "1", cronExpr };
}

function buildCron(draft: Draft): string {
  if (draft.freq === "custom") return draft.cronExpr.trim();
  const [h, m] = (draft.time || "09:00").split(":");
  if (draft.freq === "daily") return `${Number(m)} ${Number(h)} * * *`;
  if (draft.freq === "weekly") {
    const days = draft.weekdays.length ? draft.weekdays.join(",") : "1,2,3,4,5";
    return `${Number(m)} ${Number(h)} * * ${days}`;
  }
  return `${Number(m)} ${Number(h)} ${Number(draft.monthday) || 1} * *`;
}

/** UTC ISO → 本地 datetime-local 输入值（YYYY-MM-DDTHH:MM）。 */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const off = d.getTimezoneOffset(); // 本地相对 UTC 的分钟偏移（东八区为 -480）
  const local = new Date(d.getTime() - off * 60000); // 平移为本地 wall-clock
  return local.toISOString().slice(0, 16);
}

/** 本地 datetime-local 输入值 → UTC ISO（无时区后缀时按本地时区解析）。 */
function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** `2026-10-23T09:00:00+08:00` → 「明天 09:00」。 */
function formatRunAt(iso: string | null, timezone: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone || "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const dayFmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone || "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit"
  });
  const time = fmt.format(date);
  const sameDay = dayFmt.format(date) === dayFmt.format(now);
  if (sameDay) return `今天 ${time}`;
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (dayFmt.format(date) === dayFmt.format(tomorrow)) return `明天 ${time}`;
  return `${dayFmt.format(date)} ${time}`;
}

/** 完整日期时间，用于「创建时间」这类需要精确值的字段。 */
function formatDateTime(iso: string | null, timeZone = "Asia/Shanghai"): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timeZone || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(iso));
}

/**
 * 把 lastResult 拆成「正文 / 通知结果」。
 *
 * 目前通知结果是拼在正文末尾的一行（`✅ 微信通知已送达` / `⚠️ 微信通知未送达：原因`）。
 * 这是历史写法，先按约定解析；后续给 ScheduledJob 加结构化字段后可以直接读字段。
 */
function splitResult(lastResult: string | null): {
  body: string;
  notify: { ok: boolean; text: string } | null;
} {
  const text = (lastResult || "").trim();
  if (!text) return { body: "", notify: null };
  const bad = text.match(/\n*⚠️ 微信通知未送达：([\s\S]*)$/);
  if (bad) return { body: text.slice(0, bad.index).trim(), notify: { ok: false, text: bad[1].trim() } };
  const ok = text.match(/\n*✅ 微信通知已送达\s*$/);
  if (ok) return { body: text.slice(0, ok.index).trim(), notify: { ok: true, text: "已送达" } };
  return { body: text, notify: null };
}

function summarize(text: string, max = 90): string {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export default function ScheduledJobsPanel({ resetToken }: { resetToken: number }) {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [channel, setChannel] = useState<ChannelHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  /** 参考图上传中（视频任务） */
  const [uploadingImages, setUploadingImages] = useState(false);
  /** 展开看运行记录的任务 id（同时只展开一条） */
  const [historyJobId, setHistoryJobId] = useState<string | null>(null);
  const [historyRuns, setHistoryRuns] = useState<JobRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await request<{ jobs: JobItem[] }>("/api/scheduled-jobs");
      setJobs(data.jobs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载定时任务失败。");
    } finally {
      setLoading(false);
    }
    // 通道状态单独取：它失败不该把整个列表拖成空白。
    try {
      setChannel(await request<ChannelHealth>("/api/wechat/channel-health", undefined, 8000));
    } catch {
      setChannel(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, resetToken]);

  const stats = useMemo(() => {
    const on = jobs.filter((j) => j.enabled).length;
    const off = jobs.length - on;
    // 「今日」按任务自己的时区算：nextRunAt 是 ISO（UTC），直接切前 10 位在北京时间
    // 凌晨会算成前一天，所以用 en-CA（YYYY-MM-DD）按 timezone 格式化后比较。
    const dayKey = (date: Date, timeZone: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timeZone || "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(date);
    const now = new Date();
    const today = jobs.filter(
      (j) => j.enabled && j.nextRunAt && dayKey(new Date(j.nextRunAt), j.timezone) === dayKey(now, j.timezone)
    ).length;
    return { on, off, today };
  }, [jobs]);

  function openCreate() {
    setDraft({ ...EMPTY_DRAFT });
  }

  function openEdit(job: JobItem) {
    setDraft({
      id: job.id,
      name: job.name,
      prompt: job.prompt,
      kind: (job.kind || "").toUpperCase() === "VIDEO" ? "VIDEO" : "TEXT",
      videoSiteUrl: job.videoSiteUrl ?? "",
      videoImages: (() => {
        try {
          const parsed = JSON.parse(job.videoImagesJson || "[]");
          return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string").join("\n") : "";
        } catch {
          return "";
        }
      })(),
      videoTargetSeconds: job.videoTargetSeconds ?? null,
      ...parseCron(job.cronExpr),
      runOnce: job.runOnce,
      oneShotAt: isoToLocalInput(job.oneShotAt),
      notifyWechat: job.notifyWechat !== false,
      meta: {
        enabled: job.enabled,
        createdAt: job.createdAt ?? "",
        runCount: job.runCount,
        lastRunAt: job.lastRunAt,
        lastStatus: job.lastStatus,
        lastError: job.lastError,
        lastResult: job.lastResult,
        timezone: job.timezone,
        runOnce: job.runOnce,
        oneShotAt: job.oneShotAt,
        notifyWechat: job.notifyWechat !== false
      }
    });
  }

  const videoImageList = useMemo(
    () => (draft ? draft.videoImages.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) : []),
    [draft]
  );

  /** 上传参考图：传完直接拼进 videoImages，缩略图随之回显。 */
  async function uploadReferenceImages(files: FileList | null) {
    if (!draft || !files || files.length === 0) return;
    const remain = Math.max(0, 6 - videoImageList.length);
    if (remain === 0) {
      showToast("参考图最多 6 张");
      return;
    }
    setUploadingImages(true);
    try {
      const form = new FormData();
      Array.from(files).slice(0, remain).forEach((file) => form.append("file", file));
      const res = await fetch("/api/uploads/images", { method: "POST", body: form });
      const payload = (await res.json()) as { ok?: boolean; data?: { urls?: string[] }; error?: string };
      if (!payload.ok || !payload.data?.urls?.length) {
        throw new Error(payload.error || "上传失败。");
      }
      setDraft((current) =>
        current
          ? {
              ...current,
              videoImages: [...videoImageList, ...payload.data!.urls!].slice(0, 6).join("\n")
            }
          : current
      );
      showToast(`已上传 ${payload.data.urls.length} 张`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "上传失败。");
    } finally {
      setUploadingImages(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  }

  function removeReferenceImage(url: string) {
    setDraft((current) =>
      current
        ? {
            ...current,
            videoImages: current.videoImages
              .split(/[\n,]/)
              .map((item) => item.trim())
              .filter((item) => item && item !== url)
              .join("\n")
          }
        : current
    );
  }

  async function save() {
    if (!draft) return;
    const name = draft.name.trim();
    const prompt = draft.prompt.trim();
    if (!name) {
      showToast("先填任务名称");
      return;
    }
    if (!prompt) {
      showToast(draft.kind === "VIDEO" ? "请填写创作需求（会作为产品名称）" : "执行内容不能为空");
      return;
    }
    const videoImages = draft.videoImages
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 6);
    if (draft.kind === "VIDEO") {
      const site = draft.videoSiteUrl.trim();
      if (site && !/^https?:\/\//i.test(site)) {
        showToast("产品网站需以 http:// 或 https:// 开头");
        return;
      }
      // 素材（网站/参考图）都是可选的：提示词是主输入，AI 会先选题再出片
    }
    if (!draft.runOnce && draft.freq === "weekly" && draft.weekdays.length === 0) {
      showToast("至少选一天");
      return;
    }
    if (draft.runOnce) {
      if (!draft.oneShotAt) {
        showToast("请填写一次性任务的执行时间");
        return;
      }
      const at = localInputToIso(draft.oneShotAt);
      if (!at || new Date(at).getTime() <= Date.now()) {
        showToast("执行时间必须晚于当前时间");
        return;
      }
    }
    const cronExpr = draft.runOnce ? "0 0 1 1 *" : buildCron(draft);
    const body: Record<string, unknown> = {
      name,
      prompt,
      cronExpr,
      runOnce: draft.runOnce,
      notifyWechat: draft.notifyWechat,
      kind: draft.kind,
      videoSiteUrl: draft.kind === "VIDEO" ? draft.videoSiteUrl.trim() : "",
      videoImages: draft.kind === "VIDEO" ? videoImages : [],
      videoTargetSeconds: draft.kind === "VIDEO" ? draft.videoTargetSeconds : null
    };
    if (draft.runOnce) body.oneShotAt = localInputToIso(draft.oneShotAt);
    setSaving(true);
    try {
      if (draft.id) {
        await request(`/api/scheduled-jobs/${draft.id}`, {
          method: "PATCH",
          // 不带 enabled：编辑内容不该顺手把「已暂停」的任务改回运行。
          body: JSON.stringify(body)
        });
        showToast("已保存");
      } else {
        await request("/api/scheduled-jobs", {
          method: "POST",
          body: JSON.stringify({ ...body, enabled: true })
        });
        showToast("已创建并启用");
      }
      setDraft(null);
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function toggleJob(job: JobItem) {
    setBusyId(job.id);
    try {
      await request(`/api/scheduled-jobs/${job.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !job.enabled })
      });
      showToast(job.enabled ? "已暂停，到点不再执行" : "已启用");
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(job: JobItem) {
    setBusyId(job.id);
    try {
      await request(`/api/scheduled-jobs/${job.id}/run`, { method: "POST" });
      showToast(`已触发「${job.name}」，稍后刷新看结果`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "触发失败");
    } finally {
      setBusyId(null);
    }
  }

  /**
   * 展开/收起某条任务的运行记录。
   *
   * 每次展开都重新拉：定时任务可能在后台刚跑完，缓存反而会让人看到旧数据。
   */
  async function toggleHistory(job: JobItem) {
    if (historyJobId === job.id) {
      setHistoryJobId(null);
      setHistoryRuns([]);
      return;
    }
    setHistoryJobId(job.id);
    setHistoryRuns([]);
    setHistoryLoading(true);
    try {
      const data = await request<{ runs: JobRun[] }>(`/api/scheduled-jobs/${job.id}/runs?limit=20`);
      setHistoryRuns(data.runs || []);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "读取运行记录失败");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function removeJob(job: JobItem) {
    if (confirmDeleteId !== job.id) {
      setConfirmDeleteId(job.id);
      window.setTimeout(() => setConfirmDeleteId((cur) => (cur === job.id ? null : cur)), 4000);
      return;
    }
    setBusyId(job.id);
    try {
      await request(`/api/scheduled-jobs/${job.id}`, { method: "DELETE" });
      showToast("已删除");
      setConfirmDeleteId(null);
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  }

  const channelOk = channel?.ok === true;

  /** 编辑时展示的当前数据（含上次结果的执行/通知拆分）。 */
  const editMeta = draft?.meta
    ? { ...draft.meta, ...splitResult(draft.meta.lastResult) }
    : null;

  return (
    <section className="sj-root">
      <div className="sj-head">
        <div className="sj-head-text">
          <h2>定时任务</h2>
          <p>到点由平台调度执行你的 AI 员工，结果直接推送到微信 · 执行与通知分开核对</p>
        </div>
        <div className="sj-head-actions">
          <button className="sj-btn" onClick={() => void refresh()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
          <button className="sj-btn primary" onClick={openCreate}>
            新建任务
          </button>
        </div>
      </div>

      <div className="sj-stats">
        <div className="sj-stat">
          <b>{stats.on}</b>
          <span>运行中</span>
          <em className="sj-note ok">按时执行</em>
        </div>
        <div className="sj-stat">
          <b>{stats.off}</b>
          <span>已暂停</span>
          <em className="sj-note">到点不执行</em>
        </div>
        <div className="sj-stat">
          <b>{stats.today}</b>
          <span>今日待执行</span>
          <em className="sj-note">按分钟轮询</em>
        </div>
        <div className="sj-stat">
          <b className="sj-stat-word">
            {channel ? (channelOk ? "微信 · 已连接" : "微信 · 通道异常") : "微信 · 未绑定"}
          </b>
          <span>通知通道</span>
          <em className={`sj-note ${channel && !channelOk ? "bad" : ""}`}>
            {channel?.botId ? `机器人 ${channel.botId}` : channel ? "前往个人中心绑定" : "状态未知"}
          </em>
        </div>
      </div>

      {error && <p className="sj-error">{error}</p>}

      {channel && !channelOk && jobs.some((j) => j.enabled) && (
        <div className="sj-channel-warn">
          <strong>微信通道未连通，任务照常执行但通知发不出去</strong>
          <p>{channel.problems.join(" ")}</p>
          <p>到「个人中心 → 微信绑定」重新绑定后，通知会恢复正常。</p>
        </div>
      )}

      <div className="sj-list">
        {loading && !jobs.length && <div className="sj-empty">加载中…</div>}
        {!loading && !jobs.length && (
          <div className="sj-empty">
            <strong>还没有定时任务</strong>
            <p>也可以直接在微信里跟 AI 员工说「每天早上 9 点帮我做 XX」，任务会出现在这里。</p>
          </div>
        )}

        {jobs.map((job) => {
          const { body, notify } = splitResult(job.lastResult);
          // 通知开关关掉的任务不算「坏」：没送达是主动选择，不是故障。
          const notifyBroken = notify && job.notifyWechat !== false ? !notify.ok : false;
          return (
            <article
              key={job.id}
              className={`sj-job${job.enabled ? "" : " paused"}${notifyBroken ? " broken" : ""}`}
            >
              <div className="sj-job-head">
                <h3>{job.name}</h3>
                <span className={`sj-badge ${job.enabled ? "on" : "off"}`}>
                  {job.enabled ? "运行中" : "已暂停"}
                </span>
                <div className="sj-job-actions">
                  <button
                    className={`sj-btn sm ghost${historyJobId === job.id ? " active" : ""}`}
                    onClick={() => void toggleHistory(job)}
                  >
                    {historyJobId === job.id ? "收起记录" : "运行记录"}
                  </button>
                  <button
                    className="sj-btn sm ghost"
                    disabled={busyId === job.id}
                    onClick={() => void runNow(job)}
                  >
                    立即执行
                  </button>
                  <button
                    className="sj-btn sm ghost"
                    disabled={busyId === job.id}
                    onClick={() => void toggleJob(job)}
                  >
                    {job.enabled ? "暂停" : "启用"}
                  </button>
                  <button className="sj-btn sm ghost" onClick={() => openEdit(job)}>
                    编辑
                  </button>
                  <button
                    className={`sj-btn sm ghost danger${confirmDeleteId === job.id ? " armed" : ""}`}
                    disabled={busyId === job.id}
                    onClick={() => void removeJob(job)}
                  >
                    {confirmDeleteId === job.id ? "确认删除？" : "删除"}
                  </button>
                </div>
              </div>

              <div className="sj-job-meta">
                <span>
                  <i>类型</i> {(job.kind || "").toUpperCase() === "VIDEO" ? "视频任务（huashu-motion）" : "文字任务"}
                </span>
                <span>
                  <i>频率</i> {job.runOnce ? "仅执行一次" : describeCron(job.cronExpr)}
                </span>
                <span>
                  <i>下次</i>{" "}
                  {!job.enabled
                    ? "暂停中不执行"
                    : job.runOnce
                      ? job.lastRunAt
                        ? "已执行（一次性）"
                        : formatRunAt(job.oneShotAt, job.timezone)
                      : formatRunAt(job.nextRunAt, job.timezone)}
                </span>
                <span>
                  <i>已执行</i> {job.runCount} 次
                </span>
              </div>

              <p className="sj-job-prompt">{summarize(job.prompt, 120)}</p>

              <div className="sj-runs">
                <div
                  className={`sj-run ${
                    job.lastStatus === "SUCCEEDED" ? "ok" : job.lastStatus === "FAILED" ? "bad" : "wait"
                  }`}
                >
                  <i className="sj-dot" />
                  <em>执行</em>
                  {job.lastStatus === "SUCCEEDED"
                    ? `${formatRunAt(job.lastRunAt, job.timezone)} 成功`
                    : job.lastStatus === "FAILED"
                      ? `${formatRunAt(job.lastRunAt, job.timezone)} 失败`
                      : job.lastStatus === "RUNNING"
                        ? "正在执行"
                        : "从未执行"}
                  {body && (
                    <span className="sj-run-tag" title={body}>
                      {summarize(body, 24)}
                    </span>
                  )}
                </div>
                {job.notifyWechat === false ? (
                  <div className="sj-run">
                    <i className="sj-dot" />
                    <em>微信通知</em>已关闭
                  </div>
                ) : (
                  <div className={`sj-run ${notify ? (notify.ok ? "ok" : "bad") : "wait"}`}>
                    <i className="sj-dot" />
                    <em>微信通知</em>
                    {notify
                      ? notify.ok
                        ? "已送达"
                        : "未送达"
                      : job.lastResult
                        ? "无记录"
                        : "待执行后推送"}
                    {notify && !notify.ok && (
                      <span className="sj-run-tag" title={notify.text}>
                        {summarize(notify.text, 24)}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {job.lastStatus === "FAILED" && job.lastError && (
                <div className="sj-run-note">
                  <strong>执行失败：</strong>
                  {summarize(job.lastError, 160)}
                </div>
              )}
              {notifyBroken && (
                <div className="sj-run-note">
                  <strong>通知没送达：</strong>
                  {summarize(notify?.text || "通道不可用", 160)}
                  　任务本身已正常执行，结果可在内容库查看。
                </div>
              )}

              {historyJobId === job.id && (
                <div className="sj-history">
                  <div className="sj-history-head">
                    <strong>运行记录</strong>
                    <span>最近 20 次（新的在上）</span>
                  </div>
                  {historyLoading ? (
                    <p className="sj-history-empty">读取中…</p>
                  ) : historyRuns.length === 0 ? (
                    <p className="sj-history-empty">
                      还没有记录。执行一次后就会出现（历史任务在本次上线前的执行没有单独留档）。
                    </p>
                  ) : (
                    <ul className="sj-history-list">
                      {historyRuns.map((run) => {
                        const ok = run.status === "SUCCEEDED";
                        const failed = run.status === "FAILED";
                        return (
                          <li key={run.id} className={`sj-history-item ${ok ? "ok" : failed ? "bad" : "wait"}`}>
                            <div className="sj-history-row">
                              <i className="sj-dot" />
                              <span className="sj-history-time">
                                {formatRunAt(run.startedAt, job.timezone)}
                              </span>
                              <span className="sj-history-tag">
                                {run.trigger === "MANUAL" ? "手动" : "定时"}
                              </span>
                              <span className="sj-history-status">
                                {ok ? "成功" : failed ? "失败" : "执行中"}
                              </span>
                              {run.durationMs != null && (
                                <span className="sj-history-cost">{formatDuration(run.durationMs)}</span>
                              )}
                            </div>
                            {(run.result || run.error) && (
                              <details className="sj-history-detail">
                                <summary>查看结果全文</summary>
                                <pre>{run.result || run.error}</pre>
                              </details>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {draft && (
        <>
          <div className="sj-mask" onClick={() => !saving && setDraft(null)} />
          <aside className="sj-drawer">
            <div className="sj-drawer-head">
              <h2>{draft.id ? "编辑定时任务" : "新建定时任务"}</h2>
              <button className="sj-btn sm ghost" onClick={() => !saving && setDraft(null)}>
                关闭
              </button>
            </div>

            <div className="sj-drawer-body">
              {draft.id && editMeta && (
                <div className="sj-meta-card">
                  <div className="sj-meta-head">
                    <span className={`sj-badge ${editMeta.enabled ? "on" : "off"}`}>
                      {editMeta.enabled ? "运行中" : "已暂停"}
                    </span>
                    <strong>这条任务现在的数据</strong>
                  </div>
                  <dl className="sj-meta-rows">
                    <div>
                      <dt>任务 ID</dt>
                      <dd className="mono">{draft.id}</dd>
                    </div>
                    <div>
                      <dt>创建时间</dt>
                      <dd>{formatDateTime(editMeta.createdAt, editMeta.timezone)}</dd>
                    </div>
                    <div>
                      <dt>时区</dt>
                      <dd>{editMeta.timezone}</dd>
                    </div>
                    <div>
                      <dt>已执行</dt>
                      <dd>{editMeta.runCount} 次</dd>
                    </div>
                    <div>
                      <dt>上次执行</dt>
                      <dd>
                        {editMeta.lastStatus === "SUCCEEDED"
                          ? `${formatRunAt(editMeta.lastRunAt, editMeta.timezone)} 成功`
                          : editMeta.lastStatus === "FAILED"
                            ? `${formatRunAt(editMeta.lastRunAt, editMeta.timezone)} 失败`
                            : editMeta.lastStatus === "RUNNING"
                              ? "正在执行"
                              : "从未执行"}
                      </dd>
                    </div>
                    {editMeta.runOnce ? (
                      <div>
                        <dt>触发</dt>
                        <dd>仅执行一次</dd>
                      </div>
                    ) : (
                      <div>
                        <dt>触发</dt>
                        <dd>重复</dd>
                      </div>
                    )}
                    {editMeta.runOnce && editMeta.oneShotAt && (
                      <div>
                        <dt>计划时间</dt>
                        <dd>{formatDateTime(editMeta.oneShotAt, editMeta.timezone)}</dd>
                      </div>
                    )}
                    {editMeta.notifyWechat ? (
                      <div>
                        <dt>微信通知</dt>
                        <dd className={editMeta.notify ? (editMeta.notify.ok ? "ok" : "bad") : ""}>
                          {editMeta.notify ? (editMeta.notify.ok ? "已送达" : "未送达") : "开启"}
                        </dd>
                      </div>
                    ) : (
                      <div>
                        <dt>微信通知</dt>
                        <dd>已关闭</dd>
                      </div>
                    )}
                  </dl>
                  {editMeta.lastStatus === "FAILED" && editMeta.lastError && (
                    <p className="sj-meta-alert">执行失败：{summarize(editMeta.lastError, 200)}</p>
                  )}
                  {editMeta.notify && !editMeta.notify.ok && (
                    <p className="sj-meta-alert">
                      通知未送达：{summarize(editMeta.notify.text, 200)}　任务本身已正常执行。
                    </p>
                  )}
                  {editMeta.body && (
                    <details className="sj-meta-details">
                      <summary>上次执行结果全文（{editMeta.body.length} 字）</summary>
                      <pre>{editMeta.body}</pre>
                    </details>
                  )}
                </div>
              )}

              <div className="sj-field">
                <span>任务类型</span>
                <div className="sj-seg">
                  <button
                    className={draft.kind === "TEXT" ? "active" : ""}
                    onClick={() => setDraft({ ...draft, kind: "TEXT" })}
                  >
                    文字任务
                  </button>
                  <button
                    className={draft.kind === "VIDEO" ? "active" : ""}
                    onClick={() => setDraft({ ...draft, kind: "VIDEO" })}
                  >
                    视频任务
                  </button>
                </div>
                <em>
                  {draft.kind === "VIDEO"
                    ? "到点由 AI 直接出一版竖版短视频（1080×1920、20 秒内，约 15~25 分钟）。成品自动进内容库，可随时去 Studio 点画面改。"
                    : "到点把执行内容交给 AI 员工，在该用户的专属会话里执行。"}
                </em>
              </div>

              <label className="sj-field">
                <span>任务名称</span>
                <input
                  type="text"
                  value={draft.name}
                  placeholder="例如：每日内容生成"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>

              {draft.kind === "VIDEO" && (
                <>
                  <label className="sj-field">
                    <span>产品网站（可选）</span>
                    <input
                      type="text"
                      value={draft.videoSiteUrl}
                      placeholder="https://aimemory.cafe"
                      onChange={(e) => setDraft({ ...draft, videoSiteUrl: e.target.value })}
                    />
                    <em>AI 会抓这个站的真实截图 / logo / 配色当素材。与参考图至少填一个。</em>
                  </label>
                  <label className="sj-field">
                    <span>目标时长（秒）</span>
                    <input
                      type="number"
                      min={10}
                      max={60}
                      value={draft.videoTargetSeconds ?? ""}
                      placeholder="默认 20"
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          videoTargetSeconds: e.target.value === "" ? null : Number(e.target.value)
                        })
                      }
                    />
                    <em>10~60 秒，默认 20。DSH 会据此约束节奏并裁剪；想做 30 秒宣传片就填 30。</em>
                  </label>
                  <div className="sj-field">
                    <span>
                      参考图（可选）
                      <em className="sj-count">{videoImageList.length}/6</em>
                    </span>
                    <div className="sj-image-row">
                      {videoImageList.map((url) => (
                        <div className="sj-image-thumb" key={url} title={url}>
                          {/* 缩略图直接读站内路径：编辑已有任务时原图会一起回显 */}
                          <img src={url} alt="参考图" />
                          <button
                            type="button"
                            className="sj-image-remove"
                            onClick={() => removeReferenceImage(url)}
                            title="移除这张"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      {videoImageList.length < 6 && (
                        <button
                          type="button"
                          className="sj-image-add"
                          disabled={uploadingImages}
                          onClick={() => imageInputRef.current?.click()}
                        >
                          {uploadingImages ? "上传中…" : "＋ 上传"}
                        </button>
                      )}
                    </div>
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      hidden
                      onChange={(e) => void uploadReferenceImages(e.target.files)}
                    />
                    <textarea
                      value={draft.videoImages}
                      placeholder="/uploads/scheduled/xxx.jpg&#10;https://example.com/cover.png"
                      onChange={(e) => setDraft({ ...draft, videoImages: e.target.value })}
                    />
                    <em>可以点「上传」选本地图片，也可以直接粘贴图片链接（一行一个）。最多 6 张。</em>
                  </div>
                </>
              )}

              <label className="sj-field">
                <span>
                  {draft.kind === "VIDEO" ? "提示词（AI 先选题再出片）" : "执行内容"}
                  <em className="sj-count">{draft.prompt.length} 字</em>
                </span>
                <textarea
                  className="sj-prompt"
                  value={draft.prompt}
                  placeholder={
                    draft.kind === "VIDEO"
                      ? "例如：看今天和「AI 回忆录 / 父母故事」相关的热点、节日或社会情绪，挑一个最有共鸣的，做一条 20 秒竖版短片。"
                      : "用一句话说清要做什么，AI 员工到点执行。不需要写「发给我」——通知由平台负责。"
                  }
                  onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                />
                <em>
                  {draft.kind === "VIDEO"
                    ? "和文字任务同一套写法：只写要做什么。到点 AI 会先检索热点、选定 1 个选题，再自动写成创作需求（不用你提前写）。产品网站/参考图只是补充素材，可以不填。"
                    : "只写「要做什么」。发送通知是平台的事，别写进执行内容。"}
                </em>
              </label>

              <p className="sj-section">触发规则</p>

              <div className="sj-field">
                <span>触发方式</span>
                <div className="sj-seg">
                  <button
                    className={!draft.runOnce ? "active" : ""}
                    onClick={() => setDraft({ ...draft, runOnce: false })}
                  >
                    定时重复
                  </button>
                  <button
                    className={draft.runOnce ? "active" : ""}
                    onClick={() => setDraft({ ...draft, runOnce: true })}
                  >
                    只执行一次
                  </button>
                </div>
              </div>

              {draft.runOnce ? (
                <label className="sj-field">
                  <span>执行时间</span>
                  <input
                    type="datetime-local"
                    value={draft.oneShotAt}
                    onChange={(e) => setDraft({ ...draft, oneShotAt: e.target.value })}
                  />
                  <em>到这个时间执行一次，完成后自动停止（不循环）。</em>
                </label>
              ) : (
                <>
                  <div className="sj-field">
                    <span>重复方式</span>
                    <div className="sj-seg">
                      {(
                        [
                          ["daily", "每天"],
                          ["weekly", "每周"],
                          ["monthly", "每月"],
                          ["custom", "自定义"]
                        ] as Array<[Freq, string]>
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          className={draft.freq === key ? "active" : ""}
                          onClick={() => setDraft({ ...draft, freq: key })}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {draft.freq === "weekly" && (
                    <div className="sj-field">
                      <span>哪几天</span>
                      <div className="sj-weekdays">
                        {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                          <button
                            key={day}
                            className={draft.weekdays.includes(day) ? "active" : ""}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                weekdays: draft.weekdays.includes(day)
                                  ? draft.weekdays.filter((d) => d !== day)
                                  : [...draft.weekdays, day]
                              })
                            }
                          >
                            {WEEK_LABELS[day]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="sj-row">
                    {draft.freq === "monthly" && (
                      <label className="sj-field">
                        <span>每月几号</span>
                        <input
                          type="number"
                          min={1}
                          max={31}
                          value={draft.monthday}
                          onChange={(e) => setDraft({ ...draft, monthday: e.target.value })}
                        />
                      </label>
                    )}
                    {draft.freq !== "custom" && (
                      <label className="sj-field">
                        <span>时间</span>
                        <input
                          type="time"
                          value={draft.time}
                          onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                        />
                      </label>
                    )}
                    {draft.freq === "custom" && (
                      <label className="sj-field wide">
                        <span>cron 表达式</span>
                        <input
                          type="text"
                          value={draft.cronExpr}
                          placeholder="30 17 * * *   （分 时 日 月 周）"
                          onChange={(e) => setDraft({ ...draft, cronExpr: e.target.value })}
                        />
                        <em>时区固定 Asia/Shanghai。</em>
                      </label>
                    )}
                  </div>
                </>
              )}

              <p className="sj-section">结果通知</p>

              <label className="sj-notify-toggle">
                <span className="sj-notify-toggle-label">
                  消息推送到微信
                  <em>{draft.notifyWechat ? "任务完成后把结果发到你的微信" : "只执行，不往微信发消息"}</em>
                </span>
                <button
                  type="button"
                  className={`sj-switch ${draft.notifyWechat ? "on" : ""}`}
                  onClick={() => setDraft({ ...draft, notifyWechat: !draft.notifyWechat })}
                >
                  <span className="sj-switch-knob" />
                </button>
              </label>
            </div>

            <div className="sj-drawer-foot">
              <button className="sj-btn" disabled={saving} onClick={() => setDraft(null)}>
                取消
              </button>
              <button className="sj-btn primary" disabled={saving} onClick={() => void save()}>
                {saving ? "保存中…" : draft.id ? "保存修改" : "保存并启用"}
              </button>
            </div>
          </aside>
        </>
      )}

      {toast && <div className="sj-toast">{toast}</div>}
    </section>
  );
}
