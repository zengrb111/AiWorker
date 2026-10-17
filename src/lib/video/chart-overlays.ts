/**
 * 文章图表 → 视频图层的翻译器。
 *
 * ## 为什么不把这些 kind 交给 DSH
 *
 * 文章分析阶段已经把图表数据过了一遍**溯源闸门**（每个数字都要能在原文里逐字核对，
 * 见 analyze.ts 的 verifyChartSpecs）。如果再让分镜模型「照着素材和旁白画一张图」，
 * 等于让它把已经核实过的数字再抄一遍 —— 抄错没人发现，抄对了也是白花一次几十秒的推理。
 * 所以：**数值一律由本模块从 article.charts 直译，图层的时间轴由旁白骨架决定，
 * 模型只负责它擅长的那部分（选图、排运镜、压文字）。**
 *
 * ## 三件必须由代码决定、不能由模型决定的事
 *
 * 1. 落在哪一句：图表挂在旁白讲到对应内容的那一句上（按关键词重合度打分）。
 *    让模型自己找落点，它看不到 article.charts 的标题，只能瞎猜。
 * 2. 排他：图表出现的那几秒必须把 DSH 原本压在那里的文字图层撤掉，
 *    否则两块半屏高的玻璃卡正面相撞 —— 这是「系统注入」必须付出的代价，也是它可控的原因。
 * 3. 出点上限：图层的 outSeconds 不能超过最后一个场景的出点（schema 校验的红线），
 *    所以这里必须 clamp 到场景总长。
 */

import {
  DATA_OVERLAY_KIND_LABELS,
  type ChromeSpec,
  type ChartDataPoint,
  type ChartSeries,
  type KpiCard,
  type OverlayKind,
  type OverlaySpec,
  type TimelineBeat,
} from "../../../remotion/src/vertical/schema";

/**
 * 可注入图表的最小形状。
 *
 * 刻意**不 import src/lib/article 的类型**：管线（src/lib/video）不该知道
 * 「文章分析」这个上游模块的存在，文章侧负责把自己的结果投影成这个形状。
 */
export type InjectableChart = {
  id: string;
  /** ArticleChartKind：bar / line / pie / kpi / timeline / info。 */
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  /** 溯源不过、已降级为不含数值的图卡。降级图不进图表图层。 */
  downgraded?: boolean;
};

export type ChartInjectionResult = {
  /** 新增的图表图层（已排好时间轴）。 */
  overlays: OverlaySpec[];
  /** 写进 prompt 的图表类型提示；没有任何图可注入时为空串。 */
  kindHint: string;
  /** 注入图层占用的时间区间，供调用方排除 DSH 的重叠图层。 */
  spans: Array<{ startSeconds: number; endSeconds: number }>;
};

/** 图表最多占用的句子数下限之外的「最短停留」：太短观众来不及读。 */
const MIN_CHART_SECONDS = 2.2;
/** 相邻两张图表之间至少隔几句，避免连着两块图表让人喘不过气。 */
const CHART_GAP_BEATS = 2;
/** 图表图层最多占画面总时长的比例。剩下的留给运镜、小标题与呼吸。 */
const CHART_TIMELINE_SHARE = 0.7;

/**
 * 文章图表类型 → 渲染图层类型。
 *
 * 这里是唯一的映射表，`chartToOverlay` 与 prompt 提示都从它推导，
 * 避免「提示里说柱状图、实际注入的是别的图」这种不一致。
 */
const ARTICLE_CHART_KIND_TO_OVERLAY: Record<string, OverlayKind> = {
  bar: "bar_chart",
  line: "line_chart",
  pie: "donut",
  kpi: "kpi_grid",
  timeline: "spec_table",
  info: "bullet_list",
};

/**
 * 这次会注入哪几类图表（中文名，供 prompt 用）。
 *
 * 必须**在调 DSH 之前**算出来 —— 提示要写进 prompt，
 * 而注入本身要等 DSH 返回、拿到 beats 与场景出点之后才能做。
 * 空串表示没有图表可注入，prompt 里不会多出那一段。
 */
