/**
 * 平台调度器触发脚本：调用 AiWorker 的 /api/scheduler/tick，让它跑一轮到期任务。
 *
 * 为什么不由平台自己起定时器：Next 的 instrumentation 会被按 edge 运行时一起编译，
 * 而调度器依赖的服务端模块（含 node 内置模块）在其中无法编译（实测整站 500）。
 * 因此改由系统级定时器每分钟调用本脚本。
 *
 * 令牌来源（按优先级）：环境变量 SCHEDULE_API_TOKEN / CONTENT_INGEST_TOKEN，
 * 否则从项目 .env.local 里读 CONTENT_INGEST_TOKEN（避免把密钥再抄一份到别处）。
 */
import { readFileSync } from "node:fs";

const TICK_URL = process.env.AIWORKER_TICK_URL || "http://127.0.0.1:3000/api/scheduler/tick";
const ENV_PATH = process.env.AIWORKER_ENV_PATH || "D:\\OPCProjects\\AiWorker\\.env.local";

function resolveToken() {
  const fromEnv = (process.env.SCHEDULE_API_TOKEN || process.env.CONTENT_INGEST_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const text = readFileSync(ENV_PATH, "utf8");
    const m = /^\s*CONTENT_INGEST_TOKEN\s*=\s*"?([^"\r\n]+)"?/m.exec(text);
    if (m && m[1]) return m[1].trim();
  } catch {
    /* 读不到就当作没令牌 */
  }
  return "";
}

const token = resolveToken();
if (!token) {
  console.error("[platform-tick] 未找到调度令牌，跳过本次。");
  process.exit(0);
}

try {
  const res = await fetch(TICK_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  const text = await res.text();
  console.log(`[platform-tick] ${res.status} ${text.slice(0, 300)}`);
} catch (error) {
  // 平台没在运行时不报错，避免系统计划任务里堆失败告警。
  console.error(`[platform-tick] 平台未就绪：${error instanceof Error ? error.message : String(error)}`);
  process.exit(0);
}
