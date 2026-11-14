import { redirect } from "next/navigation";
import { isAdminSession } from "@/lib/admin-session";
import { AdminLoginForm } from "../admin-client";

export const dynamic = "force-dynamic";

export default function AdminLoginPage() {
  if (isAdminSession()) redirect("/admin/users");
  return <AdminLoginForm />;
}
