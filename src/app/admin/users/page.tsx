import { redirect } from "next/navigation";
import { isAdminSession } from "@/lib/admin-session";
import { AdminUsersPanel } from "../admin-client";

export const dynamic = "force-dynamic";

export default function AdminUsersPage() {
  if (!isAdminSession()) redirect("/admin/login");
  return <AdminUsersPanel />;
}
