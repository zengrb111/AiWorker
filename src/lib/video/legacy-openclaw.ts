/**
 * 旧渲染路径（OpenClaw agent 现场写 Remotion 代码）—— 仅用于回滚。
 *
 * 新链路（DSH + 项目内 Remotion）刚上线时一旦在真实内容上出问题，需要能靠
 * VIDEO_RENDER_ENGINE=openclaw 秒级退回旧行为，而不是先修 bug 再出片。
 * 等新链路稳定后，连同 openclaw 的视频相关调用一起删。
 *
 * 它只负责「产出一条原始画面」；配音、混音、字幕、片头、封面仍走
 * src/lib/video/pipeline.ts，保证两条引擎的成片观感一致。
 */

import { existsSync } from "node:fs";
import { chatCompleteStream } from "../llm-client";
import { readPositiveNumberEnv } from "../env";
import type { RenderContext } from "./pipeline";

/** 旧路径超时很长（agent 要自己装环境、跑渲染），与新链路的 900s 不是一回事。 */
const LEGACY_TIMEOUT_MS = 1_800_000;

/** 从 agent 返回文本里尽力提取成片 URL —— 只用于诊断信息，不参与落库。 */
export function extractVideoUrl(text: string): string | undefined {
  const matchers: RegExp[] = [
    /\/videos\/[A-Za-z0-9._-]+\.mp4/g,
    /public[\\/]videos[\\/]([A-Za-z0-9._-]+\.mp4)/g,
    /https?:\/\/\S+?\.mp4/g,
  ];
  for (const re of matchers) {
    const match = re.exec(text);
    if (!match) continue;
    const raw = match[0];
    if (raw.startsWith("/videos/")) return raw;
    if (raw.startsWith("http")) return raw;
    return `/videos/${match[1]}`;
  }
  return undefined;
}

/** 拼旧引擎那段长 prompt。抽出来是为了让 renderViaOpenClaw 只关心调用与判错。 */
export function buildLegacyPrompt(ctx: RenderContext): string {
  const { materials, narrationText, targetSeconds, requirement, outputPath } = ctx;
  // 片尾时长：约总时长的 10%，最少 2 秒、最多 3 秒（口播在此之前已结束）
  const outroSec = targetSeconds ? Math.min(3, Math.max(2, Math.round(targetSeconds * 0.1))) : 0;
  const imageEndSec = targetSeconds ? Math.max(0, targetSeconds - outroSec) : 0;
  const perImageSec = imageEndSec && materials.length ? Math.round((imageEndSec / materials.length) * 10) / 10 : 3;
  const imageList = materials.map((m, i) => `${i + 1}. ${m.absolutePath}`).join("\n");
  const outputUrl = outputPath.replace(/\\/g, "/").split("/public/").pop() ?? outputPath;

  const lines = [
    "请使用 Remotion 视频技能，根据下列参考图与整体创作要求生成一条竖版短视频。",
    "",
    "参考图（本地绝对路径，按序号顺序使用）：",
    imageList,
    "",
    "整体创作要求：",
    requirement || "（未提供，按通用品牌风格生成）",
    "",
    "【画面与动效要求】",
    "1) 必须使用竖版 profile（tiktok / instagram_reels / youtube_shorts，均为 1080x1920），不要用横版。",
    "2) 用单个 anime_scene 场景承载全部参考图（把图片路径按顺序放进 images 数组），由组件自动等分时段轮播并交叉淡化。",
    "3) 电影感运镜：animation 从 ken-burns / zoom-in / zoom-out / pan-left / pan-right / drift-up / drift-down / parallax 中选择，并让相邻场景的运镜方向交替，避免重复；",
    "4) 氛围粒子：particles 从 fireflies / petals / sparkles / mist / light-rays 中按主题挑选，可用 particleColor 与 particleIntensity 微调。",
    "5) 光影质感：开启 vignette（暗角），并用 lightingFrom / lightingTo 设置与主题匹配的柔和渐变光。",
    "6) 不要使用 CSS animation/transition 做动效（渲染会闪烁），运镜请用组件已支持的 animation 参数或 interpolate 变换。",
    "",
    "【重要】画面中不要出现任何文字、标题、字幕、水印或标语（文案由后期统一以字幕形式叠加）；画面只做纯视觉呈现，留足画面下方约 1/4 的净空区域给字幕。",
    "",
  ];

  if (narrationText) {
    lines.push(`本视频的旁白文案（画面内容需呼应旁白，节奏与句子对应）：\n${narrationText}`, "");
  }

  if (targetSeconds) {
    lines.push(
      "【时长对齐 —— 必须严格遵守】",
      `- 旁白配音时长约 ${targetSeconds} 秒，视频总时长必须与之一致（±10% 以内）。`,
      `- 共 ${materials.length} 张参考图。图片场景必须从第 0 秒开始、连续无间断地铺满到第 ${imageEndSec} 秒。`,
      "- 图片之后不要留任何空白、纯色或无内容时段，否则会出现「只有背景动画但口播还在响」的画面。",
      `- 每张图停留约 ${perImageSec} 秒，让场景切换与旁白句子对应。`,
      `- 在图片之后追加一个 ${outroSec} 秒的简单片尾：使用 EndTag 组件显示「感谢观看」或品牌落版即可。`,
      `- 全片结构：0 ~ ${imageEndSec} 秒为图片轮播，${imageEndSec} ~ ${targetSeconds} 秒为片尾。`,
      "",
    );
  }

  lines.push(
    `请将最终渲染成片保存到：${outputPath}`,
    `渲染完成后，请在本条回复的末尾仅以一行格式给出最终视频地址：VIDEO_URL=${outputUrl}`,
  );
  return lines.join("\n");
}

/**
 * 旧引擎渲染入口。返回契约与 renderVertical 一致：成片必须写到 ctx.outputPath。
 *
 * 新链路不需要把图片复制到 OpenClaw 工作区 —— 那是旧路径的固有限制
 * （它的媒体读取有目录白名单），素材已由 render.ts 放进 Remotion 的 public 目录。
 */
export async function renderViaOpenClaw(ctx: RenderContext): Promise<{
  ok: boolean;
  outputPath: string;
  detail: string;
}> {
  const { outputPath, notify } = ctx;
  if (!ctx.userId) {
    return { ok: false, outputPath, detail: "旧引擎需要登录用户才能调用其自有的模型配置。" };
  }
  notify(`已上传 ${ctx.materials.length} 张参考图，正在调用龙虾(OpenClaw) Remotion 技能规划脚本…`);
  try {
    const prompt = buildLegacyPrompt(ctx);
    // 用该用户自己配置的模型与密钥（旧引擎仅用于回滚验证）。
    const result = await chatCompleteStream({
      userId: ctx.userId,
      capability: "chat",
      prompt,
      timeoutMs: readPositiveNumberEnv("OPENCLAW_VIDEO_TIMEOUT_MS", LEGACY_TIMEOUT_MS),
      onDelta: (delta) => notify(delta.replace(/\s+$/, ""))
    });
    if (!existsSync(outputPath)) {
      const hinted = extractVideoUrl(result.content);
      return {
        ok: false,
        outputPath,
        detail: hinted
          ? `旧引擎把成片写到了 ${hinted}，与约定的 ${outputPath} 不一致`
          : "旧引擎未在约定路径产出成片",
      };
    }
    return { ok: true, outputPath, detail: "旧引擎渲染完成" };
  } catch (error) {
    return { ok: false, outputPath, detail: `旧引擎调用失败：${(error as Error).message}` };
  }
}
