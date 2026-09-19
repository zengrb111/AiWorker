import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { syncAllPlatforms } from "@/lib/platform-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/platform-metrics/sync —— 触发全部渠道真实数据同步 */
export async function POST() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const results = await syncAllPlatforms();
  const okAll = results.every((r) => r.ok);
  return NextResponse.json({ ok: okAll, results });
}
