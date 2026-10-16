import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

/**
 * Remotion 渲染入口。
 *
 * 渲染命令（由 src/lib/video/render.ts 执行，注意 --props 必须用等号形式）：
 *   npx remotion render remotion/src/index.tsx VerticalStoryboard <out.mp4> --props=<abs.json>
 */
registerRoot(RemotionRoot);
