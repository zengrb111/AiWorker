import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/http";
import { tickScheduler } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

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
  const expected = (process.env.SCHEDULE_API_TOKEN || process.env.CONTENT_INGEST_TOKEN || "").trim();
  if (!expected) {
    return jsonError("服务端未配置 SCHEDULE_API_TOKEN / CONTENT_INGEST_TOKEN，该接口未启用。", 503);
  }
  if (extractToken(request) !== expected) {
    return jsonError("令牌无效。", 401);
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
