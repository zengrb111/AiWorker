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

/**
 * 从命令行 flag 解析外观覆盖（CLI 专用）。
 *
 * 与 `parseLookFromForm` 共用同一套校验规则，只是数据来源从 FormData 变成
 * 单个 flag 值。抽成这个形式是为了让 CLI（scripts/aiworker-video.mts）不必
 * 每次构造 FormData，同时保证「面板选的」与「OpenClaw 传的」行为一致。
 *
 * 调用方每次只设一个字段，多次调用时用展开合并：
 *   args.look = { ...(args.look ?? {}), ...parseLookFromFlags(form) };
 */
export function parseLookFromFlags(form: FormData): LookConfig | undefined {
  return parseLookFromForm(form);
}

/**
 * 解析请求里的新闻事实（标题 + 摘要）。
 *
 * 这段 JSON 是从「热点一键生成视频」的 prepare 阶段原样带过来的，
 * 目的是让旁白基于**真实新闻内容**写稿，而不是只按创作要求凭空编。
 *
 * 服务端刻意不严格校验：它只是提示素材，脏一点顶多文案差一点，
 * 不该让用户因为一个附加字段而无法出片。解析失败一律当空处理。
 */
export function parseNewsItems(
  form: FormData,
): Array<{ title: string; snippet: string; isPrimary: boolean }> {
  const raw = String(form.get("newsItems") ?? "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const items = parsed
      .map((item) => {
        const o = item as { title?: unknown; snippet?: unknown; isPrimary?: unknown };
        return {
          title: typeof o.title === "string" ? o.title.slice(0, 200) : "",
          snippet: typeof o.snippet === "string" ? o.snippet.slice(0, 400) : "",
          isPrimary: o.isPrimary === true,
        };
      })
      .filter((item) => item.title.trim())
      .slice(0, 12);
    if (!items.length) return [];
    // 没有显式标记主新闻时，第一条视为主新闻 ——
    // 「一条视频只讲一条新闻」是硬约束，不能因为标记缺失就退化成全都写进去。
    if (!items.some((item) => item.isPrimary)) items[0].isPrimary = true;
    return items;
  } catch {
    return [];
  }
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