export function summarizeChartKinds(charts: InjectableChart[] | undefined): string {
  const kinds = new Set<OverlayKind>();
  for (const chart of charts ?? []) {
    if (!chart || chart.downgraded) continue;
    const kind = ARTICLE_CHART_KIND_TO_OVERLAY[chart.kind];
    if (kind) kinds.add(kind);
  }
  return labelKinds(kinds);
}

/** 图层类型集合 → 「柱状图 / 环形图」这样的中文提示。 */
function labelKinds(kinds: Iterable<OverlayKind>): string {
  const set = new Set(kinds);
  if (!set.size) return "";
  return [...set].map((k) => DATA_OVERLAY_KIND_LABELS[k] ?? k).join(" / ");
}

function summarizeOverlayKinds(overlays: OverlaySpec[]): string {
  return labelKinds(overlays.map((o) => o.kind));
}

/* -------------------------------------------------------------------------- */
/* 单张图表 → OverlaySpec                                                          */
/* -------------------------------------------------------------------------- */

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 读取 items: [{label, value}]，丢掉标签空或数值非有限的脏条目。 */
function readItems(payload: Record<string, unknown>): ChartDataPoint[] {
  const raw = Array.isArray(payload.items) ? payload.items : [];
  const out: ChartDataPoint[] = [];
  for (const entry of raw) {
    const item = entry as { label?: unknown; value?: unknown } | null;
    if (!item) continue;
    const label = str(item.label, 12);
    const value = num(item.value);
    if (!label || value === null) continue;
    out.push({ label, value });
  }
  return out.slice(0, 8);
}

/** 读取 series: [{name, points}]；某个系列点数不足 2 的直接丢弃（折线至少两点才有意义）。 */
function readSeries(payload: Record<string, unknown>): ChartSeries[] {
  const raw = Array.isArray(payload.series) ? payload.series : [];
  const out: ChartSeries[] = [];
  for (const entry of raw) {
    const s = entry as { name?: unknown; points?: unknown } | null;
    if (!s) continue;
    const name = str(s.name, 16);
    if (!name || !Array.isArray(s.points)) continue;
    const points: ChartDataPoint[] = [];
    for (const p of s.points) {
      const point = p as { label?: unknown; value?: unknown } | null;
      if (!point) continue;
      const label = str(point.label, 10);
      const value = num(point.value);
      if (!label || value === null) continue;
      points.push({ label, value });
    }
    if (points.length >= 2) out.push({ name, points: points.slice(0, 8) });
  }
  return out.slice(0, 3);
}

/** 读取 steps: [{label, title, detail}]，转成两列规格表（阶段 / 内容）。 */
function readSteps(payload: Record<string, unknown>): string[][] {
  const raw = Array.isArray(payload.steps) ? payload.steps : [];
  const out: string[][] = [];
  for (const entry of raw) {
    const step = entry as { label?: unknown; title?: unknown; detail?: unknown } | null;
    if (!step) continue;
    const label = str(step.label, 10);
    const title = str(step.title, 16);
    if (!label && !title) continue;
    // detail 可能比 title 长很多，表格里截到 22 字保证两列宽度均衡
    const detail = str(step.detail, 22);
    out.push([label || "—", detail ? `${title}｜${detail}` : title]);
  }
  return out.slice(0, 6);
}

/** 读 bullets: string[]，空串过滤。 */
function readBullets(payload: Record<string, unknown>): string[] {
  const raw = Array.isArray(payload.bullets) ? payload.bullets : [];
  return raw.map((b) => str(b, 40)).filter(Boolean).slice(0, 6);
}

