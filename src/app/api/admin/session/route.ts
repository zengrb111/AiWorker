import { jsonOk } from "@/lib/http";
import { isAdminSession } from "@/lib/admin-session";

/** GET /api/admin/session —— 前端判断登录态（不泄露任何凭据）。 */
export const dynamic = "force-dynamic";

export async function GET() {
  return jsonOk({ authenticated: isAdminSession() });
}
