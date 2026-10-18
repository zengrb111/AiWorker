/**
 * 分镜契约层（Node 侧）。
 *
 * 职责：把「创作要求 + 参考图 + 口播时间轴 + 主题」翻译成一段严格的 JSON 指令交给 DSH，
 * 再把模型输出解析、校验、兜底成一份一定可渲染、且一定与口播对齐的分镜。
 *
 * 校验器直接复用 remotion/src/vertical/schema.ts —— 那是渲染层唯一的类型与校验来源，
 * 两边各写一份必然漂移，所以 Node 侧不重复定义。
 *
 * ## 兜底三级（任何一级失败都不能让出片失败）
 *   ① 模型输出能解析且通过校验 → 直接用
 *   ② 解析/校验失败 → 把错误明细回喂模型重试一次
 *   ③ 仍失败 → 用确定性兜底分镜（按口播时间轴均分 + 固定运镜序列 + 片尾）
 *
 * 兜底分镜同样建立在口播时间轴上，所以三条路径产出的成片长度都等于口播长度。
 */

import {
  CAMERA_MOTIONS,
  CAPTION_STYLES,
  PARTICLE_TYPES,
  PLANNED_OVERLAY_KINDS,
  TRANSITION_KINDS,
  VISUAL_EFFECTS,
  VISUAL_EFFECT_LABELS,
  CAPTION_STYLE_LABELS,
  validateClipStoryboard,
  validateStoryboard,
  validateLook,
  type CameraMotion,
  type CaptionStyleKey,
  type ClipSpec,
  type ClipStoryboard,
  type ChromeSpec,
  type LookConfig,
  type OverlaySpec,
  type SceneSpec,
  type Storyboard,
  type TimelineBeat,
  type VisualEffect,
} from "../../../remotion/src/vertical/schema";
import { resolveTheme, THEME_KEYS } from "../../../remotion/src/theme";

export type {
  CameraMotion,
  CaptionStyleKey,
  ClipSpec,
  ClipStoryboard,
  ChromeSpec,
  LookConfig,
  OverlaySpec,
  SceneSpec,
  Storyboard,
  TimelineBeat,
  VisualEffect,
};
export { CAPTION_STYLES, CAPTION_STYLE_LABELS, VISUAL_EFFECTS, VISUAL_EFFECT_LABELS, validateLook };

/** 兜底运镜序列：相邻镜头运动方向交替，避免连续同向造成的机械感。 */
const FALLBACK_MOTIONS = ["ken-burns", "drift-up", "zoom-in", "drift-down", "parallax"] as const;

/** 片尾卡时长（秒）。 */
const OUTRO_SECONDS = 2.5;

/**
 * 句级时间轴：一句话对应一个出点。
 *
 * 这是整条时间轴的骨架 —— 画面切点必须落在某句话的结束处，
 * 这样观众听到的语义单元和看到的镜头切换天然对齐，不会出现「话没说完画面先跳」。
 */
/**
 * 单张素材的语义信息（来自识图）。
 *
 * 规划层早先只拿到裸路径，AI 不知道每张图是什么，只能按顺序轮播 ——
 * 图与旁白语义毫无关系。带上这些信息后，AI 才能「把对的图放在对的句子上」。
 */
export type MaterialInsight = {
  /** 与 imagePaths / materialPaths 中对应下标一致。 */
  path: string;
  /** 一句话内容描述。 */
  caption: string;
  /** 情绪氛围，如 温暖/紧张/宁静。 */
  mood: string;
  /** 主体类别，如 人物/风景/产品。 */
  subject: string;
  /** 主色调 hex。 */
  dominantColor: string;
  /** 是否偏暗。可选：识图失败时该字段缺失，风格推断会退回用 dominantColor 算。 */
  isDark?: boolean;
};

export type StoryboardPlanInput = {
  /** 用户的创作要求（自然语言）。 */
  requirement: string;
  /** 已复制进 remotion/public/generated/<token>/ 的图片路径（相对 public）。 */
  imagePaths: string[];
  /** 旁白句级时间轴（毫秒）。给了就用绝对时间轴，没给则退回按时长均分。 */
  beats?: TimelineBeat[];
  /**
   * 与 imagePaths 逐项对应的语义描述（来自识图）。
   *
   * 给了就要求 AI 按内容匹配句子；不给、长度不匹配或 caption 为空时自动忽略，
   * 退回原来的「按顺序轮播」行为。**绝不让识图缺失影响出片。**
   */
  insights?: MaterialInsight[];
  /** 目标总时长（秒），即口播总长。 */
  durationSeconds: number;
  /** 片尾文案。 */
  outroText?: string;
  /** 期望主题。 */
  theme?: string;
  /**
   * 本次将被系统注入的图表类型提示（中文名，如「柱状图 / 环形图」）。
   *
   * 给了会让 prompt 多一段「图表由系统自动生成，别重复画」的声明。
   * 不给（纯图片转视频链路）则完全不提，行为与改造前一致。
   */
  chartKindHint?: string;
};

/** 剪辑链路：让模型决定片段顺序、裁切点与转场。 */
export type ClipPlanInput = {
  requirement: string;
  /** 已复制进 public 的素材路径（相对 public），视频与图片混排。 */
  materialPaths: string[];
  /** ASR 句级时间轴（毫秒）。 */
  beats?: TimelineBeat[];
  /** 与 materialPaths 逐项对应的语义描述（来自识图），让模型按内容排序而非按给定顺序。 */
  insights?: MaterialInsight[];
  /** 总时长预算（秒），即口播/原声总长。 */
  durationSeconds: number;
  outroText?: string;
  theme?: string;
};

