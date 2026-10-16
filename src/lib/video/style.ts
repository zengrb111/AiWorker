/**
 * 风格推断：根据素材的主色与内容，自动挑选最协调的主题。
 *
 * 为什么需要：用户不该为了「图是暖的还是冷的」这种细节去手动选风格。
 * 识图拿到每张图的 dominantColor 后，这里算出一个整体色调画像，
 * 再映射到 theme.ts 里最合适的那一套。
 *
 * 设计约束：
 * - **纯函数、确定性**。同样的输入必须给同样的结果，否则同一批素材两次出片
 *   风格不同，用户会以为出了 bug。
 * - **不匹配时返回 null**，让调用方用默认主题，而不是硬挑一个接近的。
 * - 只按「色相 + 明度 + 饱和度」判断，不猜内容情绪 —— 情绪判断留给 AI 分镜，
 *   这里只解决「画面和主题底色打不打架」这个纯技术问题。
 */

import { resolveTheme, THEMES, type ThemeConfig } from "../../../remotion/src/theme";
import type { MaterialInsight } from "./storyboard";

/** 供推断使用的最小字段集：只需要色调，不需要完整识图结果。 */
type ToneSource = { dominantColor: string; caption?: string };

export type StyleChoice = {
  themeKey: string;
  /** 为什么选它，给日志和 UI 提示用。 */
  reason: string;
  /** 该主题的配置，方便调用方直接用。 */
  theme: ThemeConfig;
};

type Hsv = { h: number; s: number; v: number };

/** hex → HSV。h 取值 0~360，s/v 取值 0~1。 */
function hexToHsv(hex: string): Hsv {
  const clean = (hex ?? "").replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const n = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return { h: 0, s: 0, v: 0.5 };
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, v };
}

/** 色相所属的大类。 */
type HueFamily = "red" | "orange" | "yellow" | "green" | "cyan" | "blue" | "purple" | "pink" | "neutral";

function hueFamily(h: number, s: number, v: number): HueFamily {
  // 低饱和或极暗极亮时视为无色相 —— 这类图配中性主题最稳
  if (s < 0.12 || v < 0.08 || v > 0.96) return "neutral";
  if (h < 15 || h >= 345) return "red";
  if (h < 45) return "orange";
  if (h < 70) return "yellow";
  if (h < 160) return "green";
  if (h < 200) return "cyan";
  if (h < 260) return "blue";
  if (h < 300) return "purple";
  return "pink";
}

/** 整体明度（0~1）与饱和度（0~1）的均值。 */
function averageTone(colors: string[]): { v: number; s: number; families: HueFamily[] } {
  const hsvs = colors.filter(Boolean).map(hexToHsv);
  if (hsvs.length === 0) return { v: 0.5, s: 0, families: ["neutral"] };
  const v = hsvs.reduce((a, x) => a + x.v, 0) / hsvs.length;
  const s = hsvs.reduce((a, x) => a + x.s, 0) / hsvs.length;
  return {
    v,
    s,
    families: hsvs.map((x) => hueFamily(x.h, x.s, x.v)),
  };
}

/** 出现次数最多的色相家族。 */
function dominantFamily(families: HueFamily[]): HueFamily {
  const tally = new Map<HueFamily, number>();
  for (const f of families) tally.set(f, (tally.get(f) ?? 0) + 1);
  let best: HueFamily = "neutral";
  let bestCount = -1;
  for (const [f, c] of tally) {
    if (c > bestCount) {
      best = f;
      bestCount = c;
    }
  }
  return best;
}

/**
 * 推断风格。
 *
 * 规则按优先级从强到弱：
 *   1. 明度优先 —— 亮图配亮主题、暗图配暗主题，这是最不能违背的一条
 *      （亮图配深色主题会让字幕和图都糊成一片）
 *   2. 色相定调 —— 同明度下按主色相挑气质相符的主题
 *   3. 饱和度 —— 高饱和才敢用酸性这类强风格，低饱和走克制路线
 *
 * 返回 null 表示「没有明显倾向」，调用方应保持用户选择或默认主题。
 */
export function inferStyle(
  insights: ToneSource[],
  fallbackThemeKey?: string
): StyleChoice | null {
  // 至少要有带色调的结果才推断，否则交给调用方决定
  const usable = insights.filter((i) => i.dominantColor);
  if (usable.length === 0) return null;

  const { v, s, families } = averageTone(usable.map((i) => i.dominantColor));
  const family = dominantFamily(families);

  const pick = (key: string, reason: string): StyleChoice => {
    const theme = THEMES[key] ?? resolveTheme(fallbackThemeKey);
    return { themeKey: key, reason, theme };
  };

  // 1) 明度优先
  if (v >= 0.82) {
    // 很亮的图：只能用亮主题。亮主题里再按饱和度分。
    if (s >= 0.45) return pick("collage-zine", `素材整体高亮且高饱和（v=${v.toFixed(2)}），拼贴胶带风的浅底最能承住`);
    return pick("swiss-grid", `素材整体高亮低饱和（v=${v.toFixed(2)}），瑞士网格的浅底与大留白最协调`);
  }
  if (v <= 0.3) {
    // 很暗的图：深色主题。暗调里按色相分。
    if (family === "blue" || family === "cyan") {
      return pick("cool-night", `素材偏暗且主色为冷色（${family}），配冷调夜色`);
    }
    if (s >= 0.4) {
      return pick("glitch-art", `素材很暗且高饱和（v=${v.toFixed(2)} s=${s.toFixed(2)}），故障艺术的霓虹错位最搭`);
    }
    return pick("film-revive", `素材偏暗低饱和（v=${v.toFixed(2)}），胶片复古的暗调颗粒最协调`);
  }

  // 2) 中间明度：按色相与饱和度
  if (s >= 0.5) {
    if (family === "pink" || family === "purple" || family === "red") {
      return pick("acid-graphics", `素材主色为${family}且高饱和（s=${s.toFixed(2)}），酸性设计的霓虹流体最搭`);
    }
    if (family === "orange" || family === "yellow") {
      return pick("acid-graphics", `素材暖色高饱和（${family}），酸性风的高饱和渐变能接住`);
    }
  }

  if (family === "neutral" && s < 0.2) {
    return pick("mono-ink", `素材接近黑白灰（s=${s.toFixed(2)}），单色水墨最不容易打架`);
  }

  if (family === "green" || family === "cyan") {
    return pick("cool-night", `素材主色偏冷绿/青（${family}），冷调夜色更协调`);
  }

  // 3) 无明显倾向
  return null;
}

/** 主题下拉框选项（含分组标题用的描述），供前端直接用。 */
export function listThemeOptions(): { key: string; label: string; description: string }[] {
  return Object.values(THEMES).map((t) => ({
    key: t.key,
    label: t.label,
    description: t.description ?? "",
  }));
}
