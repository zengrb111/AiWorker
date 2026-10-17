/**
 * 视频分镜契约（Remotion 渲染层与 AI 规划层之间唯一的接口）。
 *
 * 设计要点：不让 AI 决定「怎么渲染」，只让它决定「这一句话配哪张图、什么运镜、
 * 要不要压什么文字」。渲染由固定模板完成，保证观感一致、可复现、可测试。
 *
 * ## 为什么用绝对时间轴而不是相对时长
 *
 * 早先的契约是 `sceneDurationSeconds`（每段多少秒），成片时长取「各段之和」。
 * 这个设计有一个无法回避的缺陷：**成片时长有两个独立来源** ——
 * 一边是 AI 估出来的分镜长度，另一边是 TTS 合成的真实配音时长。
 * 两者对不上时只能事后弥合：短了用 `tpad=clone`冻结末帧补，长了尾部没人填充直接黑屏。
 * 用户看到的「结尾口播没说完、视频已经停了」就是这么来的。
 *
 * 现在改成**绝对时间轴**：把 TTS 的句级时间戳（`TimelineBeat`）作为骨架喂给 AI，
 * AI 只需要为每一句指定画面与文字，成片长度 = 最后一个画面元素的出点时间，
 * 它由构造就等于口播长度 —— 不可能掐断，也不再需要 pad/trim 兜底。
 *
 * 这与本地版 `OpenMontage` 的 `cuts[].out_seconds` 是同一套思路。
 */

/** 运镜类型。 */
export type CameraMotion =
  | "zoom-in"
  | "zoom-out"
  | "pan-left"
  | "pan-right"
  | "ken-burns"
  | "drift-up"
  | "drift-down"
  | "parallax"
  | "static";