export type StoryboardPlanResult = {
  storyboard: Storyboard | ClipStoryboard;
  /** 兜底分镜为 true 时，UI 应提示「已使用默认节奏」。 */
  fallback: boolean;
  /** 供日志排查：第 ① 级是否成功、耗时、模型原始输出长度。 */
  diagnostics: {
    attempts: number;
    firstAttemptError?: string[];
    usedDsh: boolean;
    elapsedMs: number;
    rawLength: number;
  };
};

/* -------------------------------------------------------------------------- */
/* 时间轴骨架                                                                  */
/* -------------------------------------------------------------------------- */

/** 没有 beats 时，按总时长合成等距的时间轴，保证兜底路径也走绝对时间轴。 */
export function synthesizeBeats(durationSeconds: number, count = 6): TimelineBeat[] {
  const total = Math.max(2, durationSeconds);
  const n = Math.max(1, Math.min(12, count));
  const step = (total * 1000) / n;
  return Array.from({ length: n }, (_, i) => ({
    startMs: Math.round(i * step),
    endMs: Math.round((i + 1) * step),
    text: `第 ${i + 1} 段`,
  }));
}

/**
 * 把任意 beats 规整成严格递增、末点对齐口播总长的骨架。
 *
 * 模型给出的画面出点要挂在这上面，所以这里必须干净：
 * - 过滤掉非正数与倒挂的区间
 * - 合并过短的碎句（< 0.6s 单独成镜会让画面闪）
 * - 末点统一为 durationSeconds，确保成片长度正好等于口播长度
 */
export function normalizeBeats(beats: TimelineBeat[] | undefined, durationSeconds: number): TimelineBeat[] {
  const total = Math.max(1, Math.round(durationSeconds * 1000));

  const clean = (beats ?? [])
    .filter((b) => b && Number.isFinite(b.startMs) && Number.isFinite(b.endMs) && b.endMs > b.startMs && b.startMs >= 0)
    .sort((a, b) => a.startMs - b.startMs);

  if (!clean.length) return synthesizeBeats(durationSeconds);

  // 夹到 [0, total]，并用一次线性扫描保证相邻不重叠、严格递增
  const clamped: TimelineBeat[] = [];
  let cursor = 0;
  for (const b of clean) {
    const startMs = Math.max(cursor, Math.min(b.startMs, total - 1));
    const endMs = Math.max(startMs + 1, Math.min(b.endMs, total));
    cursor = endMs;
    clamped.push({ startMs, endMs, text: b.text });
  }

  // 合并过短碎句
  const merged: TimelineBeat[] = [];
  for (const beat of clamped) {
    const prev = merged[merged.length - 1];
    if (prev && beat.endMs - prev.startMs < 600) {
      prev.endMs = beat.endMs;
      prev.text = `${prev.text}${beat.text}`;
      continue;
    }
    merged.push({ ...beat });
  }

  // 末点对齐口播总长：画面必须覆盖到旁白最后一个字
  const last = merged[merged.length - 1];
  if (last && last.endMs < total) last.endMs = total;
  if (last && last.endMs > total) last.endMs = total;
  return merged.length ? merged : synthesizeBeats(durationSeconds);
}

/* -------------------------------------------------------------------------- */
/* Prompt                                                                     */
/* -------------------------------------------------------------------------- */

/** 从模型输出里剥离 markdown 围栏，取出第一个完整的 JSON 对象。 */
export function extractJsonObject(raw: string): unknown {
  const text = raw.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text);

  const balanced = sliceFirstBalancedObject(text);
  if (balanced) candidates.push(balanced);

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续尝试下一个候选
    }
  }
  return undefined;
}

/** 括号计数截取第一个完整 JSON 对象，跳过字符串字面量内的括号。 */
function sliceFirstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function formatImageList(paths: string[]): string {
  if (paths.length === 0) return "（本次没有可用图片）";
  return paths.map((p, i) => `${i + 1}. ${p}`).join("\n");
}

/**
 * 带语义的图片清单。
 *
 * 有识图结果时，每行后面跟上「内容 / 情绪 / 主体 / 色调」，
 * 并明确要求 AI 按内容匹配句子 —— 这是「图文匹配」的全部依据。
 * 识图缺失（insights 为空、长度不符、或 caption 为空）时退回纯路径列表，
 * 行为与改造前完全一致。
 */
function formatImageListWithInsights(
  paths: string[],
  insights?: MaterialInsight[]
): string {
  if (paths.length === 0) return "（本次没有可用图片）";

  const usable =
    insights && insights.length === paths.length && insights.some((i) => i.caption)
      ? insights
      : null;
  if (!usable) return formatImageList(paths);

  return paths
    .map((p, i) => {
      const ins = usable[i];
      if (!ins?.caption) return `${i + 1}. ${p}`;
      const parts = [`内容：${ins.caption}`];
      if (ins.mood) parts.push(`情绪：${ins.mood}`);
      if (ins.subject) parts.push(`主体：${ins.subject}`);
      if (ins.dominantColor) parts.push(`色调：${ins.dominantColor}`);
      return `${i + 1}. ${p}\n     ${parts.join(" / ")}`;
    })
    .join("\n");
}

