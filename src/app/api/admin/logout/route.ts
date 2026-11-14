import { jsonOk } from "@/lib/http";
import { clearAdminSession } from "@/lib/admin-session";

/** POST /api/admin/logout */
export const dynamic = "force-dynamic";

export async function POST() {
  await clearAdminSession();
  return jsonOk({ ok: true });
}
