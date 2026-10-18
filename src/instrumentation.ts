/**
 * Next.js 服务启动钩子：拉起平台侧定时任务调度器（**自带定时器，不依赖网关**）。
 *
 * 注意：这里刻意**不 import 任何服务端重模块**（如 src/lib/scheduler.ts → src/lib/openclaw.ts）。
 * 因为 instrumentation 会被 Next 同时按 nodejs 与 edge 运行时编译，引入 node 内置模块
 * （module/fs 等）会导致编译失败、整站 500（2026-10-15 实测）。所以这里只做一次本机 HTTP
 * 调用，真正的调度逻辑放在 /api/scheduler/tick 路由里（普通服务端路由，编译环境正常）。
 */
const TICK_INTERVAL_MS = 30_000;
const FIRST_DELAY_MS = 15_000;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const token = (process.env.SCHEDULE_API_TOKEN || process.env.CONTENT_INGEST_TOKEN || "").trim();
  if (!token) {
    console.warn("[instrumentation] 未配置 SCHEDULE_API_TOKEN / CONTENT_INGEST_TOKEN，平台调度器未启动。");
    return;
  }
  const base = (process.env.AIWORKER_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const url = `${base}/api/scheduler/tick`;
  // 每日自动采集（到点后每个有授权账号的用户跑一次全渠道同步）
  const collectUrl = `${base}/api/collectors/tick`;

  const post = (target: string, label: string) => {
    fetch(target, { method: "POST", headers: { Authorization: `Bearer ${token}` } })
      .then((res) => {
        if (!res.ok) console.error(`[${label}] tick 返回 ${res.status}`);
      })
      .catch((error) => {
        console.error(`[${label}] tick 失败：`, error instanceof Error ? error.message : error);
      });
  };

  const tick = () => {
    post(url, "scheduler");
    post(collectUrl, "collectors");
  };

  const timer = setInterval(tick, TICK_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  setTimeout(tick, FIRST_DELAY_MS);
  console.log(`[scheduler] 平台定时任务调度器已启动（每 ${TICK_INTERVAL_MS / 1000}s 触发一次 /api/scheduler/tick + /api/collectors/tick）`);
}