/** 识图可用时追加的图文匹配指令。 */
function insightMatchingRules(paths: string[], insights?: MaterialInsight[]): string[] {
  const usable =
    insights && insights.length === paths.length && insights.some((i) => i.caption)
      ? insights
      : null;
  if (!usable) return [];

  return [
    "",
    "## 图文匹配（重要）",
    "上面每张图都标注了内容 / 情绪 / 主体 / 色调。请按下面的原则分配：",
    "1. **内容对口**：旁白说到什么，就配对应的图。说「深夜的街道」时用那张夜景图，",
    "   而不是因为它在列表第 1 位就先用它。图片顺序只是编号，不是播放顺序。",
    "2. **情绪一致**：句子情绪激昂时用同色调的图，温暖的旁白不要配冷峻的画面。",
    "3. **多样性**：同一张图不要在相邻两个场景重复出现；",
    "   如果可用图少于场景数，优先保证内容对口，重复时优先复用色调接近的图。",
    "4. **可以不用完**：对不上的图干脆不放，比硬塞更好。",
  ];
}

/** 把时间轴骨架渲染成模型能读的表格。这是 prompt 里最关键的一段。 */
function formatBeats(beats: TimelineBeat[]): string {
  return beats
    .map((b, i) => `${i + 1}. ${(b.startMs / 1000).toFixed(2)}s → ${(b.endMs / 1000).toFixed(2)}s：${b.text}`)
    .join("\n");
}

/** 时间轴与 overlays 的通用约束。 */
function sharedRules(beats: TimelineBeat[]): string[] {
  const lastOut = (beats[beats.length - 1]?.endMs ?? 0) / 1000;
  return [
    `- scenes/clips 的 outSeconds 必须严格递增，且直接取自上面时间轴里某一句的出点（单位换算成秒，保留 2 位）`,
    `- 最后一个场景/片段的 outSeconds 必须是 ${lastOut.toFixed(2)}（= 口播结束时刻），`,
    `  这样画面才会和口播严丝合缝；不要自己发明比它更晚的时间点，否则尾部会出现无人填充的黑屏`,
    `- 单句时长已经由时间轴定死，不要试图合并或拆分句子来凑时长`,
    `- 画面切换点必须落在某句话的结束处，这样观众听到的语义单元和看到的镜头切换才对得上`,
    `- outro.durationSeconds 固定 ${OUTRO_SECONDS}`,
    `- 只输出一个 JSON 对象，不要输出任何解释、前言、markdown 标题或 \`\`\` 围栏`,
  ];
}

/**
 * 图表职责声明。
 *
 * ## 为什么必须写进 prompt，而不是只在代码里把图表排除掉
 *
 * 服务端会把文章分析产出的图表翻译成 OverlaySpec 注入时间轴（chart-overlays.ts），
 * 而 DSH 看不到那份数据 —— 它只看到「素材里有几张图」和一段旁白。
 * 如果不告诉它，模型看到旁白里的数字会**理所当然地再画一遍**：
 * 一个 stat_card 叠在系统注入的柱状图上，两块玻璃卡正面相撞。
 *
 * 给了 kind 提示还能省一次 DSH 的推理量：它不必猜「这组图要不要自己画」。
 * 没有提示（纯图片转视频链路）时这段返回空数组，行为与改造前完全一致。
 */
function chartOwnershipRules(chartKindHint?: string): string[] {
  if (!chartKindHint) return [];
  return [
    "",
    "## 数据图表由系统自动生成（重要，别重复画）",
    `本次会由程序把文章里已核实的图表数据注入成动态图层（${chartKindHint}）。`,
    "因此：",
    "1. **不要自己输出图表类图层**（柱状图 / 折线图 / 环形图 / 数字卡组 / 规格表 / 要点卡片），",
    "   那些 kind 不在你的取值域里，输出了会被整份分镜判为非法。",
    "2. 旁白念到某个具体数字时，用 `stat_reveal` 或 `stat_card` 压一个**大字**强调它即可，",
    "   不要再造一个带坐标轴的图 —— 那会和系统注入的图表重复。",
    "3. 你要避开的是：系统会把图表放在旁白讲到对应数字的那几句上。",
    "   这几秒里**不要**再压 section_title / callout 之类会与之打架的图层，把画面让给图表。",
  ];
}

