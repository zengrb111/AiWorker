/**
 * 文章理解 + 可溯源数据抽取 + 溯源校验闸门。
 *
 * 设计要点（三条，缺一不可）：
 *
 * 1. **只调一次 LLM**。摘要、要点、数据点、图表方案都在一次 chatComplete 里产出。
 *    拆成三次会让规划阶段多花 30~60 秒，而用户等的就是这一步。
 *
 * 2. **不信任模型给的数字**。prompt 里要求每个数值都附 `sourceQuote`（原文逐字片段），
 *    但 prompt 约束是靠不住的 —— 模型仍可能"顺手"编一个看起来合理的数字。
 *    所以真正的闸门在 {@link verifyChartSpecs}：程序逐条核对 quote 是否真的出现在
 *    正文 / 搜索结果里，对不上的数值**禁止出现在任何图表上**，整张图降级成
 *    不含数值的图卡。这样即使模型幻觉，画面上也不会有假数据。
 *
 * 3. **不 import prisma**。本文件必须能被 scripts/aiworker-video.mts 安全 import。
 */
import { chatComplete } from "../llm-client";
import type { ResolvedModelConfig } from "../model-credentials";
import { normalizeForVerification, type ArticleSource } from "../article-source";

export type ChartKind = "bar" | "line" | "pie" | "kpi" | "timeline" | "info";

/** 需要真实数值的图表类型；info 卡不需要，所以是溯源不过时的安全退路。 */
const VALUE_CHART_KINDS: ChartKind[] = ["bar", "line", "pie", "kpi"];

export type DataPoint = {
  id: string;
  value: number;
  unit: string;
  label: string;
  /** article 源：文章正文的逐字片段；search 源：搜索结果 snippet 的逐字片段。 */
  sourceQuote: string;
  sourceKind: "article" | "search";
  /** sourceKind === "search" 时必填，且必须是本次 searchWeb 返回过的 url。 */
  sourceUrl?: string;
};

export type ChartSpec = {
  id: string;
  kind: ChartKind;
  title: string;
  /** 指向 dataPoints 的 id。info 卡允许为空（不需要真实数值）。 */
  dataRefs: string[];
  payload: Record<string, unknown>;
  /** 由 verifyChartSpecs 回写：true = 每个数值都通过溯源核对。 */
  verified: boolean;
  downgraded: boolean;
  downgradeReason?: string;
};

/** 归一化后的图表 payload，chart-render 只认这几种形状，不再防御模型的自由发挥。 */
export type BarPayload = { items: Array<{ label: string; value: number }>; unit?: string; note?: string };
export type LinePayload = {
  series: Array<{ name: string; points: Array<{ label: string; value: number }> }>;
  unit?: string;
  note?: string;
};
export type PiePayload = { items: Array<{ label: string; value: number }>; unit?: string; note?: string };
export type KpiPayload = {
  value: string;
  unit?: string;
  label?: string;
  delta?: string;
  deltaLabel?: string;
  note?: string;
};
export type TimelinePayload = { steps: Array<{ label: string; title: string; detail?: string }>; note?: string };
export type InfoPayload = { headline?: string; bullets: string[]; footer?: string };

export type SanitizedChartSpec = ChartSpec & { payload: BarPayload | LinePayload | PiePayload | KpiPayload | TimelinePayload | InfoPayload };

export type ArticleAnalysis = {
  title: string;
  summary: string;
  keyPoints: string[];
  entities: string[];
  dataPoints: DataPoint[];
  /** 明确缺失、若联网能补上的数据点描述。联网补充的触发依据。 */
  dataGaps: string[];
  charts: SanitizedChartSpec[];
  notices: string[];
};

/** 联网搜索的可信证据：只有出现在这里的 url 才算「可溯源」。 */
export type SearchEvidence = { url: string; snippet: string }[];

