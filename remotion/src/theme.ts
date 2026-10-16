/**
 * 竖版短视频主题。每套主题给出一组配色、字体与动效节奏，供分镜通过 theme 字段引用。
 *
 * 主题只影响取色、字体与弹性参数，不改变组件结构——这样任何分镜都能渲染成功，
 * 观感差异来自主题而非 AI 自由发挥。
 *
 * ## spring 为什么要进主题
 *
 * 早先所有文字组件的入场动画都硬编码自己的 spring 参数，结果同一个模板在不同主题下
 * 手感不一致，看起来「不像一套东西」。现在把 damping / stiffness / mass 收到主题里，
 * 换主题就整套换手感，这是「设计感」里最难用代码描述、却最能被感知的一环。
 *
 * 取值参考本地版 OpenMontage 的主题（springConfig 同源），手感已经调过：
 * - damping 小 + stiffness 大 → 弹跳活泼（动效类）
 * - damping 大 → 稳重克制（叙事类）
 */
import { FONT_DISPLAY, FONT_MONO, FONT_SANS } from "./fonts";
// VisualEffect 现在由渲染契约（vertical/schema.ts）统一定义，
// 这里 re-export 只是为了让 `from "../theme"` 这条旧 import 路径继续可用。
import type { VisualEffect } from "./vertical/schema";
export type { VisualEffect };
export { VISUAL_EFFECTS } from "./vertical/schema";

export type SpringConfig = {
  damping: number;
  stiffness: number;
  mass: number;
};

/**
 * 视觉层：主题可以声明自己要叠加什么特效，而不只是换一套颜色。
 *
 * 早先主题只有配色 + spring，于是「酸性风 / 故障风 / 拼贴风」这类辨识度
 * 主要来自质感的风格根本表达不出来 —— 换色换不出 RGB 错位或撕纸边。
 *
 * 这些层由 VerticalStoryboard 统一挂载，组件自身不需要知道主题。
 * 空数组 = 纯净风格，只有配色与动效差异。
 *
 * 注意：`theme.effects` 是**主题的基线**，用户还可以在 `LookConfig.effects`
 * 里额外挂载，两者取并集 —— 见 `resolveEffectLayers()`。
 */

export type ThemeConfig = {
  key: string;
  label: string;
  /** 一句话说明这个风格适合什么内容，给前端下拉框当提示用。 */
  description?: string;
  /** 图片区背景色（图片未铺满时的底色）。 */
  backgroundColor: string;
  /** 卡片/浮层的底色。 */
  surfaceColor: string;
  /** 主色，用于字幕高亮、片尾落版、进度条。 */
  primaryColor: string;
  /** 强调色。 */
  accentColor: string;
  /** 正文文字色。 */
  textColor: string;
  /** 次要文字色（说明、注释）。 */
  mutedTextColor: string;
  /** 字幕文字色。 */
  captionColor: string;
  /** 字幕描边色。 */
  captionOutlineColor: string;
  /** 字幕高亮色（逐字高亮时用）。 */
  captionHighlightColor: string;
  /** 片尾卡文字色。 */
  outroColor: string;
  /** 片尾卡背景色。 */
  outroBackground: string;
  /** 标题字体族。 */
  headingFont: string;
  /** 正文字体族。 */
  bodyFont: string;
  /** 等宽字体族。 */
  monoFont: string;
  /** 图表色板（柱/线/饼/环形）。 */
  chartColors: string[];
  /** 文字与图表入场动画的弹性参数。 */
  springConfig: SpringConfig;
  /** 默认转场时长（帧，30fps）。 */
  transitionFrames: number;
  /** 氛围粒子默认颜色。 */
  particleColor: string;
  /** 是否默认开启暗角。 */
  vignette: boolean;
  /** 要叠加的视觉层。空数组 = 纯净风格。 */
  effects: VisualEffect[];
};