/** 图片→视频链路的 prompt。 */
export function buildStoryboardPrompt(input: StoryboardPlanInput): string {
  const theme = resolveTheme(input.theme);
  const beats = normalizeBeats(input.beats, input.durationSeconds);
  const lastOut = (beats[beats.length - 1].endMs / 1000).toFixed(2);

  return [
    "你是一名短视频分镜导演。你要为一支竖版短视频编排分镜，只输出 JSON。",
    "",
    "## 创作要求（用户原话）",
    input.requirement || "（用户未给具体要求，按通用口播短视频处理）",
    "",
    "## 旁白时间轴（不可修改，这是画面切点的唯一依据）",
    formatBeats(beats),
    "",
    "## 可用图片（必须原样使用这些路径，不要编造新路径）",
    formatImageListWithInsights(input.imagePaths, input.insights),
    "",
    "## 输出要求",
    `口播总长 ${input.durationSeconds.toFixed(2)} 秒。宽 1080、高 1920、帧率 30。主题取 "${theme.key}"。`,
    "JSON 结构：",
    "{",
    '  "version": 1,',
    `  "theme": "${theme.key}",`,
    '  "width": 1080, "height": 1920, "fps": 30,',
    `  "durationSeconds": ${input.durationSeconds.toFixed(2)},`,
    `  "beats": [{"startMs": 0, "endMs": ${beats[0].endMs}, "text": "…"}, …],`,
    '  "scenes": [',
    '    { "id": "s1", "images": ["<上面给出的路径>"], "outSeconds": <某一句的出点>,',
    `      "animation": "${CAMERA_MOTIONS[0]}",`,
    `      "particles": "${PARTICLE_TYPES[0]}",`,
    '      "particleIntensity": 0.6, "vignette": true,',
    '      "lightingFrom": "#2a2320", "lightingTo": "#0d0b0a",',
    '      "backgroundOverlay": 0.45 }',
    "  ],",
    '  "overlays": [',
    `    { "id": "o1", "kind": "section_title", "position": "top",`,
    `      "outSeconds": <某一句的出点>, "text": "小标题", "subtitle": "副标题" }`,
    "  ],",
    '  "outro": { "text": "<片尾文案>", "durationSeconds": 2.5 }',
    "}",
    "",
    "字段取值域（超出取值域会被拒绝）：",
    `- animation：${CAMERA_MOTIONS.join(" / ")}`,
    `- particles：${PARTICLE_TYPES.join(" / ")}`,
    `- overlays[].kind：${PLANNED_OVERLAY_KINDS.join(" / ")}`,
    "- particleIntensity / backgroundOverlay：0~1 的小数",
    "- lightingFrom / lightingTo / particleColor / accentColor：#rrggbb 颜色值",
    "- 每个场景的 images 放 1~4 张，按顺序交叉淡化；图片不够就少放",
    "",
    "## 视觉编排要求（直接决定成片的观感，务必遵守）",
    "1. overlays 要覆盖整条时间轴的 60%~80%，不是「可选」：",
    "   - 至少每 2~3 句压一个图层，让画面始终有信息层次，而不是纯图片轮播",
    `   - 总量控制在 ${Math.max(4, Math.min(10, beats.length))} 个左右`,
    "   - section_title 用于开场与段落转折（position 选 top）；",
    "   - stat_reveal / stat_card 用旁白里出现的数字（value 填数字，label 填它代表什么）；",
    "   - progress 用来表达「逐步达成」的叙事；callout 用来强调关键结论或转折句；",
    "   - hero_title 只在开场或全片最核心的一句话上用一次，不要滥用。",
    "2. 运镜必须交替，不能连续两个场景用同一个 animation：",
    "   相邻镜头用不同方向的运动（zoom-in 接 drift-up、ken-burns 接 pan-right…），",
    "   全片至少用到 3 种以上不同的 animation。",
    "3. particles 不要全程开：只在情绪合适的 1~2 个场景用，其余留 none，让画面有呼吸。",
    "4. lightingFrom / lightingTo 每个场景都给一组，同一片子里相邻两组的色温或明度要拉开，",
    "   这是让画面「有光影层次」的关键，比加更多特效有效得多。",
    ...chartOwnershipRules(input.chartKindHint),
    "- 每个图层的 outSeconds 取它所注解那句话的出点；position 取 top / center / bottom",
    "- 不要输出 captions 字段：字幕由配音时间戳在后期统一烧录，由你输出会和它重复叠加",
    `- outro.text 用「${input.outroText || "关注获取更多"}」`,
    "",
    ...sharedRules(beats),
    ...insightMatchingRules(input.imagePaths, input.insights),
  ].join("\n");
}

/** 片段→成片链路的 prompt。 */
export function buildClipPrompt(input: ClipPlanInput): string {
  const theme = resolveTheme(input.theme);
  const beats = normalizeBeats(input.beats, input.durationSeconds);
  const lastOut = (beats[beats.length - 1].endMs / 1000).toFixed(2);

  return [
    "你是一名短视频剪辑师。你要为一支竖版短视频安排片段顺序、裁切点与转场，只输出 JSON。",
    "",
    "## 剪辑要求（用户原话）",
    input.requirement || "（用户未给具体要求，按通用口播剪辑处理）",
    "",
    "## 口播时间轴（不可修改，这是剪辑点的唯一依据）",
    formatBeats(beats),
    "",
    "## 可用素材（必须原样使用这些路径，不要编造新路径）",
    formatImageList(input.materialPaths),
    "",
    "## 输出要求",
    `口播总长 ${input.durationSeconds.toFixed(2)} 秒。宽 1080、高 1920、帧率 30。主题取 "${theme.key}"。`,
    "JSON 结构：",
    "{",
    '  "version": 1,',
    `  "theme": "${theme.key}",`,
    '  "width": 1080, "height": 1920, "fps": 30,',
    `  "durationSeconds": ${input.durationSeconds.toFixed(2)},`,
    `  "beats": [{"startMs": 0, "endMs": ${beats[0].endMs}, "text": "…"}, …],`,
    '  "clips": [',
    '    { "id": "c1", "src": "<上面给出的路径>", "trimStartSeconds": 0,',
    '      "outSeconds": <某一句的出点>, "transition": "fade" }',
    "  ],",
    '  "overlays": [',
    '    { "id": "o1", "kind": "stat_reveal", "outSeconds": <某一句的出点>,',
    '      "value": "92%", "label": "完播率" }',
    "  ],",
    '  "outro": { "text": "<片尾文案>", "durationSeconds": 2.5 }',
    "}",
    "",
    "字段取值域（超出取值域会被拒绝）：",
    `- transition：${TRANSITION_KINDS.join(" / ")}`,
    `- overlays[].kind：${PLANNED_OVERLAY_KINDS.join(" / ")}`,
    "- 视频片段可以用 trimStartSeconds 从中间开始取，图片忽略该字段",
    "- 素材不必全部用完，但至少用 2 个片段",
    "",
    "## 剪辑编排要求（直接决定成片的观感，务必遵守）",
    "1. transition 要交替使用，不要整片都是同一个：",
    "   fade / slide / wipe 搭配着来，切在语义转折处（而非每句都换花样）。",
    "2. overlays 要覆盖整条时间轴的 60%~80%，不是「可选」：",
    "   - 至少每 2~3 句压一个图层，避免纯画面堆素材",
    `   - 总量控制在 ${Math.max(3, Math.min(8, beats.length))} 个左右`,
    "   - stat_reveal / stat_card 填旁白里出现的关键数字；",
    "   - section_title 标段落；callout 强调结论句。",
    "3. 切点要对准语义：一个 clip 结束就落在某句话说完的位置，",
    "   这样观众听到的语义单元和画面切换才对得上。",
    `- outro.text 用「${input.outroText || "关注获取更多"}」`,
    "",
    ...sharedRules(beats),
  ].join("\n");
}

