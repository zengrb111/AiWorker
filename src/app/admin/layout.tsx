import type { Metadata } from "next";
import "@/renderer/admin.css";

export const metadata: Metadata = {
  title: "创星云 · 运营后台",
  description: "AI 数字员工平台运营后台"
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="op-admin-root">{children}</div>;
}
