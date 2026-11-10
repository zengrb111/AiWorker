import { jsonError, jsonOk } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { listUserScheduledJobs } from "@/lib/scheduled-jobs-view";

export const dynamic = "force-dynamic";

/**
 * GET /api/scheduled-jobs —— 当前登录用户的定时任务列表（**只读**）。
 *
 * 平台侧「定时任务」模块是纯查看器：任务一律在微信里跟龙虾聊着建，平台不提供写操作。
 * 数据源与合并规则见 `src/lib/scheduled-jobs-view.ts`（平台库 + 网关 cron 两处合并，
 * 否则「龙虾用 openclaw cron 建的任务」在平台上看不见）。
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const { jobs, gatewayError } = await listUserScheduledJobs(user.id);
  return jsonOk({ jobs, gatewayError });
}
