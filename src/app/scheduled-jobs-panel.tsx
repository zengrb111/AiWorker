"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * 「定时任务」面板 —— **纯查看器**。
 *
 * 设计调整（2026-11）：平台不再提供新建 / 编辑 / 暂停 / 删除 / 立即执行等任何写操作。
 * 定时任务一律由用户在**微信里跟 AI 员工（龙虾）对话**创建（走 /api/scheduled-jobs/agent，
 * 落库 source=AGENT）；平台调度器到点执行并推微信，本面板只负责「看」：
 *
 *   1. 列出龙虾创建的任务（GET /api/scheduled-jobs 已按 source=AGENT 过滤）；
 *   2. 展示每条任务的执行状态与微信通知状态（两件事分开核对）；
 *   3. 展开查看最近的运行记录；
 *   4. 显示微信通道是否真通。
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
  /** AGENT=龙虾经微信创建 / GATEWAY=只在网关 cron 里（平台库无记录） */
  source: string;
  /** PLATFORM=平台库任务（平台调度器执行）/ GATEWAY=网关 cron 任务（网关自己执行） */
  origin: "PLATFORM" | "GATEWAY";
  gatewayJobId: string | null;
  nextRunAt: string | null;
  createdAt: string;
  lastDurationMs?: number | null;
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

async function request<T>(path: string, init?: RequestInit, timeoutMs = 30000): Promise<T> {
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

const WEEK_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export default function ScheduledJobsPanel({ resetToken }: { resetToken: number }) {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [channel, setChannel] = useState<ChannelHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** 网关 cron 读取失败的原因：平台库任务照常展示，但要如实说明少了什么。 */
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  /** 展开看运行记录的任务 id（同时只展开一条） */
  const [historyJobId, setHistoryJobId] = useState<string | null>(null);
  const [historyRuns, setHistoryRuns] = useState<JobRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [toast, setToast] = useState("");

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // 后端网关调用超时 30 秒（成功或带 gatewayError 都会在 30 秒内返回）。
      // 这里给 35 秒是必需的余量：若两边都卡在 30 秒，前端会先 abort，用户又看到
      // 「请求超时」而不是后端那条有意义的「网关正在启动」提示；多出的 5 秒留给冷编译和传输。
      const data = await request<{ jobs: JobItem[]; gatewayError?: string | null }>(
        "/api/scheduled-jobs",
        undefined,
        35000
      );
      setJobs(data.jobs);
      setGatewayError(data.gatewayError ?? null);
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

  const channelOk = channel?.ok === true;

  return (
    <section className="sj-root">
      <div className="sj-head">
        <div className="sj-head-text">
          <h2>定时任务</h2>
          <p>
            任务由你在微信里和 AI 员工（龙虾）对话创建，这里只查看执行情况 · 结果自动推送到微信 · 执行与通知分开核对
          </p>
        </div>
        <div className="sj-head-actions">
          <button className="sj-btn" onClick={() => void refresh()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
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
      {gatewayError && (
        <div className="sj-channel-warn">
          <strong>
            {/starting|startup|retry shortly/i.test(gatewayError)
              ? "网关正在启动，任务列表暂时读不出来"
              : "网关里的任务这次没读出来"}
          </strong>
          <p>{/starting|startup/i.test(gatewayError) ? "通常是网关刚重启，等 1~2 分钟再点刷新就好；平台侧的任务不受影响。" : summarize(gatewayError, 200)}</p>
          <p>下面只显示平台侧登记的任务；网关恢复后刷新即可看到全部。</p>
        </div>
      )}

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
            <p>
              在微信里直接跟 AI 员工（龙虾）说「每天早上 9 点帮我做一份今日内容」，任务会自动出现在这里；
              改时间、暂停、取消也都在微信里聊就行。
            </p>
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
                  {job.origin === "GATEWAY" ? (
                    <span className="sj-badge off" title="这条任务由 OpenClaw 网关自己调度执行，平台只做展示">
                      网关调度
                    </span>
                  ) : (
                    <button
                      className={`sj-btn sm ghost${historyJobId === job.id ? " active" : ""}`}
                      onClick={() => void toggleHistory(job)}
                    >
                      {historyJobId === job.id ? "收起记录" : "运行记录"}
                    </button>
                  )}
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
                  <i>{job.origin === "GATEWAY" ? "执行方" : "已执行"}</i>{" "}
                  {job.origin === "GATEWAY" ? "OpenClaw 网关" : `${job.runCount} 次`}
                </span>
                <span>
                  <i>来源</i>{" "}
                  {job.origin === "GATEWAY" ? "微信 · 龙虾创建（网关调度）" : "微信 · 龙虾创建"}
                </span>
                <span>
                  <i>创建</i> {formatDateTime(job.createdAt, job.timezone)}
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
                        : job.lastStatus === "SKIPPED"
                          ? "已跳过（网关未执行）"
                          : job.lastRunAt
                            ? `${formatRunAt(job.lastRunAt, job.timezone)} 已执行`
                            : "从未执行"}
                  {job.origin === "GATEWAY" && job.lastStatus && job.lastDurationMs != null && (
                    <span className="sj-run-tag">耗时 {formatDuration(job.lastDurationMs)}</span>
                  )}
                  {body && (
                    <span className="sj-run-tag" title={body}>
                      {summarize(body, 24)}
                    </span>
                  )}
                </div>
                {job.origin === "GATEWAY" ? (
                  <div className="sj-run ok">
                    <i className="sj-dot" />
                    <em>微信通知</em>由网关投递
                  </div>
                ) : job.notifyWechat === false ? (
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

      {toast && <div className="sj-toast">{toast}</div>}
    </section>
  );
}
