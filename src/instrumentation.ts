/**
 * Next.js 服务启动钩子：拉起平台侧定时任务调度器（**自带定时器，不依赖网关**）。
 *
 * 注意：这里刻意**不 import 任何服务端重模块**（如 src/lib/scheduler.ts → src/lib/openclaw.ts）。
 * 因为 instrumentation 会被 Next 同时按 nodejs 与 edge 运行时编译，引入 node 内置模块
 * （module/fs 等）会导致编译失败、整站 500（2026-10-15 实测）。所以这里只做一次本机 HTTP
 * 调用，真正的调度逻辑放在 /api/scheduler/tick 路由里（普通服务端路由，编译环境正常）。
 */
const TICK_INTERVAL_MS = 30_000;
/** Studio 评论接单单独用更短的间隔：用户改完片就在等效果，30 秒空窗体感很差。 */
const MOTION_TICK_INTERVAL_MS = 10_000;
const FIRST_DELAY_MS = 15_000;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const token = (process.env.SCHEDULE_API_TOKEN || process.env.CONTENT_INGEST_TOKEN || "").trim();
  if (!token) {
    // 不直接退出：令牌可能稍后在「系统配置 → 平台 Agent 令牌」里设置，setAgentToken 会同步写入
    // 本进程的 process.env，届时下一次 tick 即可带上新令牌开始工作。
    console.warn("[instrumentation] 暂未读到平台 Agent 令牌，调度器将等待配置后再触发。");
  }
  const base = (process.env.AIWORKER_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const url = `${base}/api/scheduler/tick`;
  // 每日自动采集（到点后每个有授权账号的用户跑一次全渠道同步）
  const collectUrl = `${base}/api/collectors/tick`;
  // Studio 评论自动接单：扫到新评论就交给 DSH 改片并自动重出片
  const motionUrl = `${base}/api/video-motion/tick`;

  const post = (target: string, label: string) => {
    // 每轮现读 process.env：用户在「系统配置」里重设令牌后，setAgentToken 会同步更新进程内环境变量，
    // 这里若沿用启动时捕获的 token 就会一直用旧值。
    const fresh = (process.env.SCHEDULE_API_TOKEN || process.env.CONTENT_INGEST_TOKEN || "").trim() || token;
    if (!fresh) return; // 还没配置令牌：跳过本轮，等用户配置后再跑
    fetch(target, { method: "POST", headers: { Authorization: `Bearer ${fresh}` } })
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
  // Studio 评论接单一轮可能要跑十几分钟；路由里有 ticking 重入保护，
  // 轮询期间再来一轮会直接返回 skipped，所以 10 秒一次不会堆积。
  const motionTick = () => post(motionUrl, "motion-inbox");

  // 重启后自愈微信通道：网关重启会打断到微信服务端的长连接，插件也可能清掉历史 bot 凭据，
  // 导致「昨天正常、今天重启后微信显示暂无法连接」。这里只做一次本机 HTTP 调用（不 import
  // 重模块），真正的恢复逻辑在 /api/wechat/self-heal 路由里。
  const selfHeal = () => {
    const fresh = (process.env.SCHEDULE_API_TOKEN || process.env.CONTENT_INGEST_TOKEN || "").trim() || token;
    if (!fresh) return;
    fetch(`${base}/api/wechat/self-heal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fresh}` }
    })
      .then((res) => {
        if (!res.ok) console.error(`[self-heal] 微信通道自愈返回 ${res.status}`);
        else console.log("[self-heal] 微信通道自愈已触发");
      })
      .catch((error) => {
        console.error("[self-heal] 微信通道自愈失败：", error instanceof Error ? error.message : error);
      });
  };

  const timer = setInterval(tick, TICK_INTERVAL_MS);
  const motionTimer = setInterval(motionTick, MOTION_TICK_INTERVAL_MS);
  for (const t of [timer, motionTimer]) {
    if (typeof t.unref === "function") t.unref();
  }
  setTimeout(tick, FIRST_DELAY_MS);
  setTimeout(motionTick, FIRST_DELAY_MS);
  // 启动后延时自愈一次（等平台路由与网关就绪），再补跑一次兜底「网关启动慢于平台」的情况。
  setTimeout(selfHeal, 20_000);
  setTimeout(selfHeal, 90_000);
  console.log(`[scheduler] 平台定时任务调度器已启动（每 ${TICK_INTERVAL_MS / 1000}s 触发 /api/scheduler/tick + /api/collectors/tick；每 ${MOTION_TICK_INTERVAL_MS / 1000}s 触发 Studio 评论接单）`);
  console.log("[self-heal] 微信通道自愈已排期（启动后 20s / 90s 各一次）");
}