/** 校验失败时回喂给模型的补充说明。 */
export function buildRetryPrompt(errors: string[]): string {
  return [
    "你上一次输出的 JSON 没通过校验，错误如下：",
    ...errors.map((e) => `- ${e}`),
    "",
    "请只重新输出修正后的那一个 JSON 对象，不要解释、不要道歉、不要复述错误。",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* 兜底分镜                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 兜底 overlays。
 *
 * 早先只在开头压一个 section_title，成片退化成「纯图片轮播 + 一个标题」——
 * 正是用户反馈「动画效果不多」的样子。兜底也必须保证画面有信息层次，
 * 所以这里按时间轴铺满：开场标题 + 段落标题 + 结论强调 + 可选的进度条。
 */
function buildFallbackOverlays(input: {
  beats: TimelineBeat[];
  durationSeconds: number;
  /** 画面段落的出点序列（场景或片段）。overlay 出点不得超过它的最后一项。 */
  sceneOutPoints: number[];
}): OverlaySpec[] {
  const { beats, durationSeconds, sceneOutPoints } = input;
  if (!beats.length) return [];

  const total = beats[beats.length - 1].endMs / 1000;
  const at = (i: number) => beats[Math.min(i, beats.length - 1)].endMs / 1000;
  const overlays: OverlaySpec[] = [];

  // 开场大标题：压在前 3.5 秒
  overlays.push({
    id: "o-hero",
    kind: "hero_title",
    position: "center",
    inSeconds: 0.2,
    outSeconds: Math.min(3.5, total * 0.4),
    text: beats[0].text.slice(0, 16),
    subtitle: "",
  });

  // 段落小标题：每隔 2 句来一个，放在片段顶部
  for (let i = 1; i < beats.length; i += 2) {
    const start = at(i - 1);
    const end = Math.min(at(i), total);
    if (end - start < 1.2) continue;
    overlays.push({
      id: `o-title-${i}`,
      kind: "section_title",
      position: "top",
      inSeconds: start + 0.2,
      outSeconds: end,
      text: beats[i - 1].text.slice(0, 12),
    });
  }

  // 倒数第二句压一个结论强调，让收尾有变化。
  // 出点必须落在最后一个场景的出点上，不能超过它 —— schema 的规则是
  // overlay.outSeconds > maxSceneOut + 0.5 即判非法（文字会压到下一镜头上）。
  // 这里取末场景出点，既满足校验，也让结论与最后一段画面同时收住。
  const lastSceneOut = sceneOutPoints.length
    ? sceneOutPoints[sceneOutPoints.length - 1]
    : total;
  if (beats.length >= 3 && total - lastSceneOut > 1.2) {
    const start = at(beats.length - 2);
    if (lastSceneOut - start > 1.2) {
      overlays.push({
        id: "o-callout",
        kind: "callout",
        tone: "tip",
        position: "center",
        inSeconds: start + 0.2,
        outSeconds: lastSceneOut,
        text: beats[beats.length - 2].text.slice(0, 22),
      });
    }
  }

  // 时长充裕时补一条进度条，增加「逐步推进」的过程感
  if (durationSeconds >= 15) {
    overlays.push({
      id: "o-progress",
      kind: "progress",
      position: "bottom",
      inSeconds: 0.5,
      outSeconds: Math.max(3, total * 0.5),
      text: "内容进度",
      progress: 100,
    });
  }

  return overlays;
}

/**
 * 确定性兜底分镜：按口播时间轴均分画面 + 固定运镜序列 + 片尾。
 *
 * 不依赖任何模型输出，参数合法性与时长一致性由构造保证，因此一定通过校验。
 * 关键：出点直接取自归一化后的 beats 末点，成片长度 = 口播长度，不可能掐断。
 */
export function buildFallbackStoryboard(input: StoryboardPlanInput): Storyboard {
  const total = Math.max(2, input.durationSeconds);
  const theme = resolveTheme(input.theme);
  const beats = normalizeBeats(input.beats, total);
  const paths = input.imagePaths.length ? input.imagePaths : [""];

  // 画面数：每场 2~4 秒，且不超过可用图片数（图片多时才细分）
  const usableSeconds = Math.max(0.5, total - OUTRO_SECONDS);
  const maxScenes = Math.max(1, Math.min(paths.length, Math.floor(usableSeconds / 2)));
  const sceneCount = Math.max(1, Math.min(maxScenes, Math.ceil(usableSeconds / 3.5)));

  // 在 beats 里挑 sceneCount 个出点，尽量均匀分布
  const pickedOutPoints = pickEvenOutPoints(beats, sceneCount, total - OUTRO_SECONDS);

  const scenes: SceneSpec[] = pickedOutPoints.map((outSeconds, i) => {
    const take = Math.min(3, Math.max(1, Math.ceil(paths.length / pickedOutPoints.length)));
    const images = Array.from({ length: take }, (_, k) => paths[(i * take + k) % paths.length] ?? "").filter(Boolean);
    return {
      id: `s${i + 1}`,
      images: images.length ? images : [paths[0]].filter(Boolean),
      outSeconds,
      animation: FALLBACK_MOTIONS[i % FALLBACK_MOTIONS.length],
      // 粒子隔一个场景开一次：全程开着会抢戏，全不开又太素
      particles: i % 2 === 0 ? ("fireflies" as const) : ("none" as const),
      particleIntensity: 0.55,
      vignette: true,
      backgroundOverlay: 0.45,
      // 光影层次：相邻场景一冷一暖交替，这是「有设计感」最省力也最见效的一招
      lightingFrom: i % 2 === 0 ? "#3b2f2a" : "#243040",
      lightingTo: i % 2 === 0 ? "#0f0d0b" : "#080a10",
    };
  });

  return {
    version: 1,
    theme: theme.key,
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: Math.round(total * 100) / 100,
    beats,
    scenes,
    overlays: buildFallbackOverlays({ beats, durationSeconds: total, sceneOutPoints: pickedOutPoints }),
    outro: {
      text: input.outroText || "关注获取更多",
      durationSeconds: OUTRO_SECONDS,
    },
  };
}

/** 在 beats 里均匀挑 count 个出点，并保证最后一个严格递增。 */
function pickEvenOutPoints(beats: TimelineBeat[], count: number, maxSeconds: number): number[] {
  const usable = Math.max(0.5, maxSeconds);
  const picked: number[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const ideal = (usable * (i + 1)) / count;
    // 找到最接近 ideal 的、且大于 cursor 的 beat 出点
    let candidate = cursor + 0.5;
    for (const b of beats) {
      const endSec = b.endMs / 1000;
      if (endSec > cursor + 0.05 && endSec <= usable) {
        candidate = endSec;
        if (endSec >= ideal - 0.4) break;
      }
    }
    candidate = Math.min(Math.max(candidate, cursor + 0.3), usable);
    picked.push(Math.round(candidate * 100) / 100);
    cursor = candidate;
  }
  // 兜底：若因 beats 过少导致出点重复，拉开最后一段
  for (let i = 1; i < picked.length; i++) {
    if (picked[i] <= picked[i - 1]) picked[i] = Math.round((picked[i - 1] + 0.3) * 100) / 100;
  }
  return picked;
}

/**
 * 确定性兜底片段分镜。
 *
 * 一键剪视频常常只给一个成片源文件，所以片段数不能被素材个数卡住：
 * 素材只有 1 个时也要切出多段（复用同一 src，靠递增的 trimStartSeconds 走位），
 * 否则「剪辑」退化成了「整段搬运」。
 */
export function buildFallbackClipStoryboard(input: ClipPlanInput): ClipStoryboard {
  const total = Math.max(2, input.durationSeconds);
  const theme = resolveTheme(input.theme);
  const beats = normalizeBeats(input.beats, total);
  const paths = input.materialPaths.length ? input.materialPaths : [""];
  const usable = Math.max(0.5, total - OUTRO_SECONDS);

  const count = Math.max(3, Math.min(paths.length >= 2 ? paths.length : 6, Math.ceil(usable / 3)));
  const pickedOutPoints = pickEvenOutPoints(beats, count, usable);

  const clips: ClipSpec[] = pickedOutPoints.map((outSeconds, i) => {
    const isVideo = !/\.(jpe?g|png|webp|gif|bmp)$/i.test(paths[i % paths.length] ?? "");
    const prevOut = i > 0 ? pickedOutPoints[i - 1] : 0;
    return {
      id: `c${i + 1}`,
      src: paths[i % paths.length] ?? "",
      // 图片没有可裁切的时间轴，只给视频素材设置裁切起点
      trimStartSeconds: isVideo ? Math.round(prevOut * 100) / 100 : 0,
      outSeconds,
      transition: i === 0 ? "none" : "fade",
    };
  });

  return {
    version: 1,
    theme: theme.key,
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: Math.round(total * 100) / 100,
    beats,
    clips,
    overlays: buildFallbackOverlays({ beats, durationSeconds: total, sceneOutPoints: pickedOutPoints }),
    outro: { text: input.outroText || "关注获取更多", durationSeconds: OUTRO_SECONDS },
  };
}

/* -------------------------------------------------------------------------- */
/* 解析与校验                                                                  */
/* -------------------------------------------------------------------------- */

/** 解析并校验图片分镜；返回错误明细以便回喂重试。 */
export function parseStoryboard(raw: string): { ok: true; value: Storyboard } | { ok: false; errors: string[] } {
  const parsed = extractJsonObject(raw);
  if (parsed === undefined) {
    return { ok: false, errors: ["输出中找不到可解析的 JSON 对象"] };
  }
  return validateStoryboard(parsed);
}

/** 解析并校验片段分镜。 */
export function parseClipStoryboard(
  raw: string,
): { ok: true; value: ClipStoryboard } | { ok: false; errors: string[] } {
  const parsed = extractJsonObject(raw);
  if (parsed === undefined) {
    return { ok: false, errors: ["输出中找不到可解析的 JSON 对象"] };
  }
  return validateClipStoryboard(parsed);
}

/* -------------------------------------------------------------------------- */
/* 编排：三级兜底                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 跑一次 DSH（由调用方注入，避免本模块依赖 spawn 实现），拿回原始文本。
 * 返回 null 表示「DSH 不可用」，此时直接跳到兜底。
 */
export type RawRunner = (prompt: string, attempt: number) => Promise<string | null>;

/** 解析并校验图片分镜；返回错误明细以便回喂重试。 */
export async function planStoryboard(
  input: StoryboardPlanInput,
  run: RawRunner,
): Promise<StoryboardPlanResult> {
  const started = Date.now();
  const fallbackBoard = buildFallbackStoryboard(input);
  let rawLength = 0;
  let usedDsh = false;
  let firstAttemptError: string[] | undefined;

  const basePrompt = buildStoryboardPrompt(input);
  let prompt = basePrompt;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string | null;
    try {
      raw = await run(prompt, attempt);
    } catch (err) {
      raw = null;
      if (attempt === 1) firstAttemptError = [`DSH 调用失败：${(err as Error).message}`];
      break;
    }
    if (raw === null) break;

    usedDsh = true;
    rawLength = raw.length;
    const result = parseStoryboard(raw);
    if (result.ok) {
      return {
        storyboard: result.value,
        fallback: false,
        diagnostics: {
          attempts: attempt,
          firstAttemptError,
          usedDsh,
          elapsedMs: Date.now() - started,
          rawLength,
        },
      };
    }
    if (attempt === 1) firstAttemptError = result.errors;
    prompt = `${basePrompt}\n\n${buildRetryPrompt(result.errors)}`;
  }

  return {
    storyboard: fallbackBoard,
    fallback: true,
    diagnostics: {
      attempts: usedDsh ? 2 : 0,
      firstAttemptError,
      usedDsh,
      elapsedMs: Date.now() - started,
      rawLength,
    },
  };
}

/** 规划片段分镜，兜底策略同上。永不抛错。 */
export async function planClipStoryboard(
  input: ClipPlanInput,
  run: RawRunner,
): Promise<StoryboardPlanResult> {
  const started = Date.now();
  const fallbackBoard = buildFallbackClipStoryboard(input);
  let rawLength = 0;
  let usedDsh = false;
  let firstAttemptError: string[] | undefined;

  const basePrompt = buildClipPrompt(input);
  let prompt = basePrompt;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string | null;
    try {
      raw = await run(prompt, attempt);
    } catch (err) {
      raw = null;
      if (attempt === 1) firstAttemptError = [`DSH 调用失败：${(err as Error).message}`];
      break;
    }
    if (raw === null) break;

    usedDsh = true;
    rawLength = raw.length;
    const result = parseClipStoryboard(raw);
    if (result.ok) {
      return {
        storyboard: result.value,
        fallback: false,
        diagnostics: {
          attempts: attempt,
          firstAttemptError,
          usedDsh,
          elapsedMs: Date.now() - started,
          rawLength,
        },
      };
    }
    if (attempt === 1) firstAttemptError = result.errors;
    prompt = `${basePrompt}\n\n${buildRetryPrompt(result.errors)}`;
  }

  return {
    storyboard: fallbackBoard,
    fallback: true,
    diagnostics: {
      attempts: usedDsh ? 2 : 0,
      firstAttemptError,
      usedDsh,
      elapsedMs: Date.now() - started,
      rawLength,
    },
  };
}