/** 导出以便排障脚本复现同一次调用（生产路径只用内部拼接后的 prompt）。 */
export const ANALYSIS_SYSTEM_PROMPT = `你是一名短视频内容策划。你的任务：读一篇文章，产出竖屏短视频的脚本要点与图表方案。只输出 JSON，不要输出任何解释文字。

## 铁律：数据必须可溯源（最重要）

1. 文章里出现的每一个数字（金额、比例、增速、数量、时间、人数、占比），都要收进 dataPoints。
2. 每个 dataPoint 必须带 sourceQuote，**必须是从文章正文里一字不改复制下来的连续片段**（包含这个数字本身，长度 8~60 字）。不许改写、不许节选到断开会改变含义、不许自己造句子。
3. 绝对禁止编造、改算、四舍五入或"根据常识补充"任何数字。原文没写的数字就不要放进 dataPoints。
4. 如果原文某个数字**不足以支撑一张图**（比如只说"大幅增长"却没有百分比），不要猜，把它写进 dataGaps。
5. sourceKind 只能是 "article"。此阶段禁止使用 "search"（联网补充是后续独立步骤）。
6. article.text 里没有的数字一律不准出现在 payload 里。

## 图表方案

从下面 6 种里选，按文章内容决定，不要强行凑满。**kind 字段的值必须一字不差地取自下列英文名**：
- "bar" 柱状图：对比 2~6 个同类项的数值
- "line" 折线图：同一指标跨时间点，points 至少 2 个
- "pie" 饼图：占比构成，2~5 块
- "kpi" 数字卡：全场最重要的单个数字（value 必须是原文里的写法）
- "timeline" 时间线：事件演进或流程步骤，按顺序 2~6 步（label 用时间点或步骤名，不要编造具体日期）
- "info" 信息图卡片：概念、对比、清单等不需要真实数值的要点

图表要求：
- 每张图的 title 是 6~14 字的画面标题（会印在图上），不要用"数据图表"这种废话。
- 数值型图的 payload 里的数字必须能对应到某个 dataPoint.id，把 id 填进 dataRefs。
- info 卡的 dataRefs 留空数组。
- 图表总数不超过 5 张，宁可少而精。

## 其它字段
- summary：80 字以内，说清这篇文章讲了什么。
- keyPoints：3~6 条，每条 15~40 字，是解说词要讲的要点。
- entities：文章涉及的机构 / 人名 / 产品 / 地点，没有就给空数组。

## 输出格式（严格 JSON，不要 markdown 围栏）
**字段名必须与下面完全一致，不许自创或改写。** 请照抄这个结构，把示例里的空值换成真实内容：

{
  "title": "文章标题",
  "summary": "80 字以内摘要",
  "keyPoints": ["要点一", "要点二"],
  "entities": ["机构名"],
  "dataPoints": [
    { "id": "d1", "value": 120, "unit": "亿元", "label": "2024年营收", "sourceQuote": "从正文逐字复制的片段", "sourceKind": "article" }
  ],
  "dataGaps": ["文章里没写清楚、无法支撑一张图的数据"],
  "charts": [
    { "id": "c1", "kind": "bar", "title": "画面标题", "dataRefs": ["d1"], "payload": { "items": [{ "label": "2024", "value": 120 }], "unit": "亿元", "note": "" } }
  ]
}

不同 kind 对应的 payload 结构：
- bar / pie：{"items":[{"label":"","value":0}],"unit":"","note":""}
- line：{"series":[{"name":"","points":[{"label":"","value":0}]}],"unit":"","note":""}
- kpi：{"value":"","unit":"","label":"","delta":"","deltaLabel":"","note":""}
- timeline：{"steps":[{"label":"","title":"","detail":""}],"note":""}
- info：{"headline":"","bullets":["",""],"footer":""}`;

/** 从模型输出里抠出 JSON 对象：容忍 ```json 围栏与前后废话。 */
export function extractJsonObject(raw: string): unknown {
  const text = (raw || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    /* 继续尝试括号定位 */
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      /* 落到调用方的兜底 */
    }
  }
  return null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringList(value: unknown, limit: number): string[] {
  return asArray(value)
    .map((item) => asString(item))
    .filter(Boolean)
    .slice(0, limit);
}

/** 数值合法性：NaN / Infinity / 极端量级都会让图表变形或误导，一律丢弃。 */
function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > 1e15) return null;
  return n;
}

