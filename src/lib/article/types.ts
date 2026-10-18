/**
 * 「文章转视频」的持久化契约。
 *
 * 单独成文件的原因：`VideoPlanDraft` 在 src/lib/video/pipeline.ts，而编排逻辑在
 * src/lib/article/。类型放在这里让两边都只依赖纯类型，避免相互 import 产生环。
 */
import type { ChartKind } from "./analyze";

/** 方案面板里「图表清单」的每一项。imagePath 是磁盘绝对路径，webPath 用于缩略图。 */
export type ArticleChartSummary = {
  id: string;
  kind: ChartKind;
  title: string;
  imagePath: string;
  webPath: string;
  /** 人话版数据摘要，例如「3 项 · 最高 120 亿」。 */
  dataSummary: string;
  /** 关联的 dataPoint id，可与方案里的「数据出处」对账。 */
  sourceRefs: string[];
  /** true = 画面上的每个数字都在原文/搜索结果里核对过。 */
  verified: boolean;
  /** true = 数据过不了溯源校验或绘制失败，已降级为不含数值的图卡。 */
  downgraded: boolean;
  downgradeReason?: string;
};

/**
 * VideoPlanDraft 的可选扩展，落进 VideoPlan.draftJson。
 *
 * 可选字段对既有三条链路（generate / montage / remake）零影响：
 * JSON.stringify 落库、JSON.parse resume 都照常工作。
 */
export type ArticlePlanExtension = {
  sourceType: "url" | "document" | "paste";
  sourceLabel: string;
  sourceUrl?: string;
  title: string;
  summary: string;
  keyPoints: string[];
  charts: ArticleChartSummary[];
  /** 本次是否真的联网搜过（用户勾选且确实触发）。 */
  searchUsed: boolean;
  /** 联网后仍未补上的数据缺口，如实展示。 */
  dataGaps: string[];
  /** 过程中的告警：联网失败、图表降级、字体缺失……不许静默。 */
  notices: string[];
};

/** 图表类型的中文名，供方案面板与 CLI 转述共用。 */
export const ARTICLE_CHART_KIND_LABELS: Record<ChartKind, string> = {
  bar: "柱状图",
  line: "折线图",
  pie: "饼图",
  kpi: "数字卡",
  timeline: "时间线",
  info: "图卡",
};