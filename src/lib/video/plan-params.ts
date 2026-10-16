/**
 * 视频方案相关的请求参数解析（gen-video/plan 与 gen-video 两条路由共用）。
 *
 * 为什么单独抽出来：规划与渲染是两次请求，用户在两次之间调整的效果参数
 * （外挂特效 / 运镜 / 字幕样式）必须被**同一份规则**解析，否则会出现
 * 「面板上选了故障风、渲染出来却不是」这种极难查的不一致。
 */
import {
  CAPTION_STYLES,
  VISUAL_EFFECTS,
  type CaptionStyleKey,
  type CameraMotion,
  type LookConfig,
  type VisualEffect,
} from "./storyboard";

const CAMERA_MOTIONS_VALID: CameraMotion[] = [
  "zoom-in",
  "zoom-out",
  "pan-left",
  "pan-right",
  "ken-burns",
  "drift-up",
  "drift-down",
  "parallax",
  "static",
];

/**
 * 从 form 里读外观覆盖。
 *
 * 约定（全部可选，缺省=保持改造前观感）：
 * - `lookEffects`：逗号分隔，如 `glitch,swiss-grid`；空字符串 = 只用主题自带的
 * - `lookMotion`：`auto` 或空 = 跟随分镜逐场景指定的运镜
 * - `captionStyle`：字幕样式键
 *
 * 非法值一律**静默丢弃**而不是报错：这些是观感偏好，选错了最多效果不对，
 * 不该让用户「参数填错」导致出不了片（这与 theme 的处理策略一致）。
 */
export function parseLookFromForm(form: FormData): LookConfig | undefined {
  const look: LookConfig = {};

  const rawEffects = String(form.get("lookEffects") ?? "").trim();
  if (rawEffects) {
    const picked = rawEffects
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is VisualEffect => VISUAL_EFFECTS.includes(s as VisualEffect));
    // 去重，且限制最多 2 层：叠 3 层以上画面会糊成一片，反而不如不加。
    look.effects = Array.from(new Set(picked)).slice(0, 2);
  }

  const rawMotion = String(form.get("lookMotion") ?? "").trim();
  if (rawMotion && rawMotion !== "auto" && CAMERA_MOTIONS_VALID.includes(rawMotion as CameraMotion)) {
    look.motion = rawMotion as CameraMotion;
  }

  const rawCaption = String(form.get("captionStyle") ?? "").trim();
  if (CAPTION_STYLES.includes(rawCaption as CaptionStyleKey)) {
    look.captionStyle = rawCaption as CaptionStyleKey;
  }

  return Object.keys(look).length ? look : undefined;
}

/** 供前端渲染选择器用的可选项清单（避免前端再手抄一份映射表）。 */
export const LOOK_OPTIONS = {
  effects: [
    { value: "glitch", label: "故障艺术" },
    { value: "acid-flow", label: "酸性流体" },
    { value: "collage", label: "撕纸拼贴" },
    { value: "swiss-grid", label: "瑞士网格" },
  ],
  motions: [
    { value: "auto", label: "跟随分镜（AI 逐镜头挑选）" },
    { value: "ken-burns", label: "缓慢推进" },
    { value: "parallax", label: "视差景深" },
    { value: "zoom-in", label: "推近" },
    { value: "drift-up", label: "上移" },
    { value: "drift-down", label: "下移" },
    { value: "static", label: "静止" },
  ],
  captions: [
    { value: "classic", label: "经典白字" },
    { value: "bold-yellow", label: "醒目黄字" },
    { value: "boxed-dark", label: "半透明底框" },
    { value: "minimal-line", label: "极简细描边" },
  ],
} as const;

/** 把 Look 序列化回 form 字段（前端二次提交时用）。 */
export function lookToFormFields(look: LookConfig | undefined): Record<string, string> {
  return {
    lookEffects: (look?.effects ?? []).join(","),
    lookMotion: look?.motion ?? "auto",
    captionStyle: look?.captionStyle ?? "classic",
  };
}