export { THEME_KEYS };

/* ============================================================================
 * 方案摘要：把 Storyboard 压成「用户看得懂、可以据此判断要不要改」的形态
 * ==========================================================================*/

/** 单个镜头的用户可读摘要。 */
export type PlanSceneSummary = {
  /** 场景 id，用于与分镜 JSON 对齐。 */
  id: string;
  /** 起始秒（绝对，由上一个 outSeconds 推出）。 */
  startSeconds: number;
  /** 出点秒（绝对）。 */
  outSeconds: number;
  durationSeconds: number;
  /** 用了哪几张素材（下标对应用户上传顺序，从 1 开始便于口述）。 */
  imageIndexes: number[];
  imageCount: number;
  /** 实际生效的运镜（已含 Look 覆盖）。 */
  motion: string;
  particles: string;
  /** 该镜头区间内会压的文字图层（供用户判断信息密度）。 */
  overlays: { kind: string; text: string; position: string }[];
  /** 素材语义描述（来自识图），让用户看懂 AI 为什么选这张图。 */
  imageNotes: string[];
};

/** 一份视频方案的完整可读摘要 —— 前端「AI 方案」面板直接渲染它。 */
export type PlanSummary = {
  theme: string;
  themeLabel: string;
  /** 口播总长（秒），等于成片长度基准。 */
  durationSeconds: number;
  /** 时间轴锚点数 = 旁白句数。 */
  beatCount: number;
  scenes: PlanSceneSummary[];
  /** 实际生效的特效层（主题自带 + 用户外挂，已去重）。 */
  effects: string[];
  /** 字幕样式键。 */
  captionStyle: string;
  /** 片尾文案。 */
  outroText: string;
  /** 是否走了确定性兜底分镜（true = 这份方案不是 AI 排的）。 */
  fallback: boolean;
};