/** kpi 的 payload 是单条指标；这里包成一张卡，好让单位用小字异色渲染。 */
function readCards(payload: Record<string, unknown>): KpiCard[] {
  const value = str(payload.value, 18);
  if (!value) return [];
  return [
    {
      value,
      unit: str(payload.unit, 6) || undefined,
      label: str(payload.label, 20) || undefined,
      delta: str(payload.delta, 10) || undefined,
      deltaLabel: str(payload.deltaLabel, 12) || undefined,
    },
  ];
}

/** 高亮项默认取数值最大的一条：它通常就是旁白里最该被强调的那个数字。 */
function peakIndex(values: number[]): number | undefined {
  if (values.length < 2) return undefined;
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i]) > Math.abs(values[best])) best = i;
  }
  return best;
}

/** 单张图表 → OverlaySpec。数据不足以画出任何东西时返回 null（不硬凑）。 */
export function chartToOverlay(chart: InjectableChart, idPrefix: string): OverlaySpec | null {
  const payload = chart.payload ?? {};
  const title = str(chart.title, 24);
  const unit = str(payload.unit, 8) || undefined;
  const note = str(payload.note, 40) || undefined;
  const base = {
    id: `${idPrefix}-${chart.id}`,
    text: title,
    unit,
    note,
    position: "center" as const,
  };

  switch (chart.kind) {
    case "bar": {
      const items = readItems(payload);
      if (!items.length) return null;
      return {
        ...base,
        kind: "bar_chart",
        items,
        highlightIndex: peakIndex(items.map((i) => i.value)),
      };
    }

    case "line": {
      const series = readSeries(payload);
      if (!series.length) return null;
      return { ...base, kind: "line_chart", series };
    }

    case "pie": {
      const items = readItems(payload).filter((i) => i.value > 0);
      if (!items.length) return null;
      return {
        ...base,
        kind: "donut",
        items,
        highlightIndex: peakIndex(items.map((i) => i.value)),
      };
    }

    case "kpi": {
      const cards = readCards(payload);
      if (!cards.length) return null;
      return { ...base, kind: "kpi_grid", cards, subtitle: note };
    }

    case "timeline": {
      const rows = readSteps(payload);
      if (!rows.length) return null;
      // 时间线转成两列规格表：这是「事件演进」最省力也最可扫读的排法。
      return {
        ...base,
        kind: "spec_table",
        columns: ["阶段", "内容"],
        rows,
        note,
      };
    }

    case "info": {
      const bullets = readBullets(payload);
      if (!bullets.length) return null;
      return {
        ...base,
        kind: "bullet_list",
        bullets,
        subtitle: str(payload.headline, 20) || undefined,
        note: note ?? (str(payload.footer, 30) || undefined),
      };
    }

    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 落到时间轴上                                                                    */
/* -------------------------------------------------------------------------- */

/** 取字符串里成对出现的 2 字词与单字，用于粗粒度关键词打分。 */
function keywords(text: string): Set<string> {
  const clean = text.replace(/[\s，。、；：？！,.;:?!（）()「」“”"'\-—…·]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < clean.length; i++) out.add(clean[i]);
  for (let i = 0; i + 2 <= clean.length; i++) out.add(clean.slice(i, i + 2));
  return out;
}

/**
 * 给图表挑落点：按「图表标题/数据项」与每句旁白的关键词重合度打分。
 *
 * 跳过第 0 句是刻意的：开场那一句是 hero_title 的位置，
 * 图表压在开场会把片头标题顶掉。
 */
function assignBeats(
  charts: InjectableChart[],
  beats: TimelineBeat[]
): Array<{ chart: InjectableChart; beatIndex: number }> {
  if (!beats.length) return [];
  const first = beats[0];
  const last = beats[beats.length - 1];
  const candidates = beats
    .map((beat, i) => ({ beat, i }))
    // 太短的句子放不下图表（MIN_CHART_SECONDS），也不放开场那一句
    .filter(({ beat, i }) => i > 0 && (beat.endMs - beat.startMs) / 1000 >= MIN_CHART_SECONDS);
  if (!candidates.length) return [];

  /*
   * 间隔自适应。
   *
   * 固定 CHART_GAP_BEATS=2 在长片（10 句以上）是对的，但短片只有 5~6 句时
   * 只能排下 2~3 张图，剩下 2~3 张会被**静默丢掉** —— 用户看到的现象是
   * 「明明分析出 5 张图，成片只有 2 张」。
   * 于是从 2 开始往下试，取**能排下全部图表的最大间隔**；排不下就退到 1，
   * 宁可图表挨得近一点，也不丢数据。
   */
  const gap = (() => {
    for (let g = CHART_GAP_BEATS; g > 1; g--) {
      if (Math.ceil(candidates.length / g) >= charts.length) return g;
    }
    return 1;
  })();

  const beatKeywords = beats.map((b) => keywords(b.text));
  const out: Array<{ chart: InjectableChart; beatIndex: number }> = [];
  let nextAllowed = 1;

  for (const chart of charts) {
    const spec = chartToOverlay(chart, "chart");
    if (!spec) continue;

    // 图表自身的关键词：标题 + 每个数据项的类目名
    const own = keywords(chart.title);
    if (spec.items) for (const it of spec.items) for (const k of keywords(it.label)) own.add(k);
    if (spec.bullets) for (const b of spec.bullets) for (const k of keywords(b)) own.add(k);
    if (spec.rows) for (const row of spec.rows) for (const cell of row) for (const k of keywords(cell)) own.add(k);

    let best: { beatIndex: number; score: number } | null = null;
    for (const { i } of candidates) {
      if (i < nextAllowed) continue;
      let score = 0;
      for (const k of beatKeywords[i]) if (own.has(k)) score += 1;
      // 同分时取更靠前的句子：图表密集分布在前半段，后半段留给文字图层收尾。
      if (!best || score > best.score || (score === best.score && i < best.beatIndex)) {
        best = { beatIndex: i, score };
      }
    }

    if (!best) break;
    out.push({ chart, beatIndex: best.beatIndex });
    nextAllowed = best.beatIndex + gap;
  }

  // 一张图都没挂上时，退到「第一句之后的最后一句」：
  // 至少让观众看到图表，而不是因为没排下落点就整张丢弃。
  if (!out.length && charts.length) {
    const fallbackIndex = Math.min(beats.length - 1, 1);
    if ((last.endMs - first.startMs) / 1000 >= MIN_CHART_SECONDS && fallbackIndex > 0) {
      out.push({ chart: charts[0], beatIndex: fallbackIndex });
    }
  }
  return out;
}

export type InjectChartsInput = {
  charts: InjectableChart[];
  beats: TimelineBeat[];
  /** 场景出点序列；图表出点会被 clamp 到它的最大值（schema 红线）。 */
  sceneOutPoints: number[];
  /** 图层 id 前缀，避免与 DSH 产出的 o1/o2 撞号。 */
  idPrefix?: string;
};

/**
 * 把文章图表翻译成视频图层并排进时间轴。
 *
 * 没有可注入的图表时返回空数组（不报错、不产出提示）——
 * 纯图片转视频链路走的就是这条空路径，行为与改造前完全一致。
 */
export function injectChartOverlays(input: InjectChartsInput): ChartInjectionResult {
  const beats = input.beats ?? [];
  const sceneMax = input.sceneOutPoints.length
    ? Math.max(...input.sceneOutPoints)
    : beats.length
      ? beats[beats.length - 1].endMs / 1000
      : 0;
  if (!beats.length || !Number.isFinite(sceneMax) || sceneMax <= 0) {
    return { overlays: [], kindHint: "", spans: [] };
  }

  // 降级图（溯源不过）不进图表图层：它们没有可信数值，画出来等于给观众看假数据。
  const usable = (input.charts ?? []).filter((c) => c && !c.downgraded);
  const assigned = assignBeats(usable, beats);
  if (!assigned.length) return { overlays: [], kindHint: "", spans: [] };

  const overlays: OverlaySpec[] = [];
  const spans: Array<{ startSeconds: number; endSeconds: number }> = [];
  /*
   * 图表总时长配额：最多占 70% 的画面时间。
   *
   * 没有这条约束时，「间隔自适应到 1」的极端情况会让图表铺满整条时间轴 ——
   * 排他逻辑把 DSH 的文字图层全撤掉，成片变成一串图表连播，
   * 看不到镜头运动与文字层次。留出 30% 给运镜与小标题，观感才立得住。
   */
  const chartBudget = sceneMax * CHART_TIMELINE_SHARE;
  let usedSeconds = 0;

  for (const { chart, beatIndex } of assigned) {
    const beat = beats[beatIndex];
    if (!beat) continue;
    const spec = chartToOverlay(chart, input.idPrefix ?? "chart");
    if (!spec) continue;

    const startSeconds = Math.max(0, beat.startMs / 1000);
    // 出点 clamp 到场景总长：再晚一点就会被 schema 判「文字压到下一镜头」。
    const endSeconds = Math.min(beat.endMs / 1000, sceneMax);
    const duration = endSeconds - startSeconds;
    if (duration < MIN_CHART_SECONDS) continue;
    // 配额满了就不再加；优先级天然是「文章里先出现的图先上」。
    if (usedSeconds + duration > chartBudget) continue;

    overlays.push({ ...spec, inSeconds: round2(startSeconds), outSeconds: round2(endSeconds) });
    spans.push({ startSeconds: round2(startSeconds), endSeconds: round2(endSeconds) });
    usedSeconds += duration;
  }

  if (!overlays.length) return { overlays: [], kindHint: "", spans: [] };

  return {
    overlays,
    // 提示按**实际注入出来的图层**算，不用输入的原始清单 ——
    // 排不下落点的图没被注入，就不该在 prompt 里承诺它。
    kindHint: summarizeOverlayKinds(overlays),
    spans,
  };
}

/**
 * 把注入的图表图层并进已有分镜：追加图表 + 撤掉与之打架的 DSH 图层。
 *
 * 保留 hero_title：它在开场 0~3.5 秒，而图表从第 2 句才开始，理论上不重叠；
 * 万一重叠了也该保片头 —— 它是唯一承载文章标题的地方。
 */
export function mergeChartOverlays(
  existing: OverlaySpec[] | undefined,
  injected: ChartInjectionResult
): OverlaySpec[] {
  if (!injected.overlays.length) return existing ?? [];
  const keep = (existing ?? []).filter((o) => {
    if (o.kind === "hero_title") return true;
    const from = o.inSeconds ?? 0;
    const to = o.outSeconds ?? Number.POSITIVE_INFINITY;
    return !injected.spans.some((s) => overlapSeconds(from, to, s.startSeconds, s.endSeconds) > 0.35);
  });
  return [...keep, ...injected.overlays];
}

function overlapSeconds(aFrom: number, aTo: number, bFrom: number, bTo: number): number {
  return Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* 常驻页面装饰                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 文章转视频的常驻装饰：顶部彩条 + 页眉（文章标题）+ 页脚（来源）+ 进度线。
 *
 * 全部由**服务端**填，不交给 DSH：页眉每次都不一样会让成片风格漂移，
 * 而「全片同一个外壳」恰恰是这类信息密度视频成立的前提。
 */
export function buildStoryChrome(input: {
  title?: string;
  sourceLabel?: string;
}): ChromeSpec | undefined {
  const title = (input.title ?? "").trim().slice(0, 22);
  const source = (input.sourceLabel ?? "").trim().slice(0, 40);
  if (!title && !source) return undefined;
  return {
    topBar: true,
    progress: true,
    ...(title ? { headerText: title } : {}),
    ...(source ? { footerText: `来源：${source}` } : {}),
  };
}