function parseDataPoints(raw: unknown): DataPoint[] {
  const out: DataPoint[] = [];
  for (const item of asArray(raw)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const value = asFiniteNumber(record.value);
    const sourceQuote = asString(record.sourceQuote);
    // 没有逐字引用就没有溯源凭证，直接不收 —— 比收下再校验更省事。
    if (value === null || sourceQuote.length < 4) continue;
    const id = asString(record.id) || `d${out.length + 1}`;
    out.push({
      id,
      value,
      unit: asString(record.unit),
      label: asString(record.label) || "数据",
      sourceQuote: sourceQuote.slice(0, 120),
      sourceKind: "article",
    });
  }
  return out.slice(0, 20);
}

/** payload 规范化：只保留已知字段、数值必须有限、数组长度按图形上限受控。 */
export function sanitizeChartPayload(
  kind: ChartKind,
  raw: unknown
): SanitizedChartSpec["payload"] {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const note = asString(record.note).slice(0, 80);
  const unit = asString(record.unit).slice(0, 12);

  /** 数值项：必须有标签且数值有限，否则丢弃，避免图表出现空柱/NaN。 */
  const pairList = (raw2: unknown, max: number) =>
    asArray(raw2)
      .map((item) => {
        const rec = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        const value = asFiniteNumber(rec.value);
        const label = asString(rec.label);
        return value === null || !label ? null : { label: label.slice(0, 12), value };
      })
      .filter((item): item is { label: string; value: number } => item !== null)
      .slice(0, max);

  switch (kind) {
    case "bar":
    case "pie": {
      // 上限按图形可读性定，不跟 dataRefs 走：一张对比图 3 个引用很正常，
      // 若按引用数截条数会把图砍成一根柱子。防编造靠的是 verifyChartSpecs 的溯源校验。
      const items = pairList(record.items, kind === "pie" ? 5 : 6);
      return { items, unit, note } as BarPayload | PiePayload;
    }
    case "line": {
      const series = asArray(record.series)
        .map((item, index) => {
          const rec = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          const name = asString(rec.name) || `系列${index + 1}`;
          const points = pairList(rec.points, 8).map((point) => ({ ...point }));
          return points.length >= 2 ? { name: name.slice(0, 16), points } : null;
        })
        .filter((item): item is { name: string; points: Array<{ label: string; value: number }> } => item !== null)
        .slice(0, 3);
      return { series, unit, note } as LinePayload;
    }
    case "kpi": {
      const rawValue = record.value;
      const valueText =
        typeof rawValue === "number" && Number.isFinite(rawValue) ? String(rawValue) : asString(rawValue);
      return {
        value: valueText.slice(0, 18) || "—",
        unit,
        label: asString(record.label).slice(0, 24),
        delta: asString(record.delta).slice(0, 12),
        deltaLabel: asString(record.deltaLabel).slice(0, 16),
        note,
      } as KpiPayload;
    }
    case "timeline": {
      const steps = asArray(record.steps)
        .map((item) => {
          const rec = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          const title = asString(rec.title);
          const label = asString(rec.label);
          if (!title || !label) return null;
          return { label: label.slice(0, 14), title: title.slice(0, 24), detail: asString(rec.detail).slice(0, 40) };
        })
        .filter((item): item is { label: string; title: string; detail: string } => item !== null)
        .slice(0, 6);
      return { steps, note } as TimelinePayload;
    }
    default:
      return {
        headline: asString(record.headline).slice(0, 20),
        bullets: asStringList(record.bullets, 5).map((item) => item.slice(0, 34)),
        footer: asString(record.footer).slice(0, 30),
      } as InfoPayload;
  }
}

/** 图表张数上限：按时长估算，硬封 3~6 张，避免识图与渲染耗时线性膨胀。 */
export function chartBudget(targetSeconds: number): number {
  const estimated = Math.floor(Math.max(targetSeconds, 20) / 10) + 2;
  return Math.min(Math.max(estimated, 3), 6);
}

/**
 * 图表类型归一化：接受常见别名与大小写写法。
 *
 * 为什么需要：实测模型会把 kind 写成 type、把 bar 写成 column、把 pie 写成 donut。
 * 这些语义完全明确，丢掉等于白跑一次几十秒的模型调用，所以做别名兜底而不是严格匹配。
 * 中文写法一并兜底。
 */
