import PlatformClient from "./platform-client";
import { warmupWeixinLoginModule } from "@/lib/openclaw";

// 登录页是交互式 SPA，无需静态缓存；保持动态渲染以便每次访问都能触发预热。
export const dynamic = "force-dynamic";

export default function HomePage() {
  // 后台预热微信登录插件：首次动态 import 依赖树耗时较长，
  // 提前加载可避免用户点「注册」生成二维码时等待过久触发前端超时。
  void warmupWeixinLoginModule();

  return <PlatformClient />;
}
