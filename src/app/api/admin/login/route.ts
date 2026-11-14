import { jsonError, jsonOk, readJson } from "@/lib/http";
import { adminCredentials, createAdminSession } from "@/lib/admin-session";

/** POST /api/admin/login —— 运营后台登录，账号密码不进用户表。 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await readJson<{ username?: string; password?: string }>(request);
  const expected = adminCredentials();
  const username = (body.username || "").trim();
  const password = body.password || "";

  if (username !== expected.username || password !== expected.password) {
    return jsonError("账号或密码不正确。", 401);
  }
  await createAdminSession();
  return jsonOk({ username });
}
