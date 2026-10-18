/**
 * 图表渲染 —— 把文章里的数据画成 1080×1920 的竖屏画面 PNG。
 *
 * 为什么用 canvas 画而不是让 AI 生图：图上的**文字和数字必须永远正确**。生图模型
 * 会把「12.5%」画成「12.5％」甚至凭空多一个数字。所以图是程序画的，AI 只负责
 * 决定「画什么图、数据是多少」，且那些数字要先过 analyze.ts 的溯源闸门。
 *
 * 为什么是 1080×1920：与 remotion/src/vertical/schema.ts 的 Storyboard.width/height
 * 严格一致。渲染层用 objectFit:"cover" 铺满，画面正好满幅不裁切。
 *
 * 为什么要留底部空档：成片会在下方烧录字幕，把数据画在底部会被字幕压住。所以内容
 * 只画到 1520px，剩下 400px 空出来。
 *
 * 字体族名独立用 AiWorkerChart（不与 image-gen.ts 的 AiWorkerCover 混用），候选
 * 列表同样**只允许免费可商用字体** —— 历史踩坑：simhei / msyh 都有商业授权问题。
 */
import { createCanvas, GlobalFonts, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { join } from "node:path";
import { resolveTheme, type ThemeConfig } from "../../../remotion/src/theme";
import type { ChartKind, SanitizedChartSpec } from "./analyze";
import type {
  BarPayload,
  InfoPayload,
  KpiPayload,
  LinePayload,
  PiePayload,
  TimelinePayload,
} from "./analyze";

const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;
/** 字幕区高度，这一段刻意留白。 */
const SAFE_BOTTOM = 400;
const CONTENT_TOP = 96;
const CONTENT_BOTTOM = CANVAS_HEIGHT - SAFE_BOTTOM;
const SIDE_PADDING = 84;
const FOOTNOTE_Y = CONTENT_BOTTOM + 34;

const CHART_FONT_FAMILY = "AiWorkerChart";

/** 只允许免费可商用字体（与 image-gen.ts 保持同一份候选与理由）。 */
const CHART_FONT_CANDIDATES = [
  path.join(process.cwd(), "assets", "fonts", "NotoSansSC-VF.ttf"),
  "C:\\Windows\\Fonts\\NotoSansSC-VF.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
];

let chartFontReady: boolean | null = null;
function ensureChartFont(): boolean {
  if (chartFontReady !== null) return chartFontReady;
  for (const candidate of CHART_FONT_CANDIDATES) {
    try {
      if (GlobalFonts.registerFromPath(candidate, CHART_FONT_FAMILY)) {
        chartFontReady = true;
        return true;
      }
    } catch {
      /* 换下一个候选 */
    }
  }
  console.error(
    "[article-chart] 中文字体注册失败，图表文字可能显示为方块。请确认 assets/fonts/NotoSansSC-VF.ttf 存在。"
  );
  chartFontReady = false;
  return false;
}

function setFont(ctx: SKRSContext2D, weight: "normal" | "bold", size: number): void {
  ctx.font = `${weight} ${size}px "${CHART_FONT_FAMILY}", sans-serif`;
}

/** 在不改 ctx 字体的情况下测一段文字的宽度（用于「数值 + 单位」整体居中的排版计算）。 */
function measureWithFont(
  ctx: SKRSContext2D,
  text: string,
  weight: "normal" | "bold",
  size: number
): number {
  const previous = ctx.font;
  setFont(ctx, weight, size);
  const width = ctx.measureText(text).width;
  ctx.font = previous;
  return width;
}

/** 中文按像素宽度折行（逐字测量），超出 maxLines 末行加省略号。 */
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const lines: string[] = [];
  let current = "";
  let truncated = false;
  for (const ch of clean) {
    const candidate = current + ch;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = ch;
      if (lines.length === maxLines) {
        truncated = true;
        break;
      }
    } else {
      current = candidate;
    }
  }
  if (!truncated && current) lines.push(current);
  if (truncated && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last.length > 0 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = `${last}…`;
  }
  return lines.slice(0, maxLines);
}