/** 运动/特效/粒子的中文名，供摘要直接展示，避免前端再维护一份映射表。 */
const MOTION_LABELS: Record<string, string> = {
  "zoom-in": "推近",
  "zoom-out": "拉远",
  "pan-left": "左移",
  "pan-right": "右移",
  "ken-burns": "缓慢推进",
  "drift-up": "上移",
  "drift-down": "下移",
  parallax: "视差",
  static: "静止",
};

const PARTICLE_LABELS: Record<string, string> = {
  fireflies: "萤火",
  petals: "花瓣",
  sparkles: "星光",
  mist: "薄雾",
  "light-rays": "光柱",
  none: "无",
};

/**
 * 把 LookConfig 写进分镜。
 *
 * **就地返回同一个对象的浅拷贝**：不动 DSH 产出的 storyboard 本体，
 * 这样「AI 原始方案」与「用户调整后的方案」在内存里始终可区分，
 * 便于将来做「撤销用户修改」。
 *
 * effects 用**并集**而不是覆盖：主题自带的层是它的身份，
 * 用户加挂不应该把主题特色抹掉。
 */
export function applyLook(board: Storyboard | ClipStoryboard, look: LookConfig | undefined): Storyboard | ClipStoryboard {
  if (!look) return board;
  const next = { ...board } as Storyboard & ClipStoryboard;
  const theme = resolveTheme(board.theme);

  const merged: VisualEffect[] = [];
  for (const e of [...(theme.effects ?? []), ...(look.effects ?? [])]) {
    if (!merged.includes(e)) merged.push(e);
  }

  const applied: LookConfig = { ...look, effects: merged };
  // motion 覆盖要落到每个场景/片段上，否则渲染层还得再判断一遍，
  // 而渲染层已经通过 props 拿到了 scene.motion，覆写最省事也最不易漏。
  if (look.motion && "scenes" in next && Array.isArray(next.scenes)) {
    next.scenes = next.scenes.map((s) => ({ ...s, animation: look.motion as SceneSpec["animation"] }));
  }
  next.look = applied;
  return next;
}

