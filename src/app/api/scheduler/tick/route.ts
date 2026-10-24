import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/http";
import { recoverInterruptedRuns, tickScheduler } from "@/lib/scheduler";
import { getAgentToken, isValidAgentToken } from "@/lib/platform-config";

export const dynamic = "force-dynamic";

/**
 * 进程启动后的第一次 tick 顺手清理「上次进程留下的 RUNNING」。
 *
 * 真正拉起调度的是 instrumentation 本机 fetch 本接口（startScheduler 那套已不在用），
 * 所以收尾也挂在这里；模块级标记保证每个进程只做一次。
 */
// 用 globalThis 而不是模块变量：dev 模式 HMR 会重建模块，模块变量会失效并重复清理。
const recoveryState = globalThis as unknown as { __schedulerRecoveryDone?: boolean };

/**
 * POST /api/scheduler/tick —— 触发一轮平台定时任务调度。
 *
 * 为什么需要这个接口：Next 的 instrumentation 会被 Next 按 edge 运行时一起编译，
 * 而调度器依赖的服务端模块（含 node 内置模块）在其中无法编译，故不用 instrumentation。
 * 改由外部每分钟调用本接口（网关侧一个**不含任何用户数据**的系统 cron 任务；
 * 若网关未运行，也可用系统计划任务/其它定时器）。
 *
 * 鉴权：Bearer 令牌（SCHEDULE_API_TOKEN，未配置则回退 CONTENT_INGEST_TOKEN）。
 */
function extractToken(request: NextRequest): string {
  const header = request.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return (request.headers.get("x-schedule-token") || "").trim();
}

async function handle(request: NextRequest) {
  const expected = getAgentToken();
  if (!expected) {
    return jsonError("服务端未配置平台 Agent 令牌（系统配置 → 平台 Agent 令牌），该接口未启用。", 503);
  }
  if (!isValidAgentToken(extractToken(request))) {
    return jsonError("令牌无效。", 401);
  }
  if (!recoveryState.__schedulerRecoveryDone) {
    recoveryState.__schedulerRecoveryDone = true;
    await recoverInterruptedRuns().catch((error) => {
      console.error("[scheduler] 清理中断执行失败：", error instanceof Error ? error.message : error);
    });
  }
  const fired = await tickScheduler();
  return jsonOk({ fired, firedCount: fired.length });
}

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}
