import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { startSync, getSyncState } from "@/lib/sync-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/platform-metrics/sync —— 异步触发全部渠道真实数据同步。
 * 立即返回，同步在服务端后台执行；用 GET 同路径查询进度/结果。
 */
export async function POST() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const started = startSync(user.id);
  const state = getSyncState(user.id);
  return NextResponse.json({ ok: true, started, state });
}

/** GET /api/platform-metrics/sync —— 当前用户的后台同步状态（running/结果） */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, state: getSyncState(user.id) });
}