function roundRectPath(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** 数值显示：大数收敛成「万」，小数最多两位，总长受控避免撑破。 */
function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (abs >= 10_000) return `${(value / 10_000).toFixed(abs >= 100_000 ? 1 : 2)}万`;
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(2)));
}

function withAlpha(hex: string, alpha: number): string {
  const clean = (hex || "#888888").replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const n = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return `rgba(136,136,136,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** 背景：主题底色 + 顶部主色渐晕，保证与成片配色同源。 */
function drawBackground(ctx: SKRSContext2D, theme: ThemeConfig): void {
  ctx.fillStyle = theme.backgroundColor;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const glow = ctx.createRadialGradient(
    CANVAS_WIDTH * 0.2,
    CANVAS_HEIGHT * 0.12,
    0,
    CANVAS_WIDTH * 0.2,
    CANVAS_HEIGHT * 0.12,
    CANVAS_WIDTH * 1.1
  );
  glow.addColorStop(0, withAlpha(theme.primaryColor, 0.16));
  glow.addColorStop(1, withAlpha(theme.primaryColor, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
}

/** 标题区：主色短杠 + 折行标题 + 单位提示。返回内容区起始 y。 */
function drawHeader(ctx: SKRSContext2D, theme: ThemeConfig, title: string, unit: string): number {
  ctx.fillStyle = theme.primaryColor;
  roundRectPath(ctx, SIDE_PADDING, CONTENT_TOP, 12, 46, 6);
  ctx.fill();

  setFont(ctx, "bold", 58);
  ctx.fillStyle = theme.textColor;
  ctx.textBaseline = "top";
  const lines = wrapText(ctx, title, CANVAS_WIDTH - SIDE_PADDING * 2 - 40, 2);
  let y = CONTENT_TOP + 72;
  for (const line of lines) {
    ctx.fillText(line, SIDE_PADDING, y);
    y += 74;
  }

  if (unit) {
    setFont(ctx, "normal", 30);
    ctx.fillStyle = theme.mutedTextColor;
    ctx.fillText(`单位：${unit}`, SIDE_PADDING, y + 4);
    y += 48;
  }

  ctx.strokeStyle = withAlpha(theme.textColor, 0.12);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(SIDE_PADDING, y + 6);
  ctx.lineTo(CANVAS_WIDTH - SIDE_PADDING, y + 6);
  ctx.stroke();

  return y + 40;
}

/** 来源脚注：把「可溯源」这件事直接画在画面上。 */
function drawFootnote(
  ctx: SKRSContext2D,
  theme: ThemeConfig,
  verified: boolean,
  sourceLabel: string,
  note?: string
): void {
  setFont(ctx, "normal", 27);
  ctx.fillStyle = verified ? theme.mutedTextColor : withAlpha(theme.primaryColor, 0.95);
  const badge = verified ? "✓ 数据已溯源" : "△ 数据未溯源 · 本图不含数值";
  const text = sourceLabel ? `${badge} · ${sourceLabel}` : badge;
  ctx.fillText(text, SIDE_PADDING, FOOTNOTE_Y);

  if (note) {
    setFont(ctx, "normal", 24);
    ctx.fillStyle = theme.mutedTextColor;
    ctx.fillText(wrapText(ctx, note, CANVAS_WIDTH - SIDE_PADDING * 2, 1)[0] ?? "", SIDE_PADDING, FOOTNOTE_Y + 40);
  }
}

/* ------------------------------ 六种图表 ------------------------------ */

function renderBar(
  ctx: SKRSContext2D,
  theme: ThemeConfig,
  chart: SanitizedChartSpec,
  top: number
): void {
  const payload = chart.payload as BarPayload;
  const items = payload.items.filter((item) => Number.isFinite(item.value) && item.value >= 0);
  if (items.length < 2) throw new Error("柱状图可用数值不足");
  const plotLeft = SIDE_PADDING + 20;
  const plotRight = CANVAS_WIDTH - SIDE_PADDING - 20;
  const plotBottom = CONTENT_BOTTOM - 90;
  const plotTop = top + 90;
  const plotHeight = plotBottom - plotTop;
  const max = Math.max(...items.map((item) => item.value), 0) || 1;
  const slot = (plotRight - plotLeft) / items.length;
  const barWidth = Math.min(slot * 0.56, 150);

  // 横向网格线（3 条）
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = plotBottom - (plotHeight * i) / 3;
    ctx.strokeStyle = withAlpha(theme.textColor, i === 0 ? 0.28 : 0.1);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
  }

  items.forEach((item, index) => {
    const height = (item.value / max) * plotHeight;
    const x = plotLeft + slot * index + (slot - barWidth) / 2;
    const y = plotBottom - height;

    const grad = ctx.createLinearGradient(0, y, 0, plotBottom);
    const color = theme.chartColors[index % theme.chartColors.length] || theme.primaryColor;
    grad.addColorStop(0, color);
    grad.addColorStop(1, withAlpha(color, 0.45));
    ctx.fillStyle = grad;
    roundRectPath(ctx, x, y, barWidth, Math.max(height, 6), 12);
    ctx.fill();

    setFont(ctx, "bold", 34);
    ctx.fillStyle = theme.textColor;
    ctx.textAlign = "center";
    ctx.fillText(formatNumber(item.value), x + barWidth / 2, Math.max(y - 50, top + 4));
    ctx.textAlign = "left";

    setFont(ctx, "normal", 28);
    ctx.fillStyle = theme.mutedTextColor;
    ctx.textAlign = "center";
    const labelLines = wrapText(ctx, item.label, slot - 8, 2);
    labelLines.forEach((line, li) => {
      ctx.fillText(line, x + barWidth / 2, plotBottom + 20 + li * 36);
    });
    ctx.textAlign = "left";
  });
}

function renderLine(
  ctx: SKRSContext2D,
  theme: ThemeConfig,
  chart: SanitizedChartSpec,
  top: number
): void {
  const payload = chart.payload as LinePayload;
  const series = payload.series.filter((item) => item.points.length >= 2);
  if (!series.length) throw new Error("折线图没有可用系列");
  const plotLeft = SIDE_PADDING + 70;
  const plotRight = CANVAS_WIDTH - SIDE_PADDING - 40;
  const plotBottom = CONTENT_BOTTOM - 110;
  const plotTop = top + 90;
  const plotHeight = plotBottom - plotTop;

  const allValues = series.flatMap((item) => item.points.map((point) => point.value));
  const max = Math.max(...allValues);
  const min = Math.min(...allValues, 0);
  const span = max - min || 1;
  const labels = series[0].points.map((point) => point.label);
  /** x 轴按第一条系列的分段数打标签（各系列共用同一横轴）。 */
  const axisSegments = labels.length;

  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = plotBottom - (plotHeight * i) / 3;
    ctx.strokeStyle = withAlpha(theme.textColor, i === 0 ? 0.28 : 0.1);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
  }

  series.forEach((item, seriesIndex) => {
    const color = theme.chartColors[seriesIndex % theme.chartColors.length] || theme.primaryColor;
    const pointCount = item.points.length;
    const points = item.points.map((point, index) => ({
      x: plotLeft + (pointCount === 1 ? 0 : (plotRight - plotLeft) * (index / (pointCount - 1))),
      y: plotBottom - ((point.value - min) / span) * plotHeight,
      value: point.value,
    }));

    ctx.strokeStyle = color;
    ctx.lineWidth = 8;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();

    points.forEach((point) => {
      ctx.fillStyle = theme.backgroundColor;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 6;
      ctx.stroke();
    });

    if (seriesIndex === 0) {
      setFont(ctx, "bold", 30);
      points.forEach((point) => {
        ctx.fillStyle = theme.textColor;
        ctx.textAlign = "center";
        ctx.fillText(formatNumber(point.value), point.x, Math.max(point.y - 54, top + 6));
        ctx.textAlign = "left";
      });
    }
  });

  setFont(ctx, "normal", 26);
  ctx.fillStyle = theme.mutedTextColor;
  labels.forEach((label, index) => {
    if (axisSegments > 5 && index % 2 !== 0) return;
    const x = plotLeft + (axisSegments === 1 ? 0 : (plotRight - plotLeft) * (index / (axisSegments - 1)));
    ctx.textAlign = "center";
    ctx.fillText(label.slice(0, 8), x, plotBottom + 26);
    ctx.textAlign = "left";
  });

  if (series.length > 1) {
    let legendX = plotLeft;
    series.forEach((item, index) => {
      const color = theme.chartColors[index % theme.chartColors.length] || theme.primaryColor;
      ctx.fillStyle = color;
      roundRectPath(ctx, legendX, top + 26, 26, 26, 6);
      ctx.fill();
      setFont(ctx, "normal", 28);
      ctx.fillStyle = theme.mutedTextColor;
      ctx.fillText(item.name, legendX + 36, top + 24);
      legendX += 60 + ctx.measureText(item.name).width;
    });
  }
}

function renderPie(
  ctx: SKRSContext2D,
  theme: ThemeConfig,
  chart: SanitizedChartSpec,
  top: number
): void {
  const payload = chart.payload as PiePayload;
  const items = payload.items.filter((item) => Number.isFinite(item.value) && item.value > 0);
  if (items.length < 2) throw new Error("饼图可用数值不足");
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
  const centerX = SIDE_PADDING + 330;
  const centerY = top + (CONTENT_BOTTOM - top) / 2 - 20;
  const radius = 280;

  let start = -Math.PI / 2;
  items.forEach((item, index) => {
    const angle = (item.value / total) * Math.PI * 2;
    const color = theme.chartColors[index % theme.chartColors.length] || theme.primaryColor;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.arc(centerX, centerY, radius, start, start + angle);
    ctx.closePath();
    ctx.fill();

    const percent = (item.value / total) * 100;
    if (percent >= 8) {
      const mid = start + angle / 2;
      // 标签落在内外圈之间（内圈挖空半径 0.55、外沿 1.0），贴着 0.78 压线最少。
      const labelRadius = radius * 0.78;
      setFont(ctx, "bold", 34);
      ctx.fillStyle = "#101014";
      ctx.textAlign = "center";
      ctx.fillText(`${percent.toFixed(0)}%`, centerX + Math.cos(mid) * labelRadius, centerY + Math.sin(mid) * labelRadius);
      ctx.textAlign = "left";
    }
    start += angle;
  });

  // 内圈挖空，做成甜甜圈，中心写总量
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";

  setFont(ctx, "bold", 46);
  ctx.fillStyle = theme.textColor;
  ctx.textAlign = "center";
  ctx.fillText(formatNumber(total), centerX, centerY - 12);
  setFont(ctx, "normal", 26);
  ctx.fillStyle = theme.mutedTextColor;
  ctx.fillText("合计", centerX, centerY + 36);
  ctx.textAlign = "left";

  const legendX = SIDE_PADDING + 700;
  let legendY = centerY - 150;
  items.forEach((item, index) => {
    const color = theme.chartColors[index % theme.chartColors.length] || theme.primaryColor;
    ctx.fillStyle = color;
    roundRectPath(ctx, legendX, legendY, 24, 24, 6);
    ctx.fill();
    setFont(ctx, "normal", 28);
    ctx.fillStyle = theme.textColor;
    const text = `${item.label} ${((item.value / total) * 100).toFixed(1)}%`;
    ctx.fillText(wrapText(ctx, text, CANVAS_WIDTH - legendX - 40, 2)[0] ?? "", legendX + 34, legendY - 2);
    legendY += 62;
  });
}

function renderKpi(
  ctx: SKRSContext2D,
  theme: ThemeConfig,
  chart: SanitizedChartSpec,
  top: number
): void {
  const payload = chart.payload as KpiPayload;
  // 重心略低于内容区中心，视觉上更满（底部 400px 是字幕安全区，不能占）。
  const centerY = top + (CONTENT_BOTTOM - top) * 0.46;

  const value = payload.value || "—";
  const unit = payload.unit || "";
  // 「数值 + 单位」作为一整块居中：分别居中会让两段文字挤在画面中央重叠。
  let fontSize = 190;
  let valueWidth = 0;
  let unitWidth = 0;
  const maxWidth = CANVAS_WIDTH - SIDE_PADDING * 2;
  for (;;) {
    setFont(ctx, "bold", fontSize);
    valueWidth = ctx.measureText(value).width;
    unitWidth = unit ? measureWithFont(ctx, unit, "bold", 64) : 0;
    const total = valueWidth + (unit ? unitWidth + 18 : 0);
    if (total <= maxWidth || fontSize <= 84) break;
    fontSize -= 12;
  }

  ctx.fillStyle = theme.primaryColor;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const totalWidth = valueWidth + (unit ? unitWidth + 18 : 0);
  let cursorX = (CANVAS_WIDTH - totalWidth) / 2;
  setFont(ctx, "bold", fontSize);
  ctx.fillText(value, cursorX, centerY);
  cursorX += valueWidth + 18;
  if (unit) {
    setFont(ctx, "bold", 64);
    ctx.fillText(unit, cursorX, centerY + 18);
  }

  ctx.textAlign = "center";
  if (payload.label) {
    setFont(ctx, "normal", 40);
    ctx.fillStyle = theme.textColor;
    ctx.fillText(wrapText(ctx, payload.label, CANVAS_WIDTH - SIDE_PADDING * 2 - 80, 2)[0] ?? "", CANVAS_WIDTH / 2, centerY + 150);
  }

  if (payload.delta) {
    const badgeWidth = 260;
    const badgeX = CANVAS_WIDTH / 2 - badgeWidth / 2;
    const badgeY = centerY + 230;
    ctx.fillStyle = withAlpha(theme.primaryColor, 0.16);
    roundRectPath(ctx, badgeX, badgeY, badgeWidth, 72, 36);
    ctx.fill();
    setFont(ctx, "bold", 36);
    ctx.fillStyle = theme.primaryColor;
    ctx.fillText(payload.delta, CANVAS_WIDTH / 2 - (payload.deltaLabel ? 36 : 0), badgeY + 38);
    if (payload.deltaLabel) {
      setFont(ctx, "normal", 26);
      ctx.fillStyle = theme.mutedTextColor;
      ctx.fillText(payload.deltaLabel, CANVAS_WIDTH / 2 + 56, badgeY + 40);
    }
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function renderTimeline(
  ctx: SKRSContext2D,
  theme: ThemeConfig,
  chart: SanitizedChartSpec,
  top: number
): void {
  const payload = chart.payload as TimelinePayload;
  const steps = payload.steps.slice(0, 6);
  if (steps.length < 2) throw new Error("时间线步骤不足");
  const lineX = SIDE_PADDING + 60;
  // 步数少时把间距放大一点，画面才不至于挤在左上角；但要有上限，否则步数一多就溢出。
  const stepGap = Math.min(270, (CONTENT_BOTTOM - top - 80) / Math.max(steps.length - 1, 1));

  ctx.strokeStyle = withAlpha(theme.primaryColor, 0.5);
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(lineX, top + 30);
  ctx.lineTo(lineX, top + 30 + stepGap * (steps.length - 1));
  ctx.stroke();

  steps.forEach((step, index) => {
    const y = top + 30 + stepGap * index;

    ctx.fillStyle = theme.primaryColor;
    ctx.beginPath();
    ctx.arc(lineX, y, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = theme.backgroundColor;
    ctx.beginPath();
    ctx.arc(lineX, y, 7, 0, Math.PI * 2);
    ctx.fill();

    const textX = lineX + 60;
    setFont(ctx, "bold", 30);
    ctx.fillStyle = theme.primaryColor;
    ctx.fillText(wrapText(ctx, step.label, 260, 1)[0] ?? "", textX, y - 18);

    setFont(ctx, "bold", 36);
    ctx.fillStyle = theme.textColor;
    ctx.fillText(wrapText(ctx, step.title, CANVAS_WIDTH - textX - 40, 1)[0] ?? "", textX, y + 26);

    if (step.detail) {
      setFont(ctx, "normal", 27);
      ctx.fillStyle = theme.mutedTextColor;
      wrapText(ctx, step.detail, CANVAS_WIDTH - textX - 40, 2).forEach((line, li) => {
        ctx.fillText(line, textX, y + 66 + li * 34);
      });
    }
  });
}

function renderInfo(
  ctx: SKRSContext2D,
  theme: ThemeConfig,
  chart: SanitizedChartSpec,
  top: number
): void {
  const payload = chart.payload as InfoPayload;
  const bullets = payload.bullets.length ? payload.bullets : ["本文要点见解说词"];
  let y = top + 30;

  if (payload.headline) {
    setFont(ctx, "bold", 62);
    ctx.fillStyle = theme.primaryColor;
    wrapText(ctx, payload.headline, CANVAS_WIDTH - SIDE_PADDING * 2 - 20, 2).forEach((line) => {
      ctx.fillText(line, SIDE_PADDING, y);
      y += 80;
    });
    y += 24;
  }

  const rowHeight = Math.min(230, (CONTENT_BOTTOM - y - 40) / Math.max(bullets.length, 1));
  bullets.forEach((bullet) => {
    ctx.fillStyle = withAlpha(theme.primaryColor, 0.14);
    roundRectPath(ctx, SIDE_PADDING, y, CANVAS_WIDTH - SIDE_PADDING * 2, rowHeight - 26, 20);
    ctx.fill();

    ctx.fillStyle = theme.primaryColor;
    ctx.beginPath();
    ctx.arc(SIDE_PADDING + 44, y + (rowHeight - 26) / 2, 11, 0, Math.PI * 2);
    ctx.fill();

    setFont(ctx, "normal", 38);
    ctx.fillStyle = theme.textColor;
    ctx.textBaseline = "middle";
    const lines = wrapText(ctx, bullet, CANVAS_WIDTH - SIDE_PADDING * 2 - 110, 3);
    const blockHeight = lines.length * 50;
    const startY = y + (rowHeight - 26 - blockHeight) / 2 + 24;
    lines.forEach((line, li) => {
      ctx.fillText(line, SIDE_PADDING + 84, startY + li * 50);
    });
    ctx.textBaseline = "alphabetic";

    y += rowHeight;
  });

  if (payload.footer) {
    setFont(ctx, "normal", 26);
    ctx.fillStyle = theme.mutedTextColor;
    ctx.fillText(wrapText(ctx, payload.footer, CANVAS_WIDTH - SIDE_PADDING * 2, 1)[0] ?? "", SIDE_PADDING, CONTENT_BOTTOM - 10);
  }
}

type Painter = (
  ctx: SKRSContext2D,
  theme: ThemeConfig,
  chart: SanitizedChartSpec,
  top: number
) => void;

const PAINTERS: Record<ChartKind, Painter> = {
  bar: renderBar,
  line: renderLine,
  pie: renderPie,
  kpi: renderKpi,
  timeline: renderTimeline,
  info: renderInfo,
};

/** 画一张图。内部兜底：画挂了就把这张图降级成图卡，绝不让单张图阻断整条链路。 */
function paint(
  chart: SanitizedChartSpec,
  theme: ThemeConfig,
  sourceLabel: string
): { canvas: Canvas; downgraded: boolean; reason?: string } {
  const tryPaint = (spec: SanitizedChartSpec): Canvas => {
    const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const ctx = canvas.getContext("2d");
    ensureChartFont();
    drawBackground(ctx, theme);

    const unit = (spec.payload as { unit?: string }).unit ?? "";
    const top = drawHeader(ctx, theme, spec.title, unit);
    const painter = PAINTERS[spec.kind];
    painter(ctx, theme, spec, top);
    drawFootnote(
      ctx,
      theme,
      spec.verified && !spec.downgraded,
      sourceLabel,
      spec.payload && typeof spec.payload === "object" && "note" in spec.payload
        ? String((spec.payload as { note?: string }).note ?? "")
        : spec.downgradeReason
    );
    return canvas;
  };

  try {
    return { canvas: tryPaint(chart), downgraded: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const fallback: SanitizedChartSpec = {
      ...chart,
      kind: "info",
      verified: false,
      downgraded: true,
      downgradeReason: reason,
      payload: {
        headline: chart.title.slice(0, 20),
        bullets: ["这张图的数据无法绘制", "已改为要点图卡"],
        footer: "渲染降级",
      } as InfoPayload,
    };
    return { canvas: tryPaint(fallback), downgraded: true, reason };
  }
}

export type RenderedChart = {
  id: string;
  kind: ChartKind;
  title: string;
  /** 磁盘绝对路径，直接进 materials。 */
  imagePath: string;
  /** 相对 public 的 web 路径，供方案面板显示缩略图。 */
  webPath: string;
  /** 人话版数据摘要，例如「营收 3 项 · 最高 120 亿」。 */
  dataSummary: string;
  sourceRefs: string[];
  verified: boolean;
  downgraded: boolean;
  downgradeReason?: string;
};

function summarize(chart: SanitizedChartSpec): string {
  const payload = chart.payload as Record<string, unknown>;
  switch (chart.kind) {
    case "bar":
    case "pie": {
      const items = (payload.items as Array<{ label: string; value: number }>) ?? [];
      if (!items.length) return "";
      const top = items.reduce((a, b) => (b.value > a.value ? b : a), items[0]);
      return `${items.length} 项 · 最高 ${top.label} ${formatNumber(top.value)}`;
    }
    case "line": {
      const series = (payload.series as Array<{ name: string; points: Array<{ label: string; value: number }> }>) ?? [];
      if (!series.length) return "";
      return `${series.length} 条线 · ${series[0].points.length} 个时间点`;
    }
    case "kpi":
      return `${payload.value ?? ""}${payload.unit ?? ""}`;
    case "timeline": {
      const steps = (payload.steps as unknown[]) ?? [];
      return `${steps.length} 个节点`;
    }
    default: {
      const bullets = (payload.bullets as string[]) ?? [];
      return `${bullets.length} 个要点`;
    }
  }
}

/**
 * 批量渲染。逐张 try/catch，失败的那张降级为图卡后继续，不影响其它图与整条链路。
 */
export async function renderCharts(input: {
  charts: SanitizedChartSpec[];
  themeKey?: string;
  /** 绝对目录，如 public/uploads/gen-video-work/<token>/charts */
  outDir: string;
  /** outDir 对应的 web 前缀，如 /uploads/gen-video-work/<token>/charts */
  webBase: string;
  /** 来源脚注文案，如 example.com */
  sourceLabel: string;
}): Promise<{ charts: RenderedChart[]; notices: string[] }> {
  const theme = resolveTheme(input.themeKey);
  await mkdir(input.outDir, { recursive: true });

  const rendered: RenderedChart[] = [];
  const notices: string[] = [];

  for (const chart of input.charts) {
    const { canvas, downgraded, reason } = paint(chart, theme, input.sourceLabel);
    const fileName = `${chart.id}.png`;
    const imagePath = join(input.outDir, fileName);
    await writeFile(imagePath, canvas.toBuffer("image/png"));

    if (downgraded && reason) {
      notices.push(`「${chart.title}」绘制失败（${reason}），已改为要点图卡。`);
    }

    rendered.push({
      id: chart.id,
      // 降级时画面上画的是图卡，类型必须跟着改，否则方案面板会标着「柱状图」
      // 而观众看到的是一张要点卡。
      kind: downgraded ? "info" : chart.kind,
      title: chart.title,
      imagePath,
      webPath: `${input.webBase.replace(/\/$/, "")}/${fileName}`,
      // 数据摘要也要跟着降级后的形态走，否则会显示一条根本没画出来的数值。
      dataSummary: downgraded ? "要点图卡" : summarize(chart),
      sourceRefs: chart.dataRefs,
      verified: chart.verified,
      downgraded: chart.downgraded || downgraded,
      downgradeReason: chart.downgradeReason ?? reason,
    });
  }

  return { charts: rendered, notices };
}