/**
 * 生成用户可读的方案摘要。
 *
 * 为什么不做「方案预览视频」：渲染一条 30 秒成片要 2~5 分钟（见 render.ts 注释），
 * 让用户为了看一眼方案等 5 分钟不现实。所以摘要只给**结构化文本**：
 * 镜头数、每镜用哪张图、多长、什么运镜、压了什么文字 —— 这些足以判断方案对不对，
 * 不对就改，改完再花 2~5 分钟出片。
 */
export function toPlanSummary(
  plan: StoryboardPlanResult,
  opts: { imagePaths: string[]; insights?: MaterialInsight[]; captionStyle?: CaptionStyleKey } = { imagePaths: [] },
): PlanSummary {
  const board = plan.storyboard;
  const theme = resolveTheme(board.theme);
  const isImageBoard = "scenes" in board && Array.isArray((board as Storyboard).scenes);
  const notesByPath = new Map<string, string>();
  for (const it of opts.insights ?? []) {
    if (it.caption) notesByPath.set(it.path, [it.caption, it.mood].filter(Boolean).join("·"));
  }

  let cursor = 0;
  const scenes: PlanSceneSummary[] = isImageBoard
    ? (board as Storyboard).scenes.map((s: SceneSpec, i: number) => {
        const start = cursor;
        cursor = Number.isFinite(s.outSeconds) ? s.outSeconds : cursor;
        const overlays = (board as Storyboard).overlays ?? [];
        // 文字图层按「落在本镜头区间内」归属；没写 inSeconds 的按 layout 的就近归属处理。
        const mine = overlays.filter((o) => {
          const at = o.inSeconds ?? o.outSeconds;
          return at !== undefined && at >= start - 0.01 && at <= s.outSeconds + 0.01;
        });
        return {
          id: s.id,
          startSeconds: round2(start),
          outSeconds: round2(s.outSeconds),
          durationSeconds: round2(Math.max(0, s.outSeconds - start)),
          imageIndexes: s.images
            .map((p) => opts.imagePaths.findIndex((q) => q === p) + 1)
            .filter((n) => n > 0),
          imageCount: s.images.length,
          motion: MOTION_LABELS[s.animation] ?? s.animation,
          particles: PARTICLE_LABELS[s.particles ?? "none"] ?? s.particles ?? "无",
          overlays: mine.map((o) => ({
            kind: o.kind,
            // DSH 偶而会把 value 填成数字（如 {"value":20}），此时 o.text 为 undefined、
            // ?? 链一路落到 20，再 .trim() 就抛 "…is not a function" 让整条规划崩掉。
            // 这里逐个转成字符串，非字符串值统一按空处理。
            text: String(o.text ?? o.value ?? o.label ?? o.subtitle ?? "")
              .trim()
              .slice(0, 40),
            position: o.position ?? "bottom",
          })),
          imageNotes: s.images.map((p) => notesByPath.get(p) ?? "").filter(Boolean),
        };
      })
    : (board as ClipStoryboard).clips.map((c: ClipSpec, i: number) => {
        const start = cursor;
        cursor = Number.isFinite(c.outSeconds) ? c.outSeconds : cursor;
        return {
          id: c.id,
          startSeconds: round2(start),
          outSeconds: round2(c.outSeconds),
          durationSeconds: round2(Math.max(0, c.outSeconds - start)),
          imageIndexes: [],
          imageCount: 0,
          motion: i === 0 ? "—（视频片段）" : "—（视频片段）",
          particles: "无",
          overlays: [],
          imageNotes: [],
        };
      });

  const mergedEffects: VisualEffect[] = [];
  for (const e of [...(theme.effects ?? []), ...(board.look?.effects ?? [])]) {
    if (!mergedEffects.includes(e)) mergedEffects.push(e);
  }

  return {
    theme: board.theme,
    themeLabel: theme.label,
    durationSeconds: round2(board.durationSeconds),
    beatCount: board.beats?.length ?? 0,
    scenes,
    effects: mergedEffects.map((e) => VISUAL_EFFECT_LABELS[e] ?? e),
    captionStyle: board.look?.captionStyle ?? opts.captionStyle ?? "classic",
    outroText: board.outro?.text ?? "",
    fallback: plan.fallback,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
