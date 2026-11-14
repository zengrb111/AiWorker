import { redirect } from "next/navigation";
import { isAdminSession } from "@/lib/admin-session";

export const dynamic = "force-dynamic";

/** 访问后台根路径时按登录态分流，nginx 会把域名 / 指到这里。 */
export default function AdminHomePage() {
  redirect(isAdminSession() ? "/admin/users" : "/admin/login");
}
