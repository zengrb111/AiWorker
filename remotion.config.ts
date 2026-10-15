import { Config } from "@remotion/cli/config";
import path from "node:path";

/**
 * Remotion 全局配置。
 *
 * 渲染在本机 Windows + 无头 Chromium 中进行，因此：
 * - 视频帧用 jpeg 截取再编码，比 png 快很多、体积更小；
 * - 放宽 delayRender 超时（默认 30s），给素材解码留足余量。
 */
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setDelayRenderTimeoutInMilliseconds(60_000);

/**
 * staticFile() 的根目录 —— 独立的小目录 remotion/public，**不能**指向 Next 的 public/。
 *
 * 原因：Remotion 每次渲染都会把 public 目录整个拷进 bundle。Next 的 public/ 里有
 * videos/ 等成片（实测已 12MB 且持续增长），指向它会让每次渲染都搬运整个站点静态目录。
 *
 * 注意必须用 process.cwd() 而不是 __dirname：Remotion 会把配置文件打成字符串后 eval 执行，
 * 此时 __dirname 指向 @remotion/cli/dist，不是项目根目录。
 *
 * cwd 前提（实测）：加载配置时 cwd 仍是**项目根**，因此这里按项目根拼 remotion/public。
 * 若将来从别的目录调 CLI（例如 cd remotion 后调），这条路径会解析错并静默指向
 * 不存在的目录 —— 那种场景下请在项目根执行，或改用 REMOTION_PUBLIC_DIR 覆盖。
 *
 * 约定：
 * - 素材与 props 落在 remotion/public/generated/<token>/，由 src/lib/video/render.ts 生成并清理；
 * - 成片输出到 Next 的 public/videos/，用绝对路径传给 CLI —— 输出位置与 public 目录无关。
 */
Config.setPublicDir(path.resolve(process.cwd(), "remotion", "public"));

// 渲染是 CPU/内存密集型，默认并发 2 条，避免同时渲染多条把机器打满。
// 需与 src/lib/video/render.ts 的并发闸门保持一致或更小。
Config.setConcurrency(Number(process.env.REMOTION_CONCURRENCY ?? 2));

// 素材全部来自本机，没有跨域需求，保留 Web 安全检查（不放开）。
Config.setChromiumDisableWebSecurity(false);