export const THEMES: Record<string, ThemeConfig> = {
  "warm-default": {
    key: "warm-default",
    label: "温暖治愈（默认）",
    backgroundColor: "#12100E",
    surfaceColor: "#1E1A16",
    primaryColor: "#F5C97A",
    accentColor: "#F09A5B",
    textColor: "#FFF7EA",
    mutedTextColor: "#C4B49A",
    captionColor: "#FFFFFF",
    captionOutlineColor: "#000000",
    captionHighlightColor: "#F5C97A",
    outroColor: "#FFF7EA",
    outroBackground: "#12100E",
    headingFont: FONT_DISPLAY,
    bodyFont: FONT_SANS,
    monoFont: FONT_MONO,
    chartColors: ["#F5C97A", "#F09A5B", "#E7C98A", "#C08457", "#8C6E4F", "#FFF7EA"],
    springConfig: { damping: 20, stiffness: 120, mass: 1 },
    transitionFrames: 15,
    particleColor: "#F5C97A",
    vignette: true,
    effects: [],
  },
  "cool-night": {
    key: "cool-night",
    label: "冷调夜色",
    backgroundColor: "#0B1120",
    surfaceColor: "#16213A",
    primaryColor: "#7DD3FC",
    accentColor: "#A78BFA",
    textColor: "#F8FAFC",
    mutedTextColor: "#94A3B8",
    captionColor: "#F8FAFC",
    captionOutlineColor: "#020617",
    captionHighlightColor: "#22D3EE",
    outroColor: "#E0F2FE",
    outroBackground: "#0B1120",
    headingFont: FONT_DISPLAY,
    bodyFont: FONT_SANS,
    monoFont: FONT_MONO,
    chartColors: ["#7DD3FC", "#A78BFA", "#22D3EE", "#38BDF8", "#818CF8", "#E0F2FE"],
    springConfig: { damping: 18, stiffness: 110, mass: 1 },
    transitionFrames: 15,
    particleColor: "#7DD3FC",
    vignette: true,
    effects: [],
  },
  "clean-light": {
    key: "clean-light",
    label: "明亮清新",
    backgroundColor: "#F8FAFC",
    surfaceColor: "#FFFFFF",
    primaryColor: "#2563EB",
    accentColor: "#F59E0B",
    textColor: "#1F2937",
    mutedTextColor: "#6B7280",
    captionColor: "#FFFFFF",
    captionOutlineColor: "#1F2937",
    captionHighlightColor: "#2563EB",
    outroColor: "#FFFFFF",
    outroBackground: "#0F172A",
    headingFont: FONT_DISPLAY,
    bodyFont: FONT_SANS,
    monoFont: FONT_MONO,
    chartColors: ["#2563EB", "#F59E0B", "#10B981", "#8B5CF6", "#EC4899", "#0EA5E9"],
    springConfig: { damping: 26, stiffness: 150, mass: 1 },
    transitionFrames: 12,
    particleColor: "#FDE68A",
    vignette: false,
    effects: [],
  },
  "film-revive": {
    key: "film-revive",
    label: "胶片复古",
    description: "暖褐颗粒感，适合怀旧、人文、生活记录类内容",
    backgroundColor: "#1C1917",
    surfaceColor: "#292524",
    primaryColor: "#E7C98A",
    accentColor: "#C08457",
    textColor: "#FAF7F0",
    mutedTextColor: "#A8A29E",
    captionColor: "#FAF7F0",
    captionOutlineColor: "#1C1917",
    captionHighlightColor: "#E7C98A",
    outroColor: "#FAF7F0",
    outroBackground: "#1C1917",
    headingFont: FONT_DISPLAY,
    bodyFont: FONT_SANS,
    monoFont: FONT_MONO,
    chartColors: ["#E7C98A", "#C08457", "#D6A756", "#A16207", "#78350F", "#FAF7F0"],
    springConfig: { damping: 24, stiffness: 95, mass: 1.1 },
    transitionFrames: 18,
    particleColor: "#E7C98A",
    vignette: true,
    effects: [],
  },

  /* ---------------- 2026-10 新增：辨识度来自质感的风格 ---------------- */

  "acid-graphics": {
    key: "acid-graphics",
    label: "酸性设计",
    description: "高饱和流体渐变与金属光泽，适合潮玩、电音、潮流文化类内容",
    backgroundColor: "#0A0118",
    surfaceColor: "#1A0B2E",
    primaryColor: "#FF2E97",
    accentColor: "#00F0FF",
    textColor: "#FFFFFF",
    mutedTextColor: "#B794D6",
    captionColor: "#FFFFFF",
    captionOutlineColor: "#0A0118",
    captionHighlightColor: "#FFE600",
    outroColor: "#FFFFFF",
    outroBackground: "#0A0118",
    headingFont: FONT_DISPLAY,
    bodyFont: FONT_SANS,
    monoFont: FONT_MONO,
    chartColors: ["#FF2E97", "#00F0FF", "#FFE600", "#B026FF", "#39FF14", "#FFFFFF"],
    // 酸性风的动效要「弹」且带惯性：低阻尼 + 中刚度
    springConfig: { damping: 9, stiffness: 140, mass: 0.9 },
    transitionFrames: 10,
    particleColor: "#FF2E97",
    vignette: false,
    effects: ["acid-flow"],
  },

  "glitch-art": {
    key: "glitch-art",
    label: "故障艺术",
    description: "RGB 错位与画面撕裂，适合科技、悬疑、游戏、赛博类内容",
    backgroundColor: "#050505",
    surfaceColor: "#141414",
    primaryColor: "#00FFF0",
    accentColor: "#FF003C",
    textColor: "#F2F2F2",
    mutedTextColor: "#8A8A8A",
    captionColor: "#FFFFFF",
    captionOutlineColor: "#000000",
    captionHighlightColor: "#00FFF0",
    outroColor: "#00FFF0",
    outroBackground: "#050505",
    headingFont: FONT_DISPLAY,
    bodyFont: FONT_SANS,
    monoFont: FONT_MONO,
    chartColors: ["#00FFF0", "#FF003C", "#FFE600", "#7B61FF", "#FFFFFF", "#8A8A8A"],
    // 故障感来自「不连贯」：阻尼极低，元素像被信号打断一样弹出
    springConfig: { damping: 7, stiffness: 190, mass: 0.7 },
    transitionFrames: 6,
    particleColor: "#00FFF0",
    vignette: true,
    effects: ["glitch"],
  },

  "collage-zine": {
    key: "collage-zine",
    label: "拼贴胶带",
    description: "撕纸边与手写贴纸，适合种草、好物分享、青年文化类内容",
    backgroundColor: "#F4EFE6",
    surfaceColor: "#FFFFFF",
    primaryColor: "#E8552F",
    accentColor: "#2B4ACB",
    textColor: "#1A1A1A",
    mutedTextColor: "#6B6459",
    captionColor: "#FFFFFF",
    captionOutlineColor: "#1A1A1A",
    captionHighlightColor: "#FFD84D",
    outroColor: "#F4EFE6",
    outroBackground: "#1A1A1A",
    headingFont: FONT_DISPLAY,
    bodyFont: FONT_SANS,
    monoFont: FONT_MONO,
    chartColors: ["#E8552F", "#2B4ACB", "#FFD84D", "#2E7D5B", "#1A1A1A", "#F4EFE6"],
    // 拼贴风要有「贴上去」的手感：中等阻尼 + 中等刚度
    springConfig: { damping: 12, stiffness: 170, mass: 1 },
    transitionFrames: 9,
    particleColor: "#FFD84D",
    vignette: false,
    effects: ["collage"],
  },

  "swiss-grid": {
    key: "swiss-grid",
    label: "瑞士网格",
    description: "严格网格与大留白，适合知识科普、商业分析、专业解读类内容",
    backgroundColor: "#FAFAF8",
    surfaceColor: "#FFFFFF",
    primaryColor: "#E2231A",
    accentColor: "#1A1A1A",
    textColor: "#111111",
    mutedTextColor: "#6E6E6E",
    captionColor: "#FFFFFF",
    captionOutlineColor: "#111111",
    captionHighlightColor: "#E2231A",
    outroColor: "#FAFAF8",
    outroBackground: "#111111",
    headingFont: FONT_DISPLAY,
    bodyFont: FONT_SANS,
    monoFont: FONT_MONO,
    chartColors: ["#E2231A", "#1A1A1A", "#4A6FA5", "#2E7D5B", "#B58900", "#6E6E6E"],
    // 瑞士风克制、不弹：高阻尼让元素干脆到位
    springConfig: { damping: 30, stiffness: 220, mass: 1 },
    transitionFrames: 8,
    particleColor: "#E2231A",
    vignette: false,
    effects: ["swiss-grid"],
  },

  "mono-ink": {
    key: "mono-ink",
    label: "单色水墨",
    description: "黑白灰加一笔朱红，适合人文、书法、东方美学类内容",
    backgroundColor: "#F7F5F0",
    surfaceColor: "#FFFFFF",
    primaryColor: "#B03A2E",
    accentColor: "#2C3E50",
    textColor: "#1C1C1C",
    mutedTextColor: "#7A7570",
    captionColor: "#FFFFFF",
    captionOutlineColor: "#1C1C1C",
    captionHighlightColor: "#B03A2E",
    outroColor: "#F7F5F0",
    outroBackground: "#1C1C1C",
    headingFont: FONT_DISPLAY,
    bodyFont: FONT_SANS,
    monoFont: FONT_MONO,
    chartColors: ["#B03A2E", "#2C3E50", "#7A7570", "#1C1C1C", "#D5D0C8", "#F7F5F0"],
    springConfig: { damping: 26, stiffness: 130, mass: 1.1 },
    transitionFrames: 14,
    particleColor: "#B03A2E",
    vignette: false,
    effects: [],
  },
};

export const DEFAULT_THEME_KEY = "warm-default";

export function resolveTheme(key: unknown): ThemeConfig {
  const k = typeof key === "string" ? key.trim() : "";
  return THEMES[k] ?? THEMES[DEFAULT_THEME_KEY];
}

export const THEME_KEYS = Object.keys(THEMES);

/**
 * 用主题的 spring 参数生成 Remotion 的 spring() 配置。
 *
 * 组件默认直接传 `spring={theme.springConfig}`（见 OverlayLayer）；
 * 这个 helper 只在需要局部覆盖某个参数时用（例如同时改阻尼与刚度）。
 */
export function themeSpring(
  theme: ThemeConfig,
  overrides: Partial<SpringConfig> = {}
): { damping: number; stiffness: number; mass: number } {
  return { ...theme.springConfig, ...overrides };
}