export const CAMERA_MOTIONS: CameraMotion[] = [
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

/** 氛围粒子类型。 */
export type ParticleType = "fireflies" | "petals" | "sparkles" | "mist" | "light-rays" | "none";

export const PARTICLE_TYPES: ParticleType[] = [
  "fireflies",
  "petals",
  "sparkles",
  "mist",
  "light-rays",
  "none",
];

/** 转场类型（片段拼接用）。 */
export type TransitionKind = "none" | "fade" | "slide" | "wipe";

export const TRANSITION_KINDS: TransitionKind[] = ["none", "fade", "slide", "wipe"];

/**
 * 视觉特效层（可叠加在任意主题之上）。
 *
 * ## 为什么定义在 schema 而不是 theme
 *
 * 早先 `VisualEffect` 定义在 theme.ts，于是「特效」只能是主题的私有属性：
 * `ThemeEffects` 只读 `theme.effects`，`VISUAL_EFFECTS` 导出后零消费方，
 * 想加一个故障层就得新建一套主题。现在把它提到渲染契约里，`LookConfig.effects`
 * 才能与主题解耦 —— 用户可以要「故障感」但仍用暖色配色。
 *
 * theme.ts 会从这里 re-export，旧 import 路径不断。
 */
export type VisualEffect =
  /** RGB 色彩错位 + 像素偏移 + 扫描线（故障艺术） */
  | "glitch"
  /** 高饱和流体渐变 + 金属光泽（酸性设计） */
  | "acid-flow"
  /** 撕纸边框 + 胶带贴纸 + 复印噪点（拼贴胶带风） */
  | "collage"
  /** 严格网格线 + 十字标记（瑞士网格） */
  | "swiss-grid";

export const VISUAL_EFFECTS: VisualEffect[] = ["glitch", "acid-flow", "collage", "swiss-grid"];

/** 特效层的中文名，给前端选择器与方案摘要用。 */
export const VISUAL_EFFECT_LABELS: Record<VisualEffect, string> = {
  glitch: "故障艺术",
  "acid-flow": "酸性流体",
  collage: "撕纸拼贴",
  "swiss-grid": "瑞士网格",
};

/**
 * 字幕样式（**ffmpeg 烧录阶段生效**，不是 Remotion 组件）。
 *
 * 出片链路的字幕由 `burnSubtitles` 用 libass 烧录，Remotion 的 `CaptionLayer`
 * 实际空转（见其文件头注释）。所以字幕样式必须走这条通道，
 * 否则用户选了样式却看不到任何变化。
 */
export type CaptionStyleKey = "classic" | "bold-yellow" | "boxed-dark" | "minimal-line";

export const CAPTION_STYLES: CaptionStyleKey[] = [
  "classic",
  "bold-yellow",
  "boxed-dark",
  "minimal-line",
];

export const CAPTION_STYLE_LABELS: Record<CaptionStyleKey, string> = {
  classic: "经典白字",
  "bold-yellow": "醒目黄字",
  "boxed-dark": "半透明底框",
  "minimal-line": "极简细描边",
};

/**
 * 外观覆盖（Look）。
 *
 * 设计取向：**主题定基调，Look 做加法与微调**。
 * 早先只有 `theme: string` 一个视觉字段，等于把 20 个视觉参数打包成不可拆的组合，
 * 用户改一个维度就得整套换主题。LookConfig 只开放「改动收益最大且互不冲突」的三个维度：
 * ① 叠加特效层（加法，不破坏主题配色）
 * ② 统一运镜（覆盖逐场景选择，用来压制 AI 选出难看的运镜）
 * ③ 字幕样式（走 ffmpeg 通道）
 *
 * 不开放颜色/字体/spring —— 那三个是主题的定义本身，拆开会让 9 套主题失去意义。
 */
export type LookConfig = {
  /**
   * 要额外叠加的特效层，与主题自带的 `theme.effects` **取并集**（去重、保持顺序）。
   * 空数组 = 只用主题自带的。
   */
  effects?: VisualEffect[];
  /**
   * 强制所有场景用同一运镜；缺省 = 保留 DSH 逐场景指定的 `scenes[].animation`。
   * 传 "auto" 等价于不覆盖（用户界面上的「跟随分镜」选项）。
   */
  motion?: CameraMotion;
  /** 字幕样式；缺省 "classic"（与改造前观感一致）。 */
  captionStyle?: CaptionStyleKey;
};

/** 校验 LookConfig，把错误回喂给调用方而不是静默忽略。 */
export function validateLook(input: unknown, errors: string[]): void {
  if (input === undefined || input === null) return;
  const look = input as Partial<LookConfig>;
  if (typeof look !== "object") {
    errors.push("look 必须是对象");
    return;
  }
  if (look.effects !== undefined) {
    if (!Array.isArray(look.effects)) {
      errors.push("look.effects 必须是数组");
    } else {
      look.effects.forEach((e, i) => {
        if (!VISUAL_EFFECTS.includes(e as VisualEffect)) {
          errors.push(`look.effects[${i}] 必须是：${VISUAL_EFFECTS.join(" / ")}`);
        }
      });
    }
  }
  if (look.motion !== undefined && !CAMERA_MOTIONS.includes(look.motion as CameraMotion)) {
    errors.push(`look.motion 必须是：${CAMERA_MOTIONS.join(" / ")}`);
  }
  if (look.captionStyle !== undefined && !CAPTION_STYLES.includes(look.captionStyle as CaptionStyleKey)) {
    errors.push(`look.captionStyle 必须是：${CAPTION_STYLES.join(" / ")}`);
  }
}

/** 字幕条目（毫秒时间戳，来自 TTS）。 */
export type CaptionCue = {
  text: string;
  startMs: number;
  endMs: number;
};

/**
 * 时间轴锚点（毫秒）。
 *
 * 由 TTS 的句级字幕折叠而成：一句话对应一个 beat，是整条时间轴的骨架。
 * AI 产出的 scene / overlay 必须挂在这个骨架上，不允许自由发明时间点。
 */
export type TimelineBeat = {
  /** 该句在旁白里的时间戳（毫秒）。 */
  startMs: number;
  endMs: number;
  /** 该句的原文，供 AI 判断这句该配什么画面。 */
  text: string;
};

/**
 * 文字 / 图层类型。
 *
 * ## 两类图层，职责严格分离
 *
 * - **规划型**（前 9 种）：由 DSH 自由决定「这句话压什么文字」，只带单值字段。
 * - **数据型**（后 6 种）：**不由模型输出**，由服务端把文章分析产出的
 *   `article.charts`（已过溯源闸门）翻译成 OverlaySpec 注入（见 src/lib/video/chart-overlays.ts）。
 *
 * 为什么要分开而不是都交给模型：
 * 1. 图表的**数值必须可溯源**。模型照着二手摘要重新编一遍数字，溯源闸门就白设了；
 * 2. 让模型输出多系列坐标轴与 N×M 规格表，它会编字段名，校验重试一次就是一分多钟。
 *
 * 于是分镜 prompt 的 kind 取值域只给前 9 种（`PLANNED_OVERLAY_KINDS`）。
 */
export type OverlayKind =
  /* 规划型：由 DSH 输出 */
  | "section_title"
  | "stat_reveal"
  | "hero_title"
  | "provider_chip"
  | "stat_card"
  | "text_card"
  | "callout"
  | "comparison"
  | "progress"
  /* 数据型：由服务端从文章图表注入，模型不许输出 */
  | "bar_chart"
  | "line_chart"
  | "donut"
  | "kpi_grid"
  | "spec_table"
  | "bullet_list";

/** 全部合法图层类型（渲染层与校验器认这一份）。 */
export const OVERLAY_KINDS: OverlayKind[] = [
  "section_title",
  "stat_reveal",
  "hero_title",
  "provider_chip",
  "stat_card",
  "text_card",
  "callout",
  "comparison",
  "progress",
  "bar_chart",
  "line_chart",
  "donut",
  "kpi_grid",
  "spec_table",
  "bullet_list",
];

/** 交给 DSH 自由规划的图层类型 —— prompt 的取值域只能给这一份。 */
export const PLANNED_OVERLAY_KINDS: OverlayKind[] = OVERLAY_KINDS.slice(0, 9);

/** 数据型图层类型，服务端注入用。 */
export const DATA_OVERLAY_KINDS: OverlayKind[] = OVERLAY_KINDS.slice(9);

/** 数据型图层的中文名，给方案摘要与提示文案用。 */
export const DATA_OVERLAY_KIND_LABELS: Record<string, string> = {
  bar_chart: "柱状图",
  line_chart: "折线图",
  donut: "环形图",
  kpi_grid: "数字卡组",
  spec_table: "规格表",
  bullet_list: "要点卡片",
};

/** 位置。 */
export type OverlayPosition = "top" | "center" | "bottom";

export const OVERLAY_POSITIONS: OverlayPosition[] = ["top", "center", "bottom"];

/** 图片分镜场景。 */
export type SceneSpec = {
  id: string;
  /** 1~4 张图片路径，按顺序交叉淡化。 */
  images: string[];
  /**
   * 本场景的出点时间（**绝对秒**），与 TimelineBeat.endMs/1000 对齐。
   *
   * 必填。渲染排版与成片总长都由它推导：成片长度 = 最后一个场景的 outSeconds + 片尾，
   * 因此它天然等于口播长度，不会出现「口播被掐断」。
   */
  outSeconds: number;
  animation: CameraMotion;
  particles?: ParticleType;
  particleColor?: string;
  /** 0~1，缺省 0.6。 */
  particleIntensity?: number;
  /** 缺省 true。 */
  vignette?: boolean;
  lightingFrom?: string;
  lightingTo?: string;
  backgroundColor?: string;
  /** 场景专属背景图（叠加在图片区之下）。 */
  backgroundImage?: string;
  /** 背景图上的暗色遮罩强度 0~1，越大越压暗以突出前景。缺省 0.45。 */
  backgroundOverlay?: number;
};

/** 图表里的一个数据点。label 与 value 是唯一的必需字段，其余按 kind 取用。 */
export type ChartDataPoint = { label: string; value: number };

/** 折线图的一个系列。 */
export type ChartSeries = { name: string; points: ChartDataPoint[] };

/** 数字卡组里的一张卡。value/unit/delta 分开存，才能让单位用小字异色渲染。 */
export type KpiCard = {
  value: string;
  unit?: string;
  label?: string;
  delta?: string;
  deltaLabel?: string;
};

/**
 * 文字图层。
 *
 * 与场景分离的独立图层，有自己的绝对进出时间 —— 同一句旁白可以既换图又压一张数据卡。
 * 这是「文字动效」的全部来源：本地版 Explainer 的 overlays 就是这套东西。
 *
 * 单值字段（value / label / progress…）只服务于规划型图层；
 * 数组字段（items / series / cards / rows / bullets）只服务于数据型图层 ——
 * 早先这里只有单值字段，于是渲染层只能表达「一句话配一块浮层」，
 * 多系列坐标轴、N 行 N 列规格表这类**信息密度**在契约层就写不出来。
 */
export type OverlaySpec = {
  id: string;
  kind: OverlayKind;
  /** 进场时间（绝对秒），缺省挂到所属场景的起点。 */
  inSeconds?: number;
  /** 出点时间（绝对秒），缺省与所属场景的出点相同。 */
  outSeconds?: number;
  position?: OverlayPosition;
  text?: string;
  subtitle?: string;
  /** stat_reveal / stat_card 用；数据型图层里作图表标题的兜底。 */
  value?: string;
  label?: string;
  /** callout 用。 */
  tone?: "info" | "warning" | "tip" | "quote";
  /** comparison 用。 */
  leftLabel?: string;
  rightLabel?: string;
  leftValue?: string;
  rightValue?: string;
  /** progress 用。 */
  progress?: number;
  /** provider_chip 用。 */
  providers?: string[];
  /** 覆盖主题主色。 */
  accentColor?: string;

  /* ---------------- 数据型图层专用（服务端从文章图表注入） ---------------- */

  /** bar_chart / donut 用：横轴或环的构成项。 */
  items?: ChartDataPoint[];
  /** line_chart 用：多条折线。 */
  series?: ChartSeries[];
  /** kpi_grid 用：一组数字卡。 */
  cards?: KpiCard[];
  /** spec_table 用：表头。列数即 rows 每行的长度。 */
  columns?: string[];
  /** spec_table 用：数据行。 */
  rows?: string[][];
  /** bullet_list 用：要点卡片文案。 */
  bullets?: string[];
  /** 数值单位（显示在轴标注 / 大数字右侧的小字）。 */
  unit?: string;
  /** 图下方的注释。 */
  note?: string;
  /** 高亮项下标：bar / donut / line 会把这一项描成主色、其余压成低饱和。 */
  highlightIndex?: number;
};

/**
 * 常驻页面装饰（贯穿全片，不是某个时间段的图层）。
 *
 * 为什么要挂在 storyboard 而不是 overlay：
 * overlay 有一个致命的约束 —— 它的 outSeconds 不能超过最后一个场景的出点
 * （schema 校验里就是这么写的，否则文字会压到下一个镜头）。
 * 而「顶部彩条 + 页眉 + 底部进度线」这种**从第 0 帧贯穿到最后一帧**的东西
 * 在 overlay 机制里根本无法表达，所以它是 storyboard 的一等字段。
 *
 * 全字段可选；全空时不渲染任何东西，对既有分镜零影响。
 */
export type ChromeSpec = {
  /** 顶部 6px 主题彩条。 */
  topBar?: boolean;
  /** 页眉主文字（左上角）。 */
  headerText?: string;
  /** 页眉副文字。 */
  headerSubtitle?: string;
  /** 页脚文字（右下角），常用于标注来源。 */
  footerText?: string;
  /** 页脚下方的常驻进度线（按时间轴线性推进）。 */
  progress?: boolean;
  /** 页眉/页脚文字色，缺省取主题正文色。 */
  color?: string;
};

/** 片尾卡。 */
export type OutroSpec = {
  text: string;
  /** 缺省 2.5。 */
  durationSeconds?: number;
  subtitle?: string;
};

/** 图片→视频分镜（一键生成视频 / 后台出片）。 */
export type Storyboard = {
  version: 1;
  theme: string;
  width: 1080;
  height: 1920;
  fps: 30;
  /**
   * 口播总长（秒），等于 TimelineBeat 末点的 endMs/1000。
   *
   * 注意：渲染时长**不再**由它决定（那正是掐断的根源），只作为校验基准与兜底分镜的输入。
   */
  durationSeconds: number;
  /** 绝对时间轴骨架，通常来自 TTS 句级字幕。 */
  beats: TimelineBeat[];
  scenes: SceneSpec[];
  overlays?: OverlaySpec[];
  captions?: CaptionCue[];
  outro?: OutroSpec;
  /**
   * 外观覆盖（可选）：在主题之上叠加特效 / 统一运镜 / 指定字幕样式。
   *
   * 由**用户或产品**决定，不交给 DSH —— 观感偏好不是模型该猜的东西，
   * 交给模型只会得到「每次不一样的风格」，反而不可复现。
   */
  look?: LookConfig;
  /**
   * 常驻页面装饰（可选）：顶部彩条 / 页眉 / 页脚 / 进度线。
   *
   * 由**服务端**填（文章转视频时带文章标题与来源），不交给 DSH ——
   * 模型每次给不同的页眉文案会让成片风格漂移。
   */
  chrome?: ChromeSpec;
};

/** 视频片段（剪视频 / 复刻用）。 */
export type ClipSpec = {
  id: string;
  /** 相对 public 的路径（配合 staticFile()）。 */
  src: string;
  /** 裁切起点（秒），缺省从 0 开始。 */
  trimStartSeconds?: number;
  /** 出点时间（绝对秒）。成片总长由最后一个 clip 的 outSeconds 推导。 */
  outSeconds: number;
  /** 进入本片段的转场（第一个片段忽略）。 */
  transition?: TransitionKind;
};

/** 片段→成片分镜（一键剪视频 / 一键复刻爆款）。 */
export type ClipStoryboard = {
  version: 1;
  theme: string;
  width: 1080;
  height: 1920;
  fps: 30;
  durationSeconds: number;
  /** ASR 句级字幕，作为剪辑点骨架。 */
  beats: TimelineBeat[];
  clips: ClipSpec[];
  overlays?: OverlaySpec[];
  captions?: CaptionCue[];
  outro?: OutroSpec;
  /** 与 Storyboard 同构的外观覆盖，供两条链路共用同一套校验。 */
  look?: LookConfig;
  /** 与 Storyboard 同构的常驻页面装饰。 */
  chrome?: ChromeSpec;
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** 允许的最大出点误差（秒）：末场景收尾与口播结束的正常呼吸，留一点余量。 */
const TAIL_TOLERANCE_SECONDS = 2.5;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function checkCaptions(cues: unknown, errors: string[]): void {
  if (cues === undefined) return;
  if (!Array.isArray(cues)) {
    errors.push("captions 必须是数组");
    return;
  }
  cues.forEach((cue, i) => {
    const c = cue as Partial<CaptionCue> | null;
    if (!c || typeof c.text !== "string" || !c.text.trim()) {
      errors.push(`captions[${i}].text 缺失或为空`);
      return;
    }
    // 同 beats：首条字幕从 0 毫秒开始是正常的，不该判成错误。
    const startOk = typeof c.startMs === "number" && Number.isFinite(c.startMs) && c.startMs >= 0;
    if (!startOk || !isPositiveNumber(c.endMs as number)) {
      errors.push(`captions[${i}] 的 startMs 必须是不小于 0 的数字，endMs 必须是正数`);
      return;
    }
    if ((c.endMs as number) <= (c.startMs as number)) {
      errors.push(`captions[${i}] 的 endMs 必须大于 startMs`);
    }
  });
}

function checkOutro(outro: unknown, errors: string[]): void {
  if (outro === undefined) return;
  const o = outro as Partial<OutroSpec> | null;
  if (!o || typeof o.text !== "string" || !o.text.trim()) {
    errors.push("outro.text 缺失或为空");
    return;
  }
  if (o.durationSeconds !== undefined && !isPositiveNumber(o.durationSeconds)) {
    errors.push("outro.durationSeconds 必须是正数");
  }
}

function checkBeats(beats: unknown, errors: string[]): void {
  if (beats === undefined) return;
  if (!Array.isArray(beats) || beats.length === 0) {
    errors.push("beats 必须是非空数组（绝对时间轴骨架，缺失则无法保证画面与口播对齐）");
    return;
  }
  beats.forEach((beat, i) => {
    const b = beat as Partial<TimelineBeat> | null;
    // startMs 允许为 0：时间轴第一句天然从 0 开始，此前用「必须是正数」判定会把
    // 模型最守规矩的输出判成错误，白白多跑一次几十秒的 DSH 才靠重试蒙对。
    const startOk = !!b && typeof b.startMs === "number" && Number.isFinite(b.startMs) && b.startMs >= 0;
    if (!b || !startOk || !isPositiveNumber(b.endMs as number)) {
      errors.push(`beats[${i}] 的 startMs 必须是不小于 0 的数字，endMs 必须是正数`);
      return;
    }
    if ((b.endMs as number) <= (b.startMs as number)) {
      errors.push(`beats[${i}] 的 endMs 必须大于 startMs`);
    }
  });
}

/** 检查一串绝对出点时间：必须严格递增，且整体收在口播总长附近。 */
function checkOutPoints(
  outPoints: number[],
  label: string,
  narrationSeconds: number,
  errors: string[]
): void {
  for (let i = 1; i < outPoints.length; i++) {
    if (outPoints[i] <= outPoints[i - 1]) {
      errors.push(`${label} 的 outSeconds 必须严格递增：第 ${i} 项(${outPoints[i]}) 未大于第 ${i - 1} 项(${outPoints[i - 1]})`);
      return;
    }
  }
  const last = outPoints[outPoints.length - 1];
  if (last > narrationSeconds + TAIL_TOLERANCE_SECONDS) {
    errors.push(
      `${label} 最后一个 outSeconds(${last.toFixed(2)}) 超过口播总长 ${narrationSeconds.toFixed(2)}，` +
        `画面会比口播长出 ${(last - narrationSeconds).toFixed(2)} 秒（尾部无人填充会黑屏）`,
    );
  }
}

/**
 * 校验数据型图层的数据字段。
 *
 * 规划型图层只有单值字段，缺了就显示成空串，肉眼可见；
 * 数据型图层缺的是**数组** —— 渲染层会画出空的坐标轴 / 空表格，
 * 看起来像「图坏了」而不是「数据没给」。所以这里必须逐个查空。
 */
function checkChartData(o: Partial<OverlaySpec>, index: number, errors: string[]): void {
  const at = `overlays[${index}]`;

  const chartPoints = (points: unknown, where: string): boolean => {
    if (!Array.isArray(points) || points.length === 0) {
      errors.push(`${at}.${where} 必须是非空数组`);
      return false;
    }
    points.forEach((p, j) => {
      const point = p as Partial<ChartDataPoint> | null;
      if (!point || typeof point.label !== "string" || !point.label.trim()) {
        errors.push(`${at}.${where}[${j}].label 缺失`);
      }
      if (!point || typeof point.value !== "number" || !Number.isFinite(point.value)) {
        errors.push(`${at}.${where}[${j}].value 必须是数字`);
      }
    });
    return true;
  };

  switch (o.kind) {
    case "bar_chart":
    case "donut":
      chartPoints(o.items, "items");
      break;

    case "line_chart":
      if (!Array.isArray(o.series) || o.series.length === 0) {
        errors.push(`${at}.series 必须是非空数组`);
        break;
      }
      o.series.forEach((s, j) => {
        if (!s || typeof s.name !== "string" || !s.name.trim()) errors.push(`${at}.series[${j}].name 缺失`);
        if (s) chartPoints(s.points, `series[${j}].points`);
      });
      break;

    case "kpi_grid":
      if (!Array.isArray(o.cards) || o.cards.length === 0) {
        errors.push(`${at}.cards 必须是非空数组`);
        break;
      }
      o.cards.forEach((c, j) => {
        if (!c || typeof c.value !== "string" || !c.value.trim()) {
          errors.push(`${at}.cards[${j}].value 缺失`);
        }
      });
      break;

    case "spec_table": {
      const cols = Array.isArray(o.columns) ? o.columns : [];
      if (cols.length === 0) {
        errors.push(`${at}.columns 必须是非空数组（表头）`);
        break;
      }
      if (!Array.isArray(o.rows) || o.rows.length === 0) {
        errors.push(`${at}.rows 必须是非空数组`);
        break;
      }
      o.rows.forEach((row, j) => {
        if (!Array.isArray(row) || row.length !== cols.length) {
          errors.push(`${at}.rows[${j}] 必须恰好有 ${cols.length} 列`);
        }
      });
      break;
    }

    case "bullet_list":
      if (!Array.isArray(o.bullets) || o.bullets.length === 0) {
        errors.push(`${at}.bullets 必须是非空数组`);
      } else if (o.bullets.length > 6) {
        errors.push(`${at}.bullets 最多 6 条，实际 ${o.bullets.length} 条`);
      }
      break;

    default:
      break;
  }

  if (o.highlightIndex !== undefined) {
    const i = o.highlightIndex;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0) {
      errors.push(`${at}.highlightIndex 必须是不小于 0 的整数`);
    }
  }
}

/** 校验常驻页面装饰。 */
function checkChrome(chrome: unknown, errors: string[]): void {
  if (chrome === undefined || chrome === null) return;
  if (typeof chrome !== "object") {
    errors.push("chrome 必须是对象");
    return;
  }
  const c = chrome as Partial<ChromeSpec>;
  for (const key of ["headerText", "headerSubtitle", "footerText", "color"] as const) {
    const v = c[key];
    if (v !== undefined && typeof v !== "string") errors.push(`chrome.${key} 必须是字符串`);
  }
  if (c.color !== undefined && !HEX.test(c.color)) {
    errors.push("chrome.color 必须是 #rgb / #rrggbb / #rrggbbaa 颜色值");
  }
  for (const key of ["topBar", "progress"] as const) {
    if (c[key] !== undefined && typeof c[key] !== "boolean") errors.push(`chrome.${key} 必须是布尔值`);
  }
}

function checkOverlays(
  overlays: unknown,
  sceneOutPoints: number[],
  errors: string[]
): void {
  if (overlays === undefined) return;
  if (!Array.isArray(overlays)) {
    errors.push("overlays 必须是数组");
    return;
  }
  overlays.forEach((overlay, i) => {
    const o = overlay as Partial<OverlaySpec> | null;
    if (!o || typeof o.id !== "string" || !o.id.trim()) {
      errors.push(`overlays[${i}].id 缺失`);
    }
    if (!o || typeof o.kind !== "string" || !OVERLAY_KINDS.includes(o.kind as OverlayKind)) {
      errors.push(`overlays[${i}].kind 必须是：${OVERLAY_KINDS.join(" / ")}`);
    }
    if (o?.position !== undefined && !OVERLAY_POSITIONS.includes(o.position as OverlayPosition)) {
      errors.push(`overlays[${i}].position 必须是：${OVERLAY_POSITIONS.join(" / ")}`);
    }
    if (o?.outSeconds !== undefined && !isPositiveNumber(o.outSeconds)) {
      errors.push(`overlays[${i}].outSeconds 必须是正数`);
    }
    if (
      o?.outSeconds !== undefined &&
      o.inSeconds !== undefined &&
      (o.outSeconds as number) <= (o.inSeconds as number)
    ) {
      errors.push(`overlays[${i}] 的 outSeconds 必须大于 inSeconds`);
    }
    // 文字图层不能活得比承载它的场景更久，否则会盖在下一张图上
    if (o?.outSeconds !== undefined && sceneOutPoints.length) {
      const maxSceneOut = Math.max(...sceneOutPoints);
      if ((o.outSeconds as number) > maxSceneOut + 0.5) {
        errors.push(`overlays[${i}].outSeconds(${o.outSeconds}) 超出场景总长(${maxSceneOut})，文字会压到下一镜头上`);
      }
    }
    // 数据型图层的数组字段逐个查空
    if (o && DATA_OVERLAY_KINDS.includes(o.kind as OverlayKind)) {
      checkChartData(o, i, errors);
    }
  });
}

/** 校验图片分镜。返回全部错误明细，便于把错误回喂给模型重试。 */
export function validateStoryboard(input: unknown): ValidationResult<Storyboard> {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["分镜必须是一个 JSON 对象"] };

  const sb = input as Partial<Storyboard>;
  if (sb.version !== 1) errors.push("version 必须为 1");
  if (typeof sb.theme !== "string" || !sb.theme.trim()) errors.push("theme 必须是非空字符串");
  if (sb.width !== 1080 || sb.height !== 1920) errors.push("width 必须为 1080 且 height 必须为 1920（竖版）");
  if (sb.fps !== 30) errors.push("fps 必须为 30");
  if (!isPositiveNumber(sb.durationSeconds as number)) errors.push("durationSeconds 必须是正数（口播总长）");

  checkBeats(sb.beats, errors);

  const narrationSeconds =
    isPositiveNumber(sb.durationSeconds as number) ? (sb.durationSeconds as number) : Number.POSITIVE_INFINITY;

  if (!Array.isArray(sb.scenes) || sb.scenes.length === 0) {
    errors.push("scenes 必须是非空数组");
  } else {
    const seenIds = new Set<string>();
    sb.scenes.forEach((scene, i) => {
      const s = scene as Partial<SceneSpec> | null;
      if (!s || typeof s.id !== "string" || !s.id.trim()) {
        errors.push(`scenes[${i}].id 缺失`);
      } else if (seenIds.has(s.id)) {
        errors.push(`scenes[${i}].id 重复：${s.id}`);
      } else {
        seenIds.add(s.id);
      }

      if (!Array.isArray(s?.images) || s.images.length === 0) {
        errors.push(`scenes[${i}].images 必须是非空数组`);
      } else if (s.images.length > 4) {
        errors.push(`scenes[${i}].images 最多 4 张，实际 ${s.images.length} 张`);
      } else {
        s.images.forEach((img, j) => {
          if (typeof img !== "string" || !img.trim()) errors.push(`scenes[${i}].images[${j}] 为空`);
        });
      }

      if (!isPositiveNumber(s?.outSeconds as number)) {
        errors.push(`scenes[${i}].outSeconds 必须是正数（绝对出点时间，画面时长由它推导）`);
      }

      if (!s || typeof s.animation !== "string" || !CAMERA_MOTIONS.includes(s.animation as CameraMotion)) {
        errors.push(`scenes[${i}].animation 必须是：${CAMERA_MOTIONS.join(" / ")}`);
      }

      if (s?.particles !== undefined && !PARTICLE_TYPES.includes(s.particles as ParticleType)) {
        errors.push(`scenes[${i}].particles 必须是：${PARTICLE_TYPES.join(" / ")}`);
      }
      if (s?.particleColor !== undefined && !HEX.test(s.particleColor)) {
        errors.push(`scenes[${i}].particleColor 必须是 #rgb / #rrggbb / #rrggbbaa 颜色值`);
      }
      if (s?.particleIntensity !== undefined) {
        const v = s.particleIntensity;
        if (typeof v !== "number" || v < 0 || v > 1) {
          errors.push(`scenes[${i}].particleIntensity 必须在 0~1 之间`);
        }
      }
      if (s?.backgroundOverlay !== undefined) {
        const v = s.backgroundOverlay;
        if (typeof v !== "number" || v < 0 || v > 1) {
          errors.push(`scenes[${i}].backgroundOverlay 必须在 0~1 之间`);
        }
      }
      if (s?.lightingFrom !== undefined && !HEX.test(s.lightingFrom)) {
        errors.push(`scenes[${i}].lightingFrom 必须是 #rrggbb 颜色值`);
      }
      if (s?.lightingTo !== undefined && !HEX.test(s.lightingTo)) {
        errors.push(`scenes[${i}].lightingTo 必须是 #rrggbb 颜色值`);
      }
    });

    const outPoints = sb.scenes.map((s) => (s as Partial<SceneSpec>)?.outSeconds ?? 0);
    if (outPoints.every((v) => v > 0)) {
      checkOutPoints(outPoints, "scenes", narrationSeconds, errors);
    }
    checkOverlays(sb.overlays, outPoints, errors);
  }

  checkCaptions(sb.captions, errors);
  checkOutro(sb.outro, errors);
  validateLook(sb.look, errors);
  checkChrome(sb.chrome, errors);

  return errors.length ? { ok: false, errors } : { ok: true, value: sb as Storyboard };
}