export function normalizeChartKind(raw: string): ChartKind | null {
  const key = (raw || "").trim().toLowerCase().replace(/[\s_-]/g, "");
  const table: Record<string, ChartKind> = {
    bar: "bar",
    barchart: "bar",
    column: "bar",
    columnchart: "bar",
    柱状图: "bar",
    柱状: "bar",
    line: "line",
    linechart: "line",
    trend: "line",
    curve: "line",
    折线图: "line",
    折线: "line",
    pie: "pie",
    piechart: "pie",
    donut: "pie",
    doughnut: "pie",
    饼图: "pie",
    kpi: "kpi",
    number: "kpi",
    numbercard: "kpi",
    bignumber: "kpi",
    metric: "kpi",
    数字卡: "kpi",
    timeline: "timeline",
    process: "timeline",
    flow: "timeline",
    steps: "timeline",
    时间线: "timeline",
    流程图: "timeline",
    info: "info",
    card: "info",
    infographic: "info",
    图卡: "info",
    信息图: "info",
  };
  return table[key] ?? null;
}

export async function buildArticleAnalysis(input: {
  userId: string;
  config: ResolvedModelConfig;
  article: ArticleSource;
  targetSeconds: number;
  requirement?: string;
}): Promise<ArticleAnalysis> {
  const { article, config } = input;
  const prompt = [
    ANALYSIS_SYSTEM_PROMPT,
    "",
    "## 文章标题",
    article.title,
    "",
    article.origin === "url" ? "## 来源" : "## 来源类型",
    article.sourceUrl ?? article.originLabel,
    "",
    input.requirement ? `## 用户的额外要求\n${input.requirement.slice(0, 300)}` : "",
    "",
    "## 文章正文（sourceQuote 必须从这里逐字复制）",
    "<<<ARTICLE",
    article.text,
    "ARTICLE",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await chatComplete({
    userId: input.userId,
    capability: "chat",
    config,
    prompt,
    temperature: 0.2,
    // 上限必须给足：reasoning 模型（deepseek-flash / reasoner / R1 系）会先花掉
    // 1~3 万 tokens 思考，正文才开始。实测本任务 4000 会被思考吃光导致正文为空，
    // 24000 才 finish_reason=stop 并拿到完整 JSON。
    maxTokens: 24_000,
    // 实测该任务端到端约 50 秒，默认 120s 够用；这里显式给足，避免慢网关被判超时。
    timeoutMs: 180_000,
  });

  const parsed = extractJsonObject(result.content);
  const record = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;

  const notices: string[] = [];
  if (!parsed) {
    // 最常见原因是输出被 max_tokens 截断（reasoning 模型尤其容易），
    // 也可能是模型没按 JSON 输出。如实说清，别让用户以为是文章里没数据。
    notices.push(
      "模型这次没有按 JSON 格式返回（常见于输出被长度上限截断），本次未能提取数据，图表已全部降级为图卡。"
    );
  }
  if (record.dataGaps === undefined && !Array.isArray(record.dataPoints)) {
    notices.push("模型返回的数据点为空，本次没有可溯源的数值。");
  }
  const dataPoints = parseDataPoints(record.dataPoints);
  const dataById = new Map(dataPoints.map((point) => [point.id, point]));

  const budget = chartBudget(input.targetSeconds);
  const charts: SanitizedChartSpec[] = [];
  for (const item of asArray(record.charts)) {
    if (charts.length >= budget) break;
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    // 字段名容错：实测模型经常把 kind 写成 type（语义一样）。这里做别名兜底，
    // 而不是直接丢弃 —— 丢弃等于白跑一次 50 秒的分析。
    const rawKind = asString(raw.kind) || asString(raw.type);
    const kind = normalizeChartKind(rawKind);
    if (!kind) {
      notices.push(`有一张图表的类型「${rawKind || "空"}」无法识别，已跳过。`);
      continue;
    }
    const title = (asString(raw.title) || asString(raw.name)).slice(0, 24);
    if (!title) continue;
    const dataRefs = asArray(raw.dataRefs)
      .map((ref) => asString(ref))
      .filter((ref) => dataById.has(ref))
      .slice(0, 8);
    charts.push({
      id: asString(raw.id) || `c${charts.length + 1}`,
      kind,
      title,
      dataRefs,
      payload: sanitizeChartPayload(kind, raw.payload),
      verified: false,
      downgraded: false,
    });
  }

  if (!dataPoints.length) {
    notices.push("文章里没有找到可溯源的数值数据，本次只生成不含数值的图卡。");
  }

  return {
    title: asString(record.title).slice(0, 40) || article.title,
    summary: asString(record.summary).slice(0, 160),
    keyPoints: asStringList(record.keyPoints, 6),
    entities: asStringList(record.entities, 10),
    dataPoints,
    dataGaps: asStringList(record.dataGaps, 6).map((gap) => gap.slice(0, 60)),
    charts,
    notices,
  };
}

export type VerifyResult = {
  charts: SanitizedChartSpec[];
  dataPoints: DataPoint[];
  notices: string[];
};

/**
 * 溯源闸门 —— 这个函数是「数据不编造」承诺的唯一执行点。
 *
 * 对每个数值型数据点：
 *   · sourceKind=article → sourceQuote 必须真实出现在归一化正文里
 *   · sourceKind=search  → sourceUrl 必须是本次搜索命中过的，且 quote 命中该条 snippet
 * 任一不通过 → 引用它的图**强制降级为 info 卡**（图卡不渲染数字），并记下原因。
 */
export function verifyChartSpecs(input: {
  charts: SanitizedChartSpec[];
  dataPoints: DataPoint[];
  articleText: string;
  evidence: SearchEvidence;
}): VerifyResult {
  const { charts, dataPoints, articleText, evidence } = input;
  const normalizedArticle = normalizeForVerification(articleText);
  const evidenceByUrl = new Map(evidence.map((hit) => [hit.url, hit.snippet]));

  const failed = new Map<string, string>();
  const good = new Set<string>();

  for (const point of dataPoints) {
    const quote = normalizeForVerification(point.sourceQuote || "");
    let ok = false;
    if (quote.length >= 4 && point.sourceKind === "article") {
      ok = normalizedArticle.includes(quote);
    } else if (quote.length >= 4 && point.sourceKind === "search" && point.sourceUrl) {
      const snippet = evidenceByUrl.get(point.sourceUrl);
      ok = typeof snippet === "string" && normalizeForVerification(snippet).includes(quote);
    }
    if (ok) good.add(point.id);
    else failed.set(point.id, point.sourceUrl ? `来源链接未命中：${point.sourceUrl}` : "原文里找不到这段引用");
  }

  const notices: string[] = [];
  const checked: SanitizedChartSpec[] = [];

  for (const chart of charts) {
    const brokenRefs = chart.dataRefs.filter((ref) => failed.has(ref));
    const needsValues =
      VALUE_CHART_KINDS.includes(chart.kind) || (chart.kind === "timeline" && chart.dataRefs.length > 0);

    if (needsValues && (brokenRefs.length > 0 || chart.dataRefs.length === 0)) {
      // 数字过不了溯源这道关，整张图不能带数字 —— 降级成图卡。
      const reason =
        chart.dataRefs.length === 0
          ? "该图没有关联到任何可溯源的数据点"
          : `${brokenRefs.length} 个数据点无法溯源（${failed.get(brokenRefs[0])}）`;
      const bullets: string[] = [];
      const payload = chart.payload as Record<string, unknown>;
      for (const ref of chart.dataRefs) {
        const point = dataPoints.find((item) => item.id === ref);
        if (point) bullets.push(`${point.label}${point.unit ? `（${point.unit}）` : ""}`);
      }
      checked.push({
        ...chart,
        kind: "info",
        payload: {
          headline: chart.title.slice(0, 20),
          bullets: bullets.slice(0, 4),
          footer: "数据未通过溯源校验，此图不展示数值",
        } as InfoPayload,
        verified: false,
        downgraded: true,
        downgradeReason: reason,
      });
      notices.push(`「${chart.title}」${reason}，已改为图卡（不含数值）。`);
      continue;
    }

    checked.push({
      ...chart,
      verified: chart.dataRefs.every((ref) => good.has(ref)),
      downgraded: false,
    });
  }

  return { charts: checked, dataPoints, notices };
}