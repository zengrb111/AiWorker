import type { Metadata } from "next";
import "../renderer/styles.css";

export const metadata: Metadata = {
  title: "创星云-AI数字员工平台",
  description: "快速创建你的AI数字员工军团"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