/** 校验片段分镜。 */
export function validateClipStoryboard(input: unknown): ValidationResult<ClipStoryboard> {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["分镜必须是一个 JSON 对象"] };

  const sb = input as Partial<ClipStoryboard>;
  if (sb.version !== 1) errors.push("version 必须为 1");
  if (typeof sb.theme !== "string" || !sb.theme.trim()) errors.push("theme 必须是非空字符串");
  if (sb.width !== 1080 || sb.height !== 1920) errors.push("width 必须为 1080 且 height 必须为 1920（竖版）");
  if (sb.fps !== 30) errors.push("fps 必须为 30");
  if (!isPositiveNumber(sb.durationSeconds as number)) errors.push("durationSeconds 必须是正数（口播总长）");

  checkBeats(sb.beats, errors);

  const narrationSeconds =
    isPositiveNumber(sb.durationSeconds as number) ? (sb.durationSeconds as number) : Number.POSITIVE_INFINITY;

  if (!Array.isArray(sb.clips) || sb.clips.length === 0) {
    errors.push("clips 必须是非空数组");
  } else {
    const seenIds = new Set<string>();
    sb.clips.forEach((clip, i) => {
      const c = clip as Partial<ClipSpec> | null;
      if (!c || typeof c.id !== "string" || !c.id.trim()) errors.push(`clips[${i}].id 缺失`);
      else if (seenIds.has(c.id)) errors.push(`clips[${i}].id 重复：${c.id}`);
      else seenIds.add(c.id);
      if (!c || typeof c.src !== "string" || !c.src.trim()) errors.push(`clips[${i}].src 缺失`);
      if (!isPositiveNumber(c?.outSeconds as number)) {
        errors.push(`clips[${i}].outSeconds 必须是正数（绝对出点时间，成片总长由它推导）`);
      }
      if (c?.trimStartSeconds !== undefined && typeof c.trimStartSeconds !== "number") {
        errors.push(`clips[${i}].trimStartSeconds 必须是数字`);
      }
      if (c?.transition !== undefined && !TRANSITION_KINDS.includes(c.transition as TransitionKind)) {
        errors.push(`clips[${i}].transition 必须是：${TRANSITION_KINDS.join(" / ")}`);
      }
    });

    const outPoints = sb.clips.map((c) => (c as Partial<ClipSpec>)?.outSeconds ?? 0);
    if (outPoints.every((v) => v > 0)) {
      checkOutPoints(outPoints, "clips", narrationSeconds, errors);
    }
    checkOverlays(sb.overlays, outPoints, errors);
  }

  checkCaptions(sb.captions, errors);
  checkOutro(sb.outro, errors);
  validateLook(sb.look, errors);
  checkChrome(sb.chrome, errors);

  return errors.length ? { ok: false, errors } : { ok: true, value: sb as ClipStoryboard };
}