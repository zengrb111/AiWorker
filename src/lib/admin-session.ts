/**
 * 运营后台（op-aiworker.aimemory.cafe）独立管理员会话。
 *
 * 与主站用户会话完全隔离：cookie 名不同、签名前缀不同，
 * 主站的 cx_session 不能拿来访问后台，后台的也不能登录主站。
 * 账号密码走环境变量（ADMIN_USERNAME / ADMIN_PASSWORD），缺省 admin / admin123。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";

export const ADMIN_COOKIE = "op_admin_session";
/** 后台会话 12 小时，比主站 7 天短一些。 */
const MAX_AGE = 60 * 60 * 12;

function secret(): string {
  // 线上 .env 已配；本机 .env.local 有 dev 值。缺省值只用于纯本地裸跑。
  return process.env.AUTH_SESSION_SECRET || "op-admin-local-fallback-secret";
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update("op-admin:" + value).digest("hex");
}

export function adminCredentials(): { username: string; password: string } {
  return {
    username: (process.env.ADMIN_USERNAME || "admin").trim(),
    password: (process.env.ADMIN_PASSWORD || "admin123").trim()
  };
}

function cookieOptions(maxAge: number) {
  // 不能写死 NODE_ENV === production：新域名在证书申请完成前只有 HTTP，
  // 带 Secure 的 cookie 浏览器根本不会保存 → 登录后立刻被踢回登录页。
  // 按 nginx 传进来的真实协议决定，上 SSL 后自动变回 Secure。
  const proto = (headers().get("x-forwarded-proto") || "http").split(",")[0].trim();
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: proto === "https",
    path: "/",
    maxAge
  };
}

export async function createAdminSession(): Promise<void> {
  const issuedAt = Date.now().toString();
  const payload = `admin.${issuedAt}`;
  cookies().set(ADMIN_COOKIE, `${payload}.${sign(payload)}`, cookieOptions(MAX_AGE));
}

export async function clearAdminSession(): Promise<void> {
  cookies().set(ADMIN_COOKIE, "", cookieOptions(0));
}

/** 只读校验，可在 Server Component / Route Handler 里调用。 */
export function isAdminSession(): boolean {
  const token = cookies().get(ADMIN_COOKIE)?.value;
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [who, issuedAt, signature] = parts;
  if (who !== "admin") return false;

  const payload = `${who}.${issuedAt}`;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(sign(payload));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;

  const age = Date.now() - Number(issuedAt);
  return Number.isFinite(age) && age >= 0 && age <= MAX_AGE * 1000;
}
