import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_SANS } from "../fonts";
import {
  CHART_PLOT_HEIGHT,
  CHART_WIDTH,
  ChartShell,
  fadeProgress,
  formatValue,
  type ChartShellProps,
} from "./ChartShell";
import type { ChartSeries } from "../vertical/schema";

export type LineChartProps = Omit<ChartShellProps, "children"> & {
  series: ChartSeries[];
  colors: string[];
  highlightIndex?: number;
};

/** 左侧纵轴刻度占的宽度。 */
const AXIS_W = 100;
/** 右侧留白：不让最后一个数据点及其横轴标签贴到卡片边。 */
const PAD_R = 34;
/** 底部横轴标签占的高度。 */
const AXIS_H = 62;
/** 两系列以上时，图例单独占一行（放在绘图区上方，绝不压住曲线）。 */
const LEGEND_H = 44;
/** 期望的网格分段数（实际刻度数由「取整刻度」决定，可能是它 ±1）。 */
const GRID_LINES = 4;

/**
 * 把 [min, max] 扩成整数好读的刻度域。
 *
 * 直接用 min/max 会得到 2544 / 3021 / 3498 这种刻度，观众没法一眼读出
 * 「涨了一千」。按 1/2/5×10ⁿ 取整步长后刻度是 2500 / 3000 / 3500。
 */
function niceDomain(min: number, max: number): { lo: number; hi: number; step: number } {
  if (!(max > min)) return { lo: min - 1, hi: min + 1, step: 1 };
  const rawStep = (max - min) / GRID_LINES;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(rawStep) || 1)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step, step };
}

/**
 * 折线图：同一指标跨时间点，支持多条系列。
 *
 * 动效分两层：
 * ① 折线按路径长度「画」出来（strokeDashoffset 归零）；
 * ② 线下方的面积填充同步淡入。
 * 两层都由 frame 直接算出，不依赖 CSS animation —— Remotion 逐帧渲染才认。
 *
 * ## 关于纵轴起点
 *
 * 柱状图必须从 0 起（截断会夸大差异），但折线**表达的是变化趋势**，
 * 从 0 起会把「3299 → 4299」压成贴着顶部的一条平线，什么也看不出来。
 * 所以全为正数时基线取「最小值 − 区间×0.3」，并只做视觉留白、不暗示绝对比例。
 */
export const LineChart: React.FC<LineChartProps> = ({
  series,
  colors,
  highlightIndex,
  accent,
  textColor,
  mutedColor,
  ...shell
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const usable = series.filter((s) => s && Array.isArray(s.points) && s.points.length >= 1);
  if (!usable.length) return null;

  const showLegend = usable.length > 1;
  const svgH = CHART_PLOT_HEIGHT - (showLegend ? LEGEND_H : 0);
  const plotW = CHART_WIDTH - AXIS_W - PAD_R;
  const plotH = svgH - AXIS_H;

  const pointCount = Math.max(...usable.map((s) => s.points.length));
  const allValues = usable.flatMap((s) =>
    s.points.map((p) => (Number.isFinite(p.value) ? p.value : 0))
  );
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const range = rawMax - rawMin || Math.abs(rawMax) || 1;
  // 全为正数时不从 0 起，否则趋势全被压在顶部
  const lo = rawMin <= 0 ? rawMin : Math.max(0, rawMin - range * 0.3);
  const hi = rawMax <= 0 ? 0 : rawMax + range * 0.12;
  const { lo: yLo, hi: yHi, step } = niceDomain(Math.min(lo, rawMin), Math.max(hi, rawMax));
  const ySpan = yHi - yLo || 1;

  const x = (i: number) =>
    AXIS_W + (pointCount <= 1 ? plotW / 2 : (plotW * i) / (pointCount - 1));
  const y = (v: number) => plotH - ((v - yLo) / ySpan) * plotH;

  const ticks: number[] = [];
  for (let v = yLo; v <= yHi + step * 0.001; v += step) {
    ticks.push(Number(v.toFixed(6)));
  }

  const drawProgress = fadeProgress(frame, 4, 22);
  const tickProgress = fadeProgress(frame, 2, 16);

  return (
    <ChartShell accent={accent} textColor={textColor} mutedColor={mutedColor} {...shell}>
      <div style={{ position: "relative", width: CHART_WIDTH, height: CHART_PLOT_HEIGHT }}>
        {/* 图例：单独一行，放在曲线之上，避免压住数据 */}
        {showLegend ? (
          <div
            style={{
              height: LEGEND_H,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 26,
              opacity: fadeProgress(frame, 14),
            }}
          >
            {usable.map((s, i) => (
              <div
                key={`lg-${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  fontFamily: FONT_SANS,
                  fontSize: 23,
                  color: mutedColor,
                }}
              >
                <div
                  style={{
                    width: 22,
                    height: 5,
                    borderRadius: 3,
                    background: colors[i % colors.length] ?? accent,
                  }}
                />
                {s.name}
              </div>
            ))}
          </div>
        ) : null}

        <svg
          width={CHART_WIDTH}
          height={svgH}
          style={{ display: "block", overflow: "visible" }}
        >
          <defs>
            {usable.map((s, i) => (
              <linearGradient key={`g-${i}`} id={`line-fill-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor={colors[i % colors.length] ?? accent}
                  stopOpacity={0.30}
                />
                <stop
                  offset="100%"
                  stopColor={colors[i % colors.length] ?? accent}
                  stopOpacity={0.02}
                />
              </linearGradient>
            ))}
          </defs>

          {/* 横向网格 + 左侧刻度值 */}
          {ticks.map((value) => {
            const gy = y(value);
            return (
              <g key={`grid-${value}`} opacity={tickProgress}>
                <line
                  x1={AXIS_W}
                  y1={gy}
                  x2={CHART_WIDTH}
                  y2={gy}
                  stroke="#ffffff"
                  strokeOpacity={0.09}
                  strokeWidth={1.5}
                />
                <text
                  x={AXIS_W - 14}
                  y={gy + 8}
                  textAnchor="end"
                  fill={mutedColor}
                  fontSize={22}
                  fontFamily={FONT_SANS}
                >
                  {formatValue(value)}
                </text>
              </g>
            );
          })}

          {/* 各系列的面积填充 + 折线 */}
          {usable.map((s, si) => {
            const color = colors[si % colors.length] ?? accent;
            const pts = s.points.map((p, i) => ({ x: x(i), y: y(Number.isFinite(p.value) ? p.value : 0) }));
            const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
            const area = `${d} L${pts[pts.length - 1].x.toFixed(2)},${plotH} L${pts[0].x.toFixed(2)},${plotH} Z`;
            // 只让被高亮的系列（或唯一那条）走「画线」动画，避免多线齐飞看不清。
            const isHot = usable.length === 1 || highlightIndex === si;
            const len = 4000;

            return (
              <g key={`s-${si}`}>
                <path d={area} fill={`url(#line-fill-${si})`} opacity={drawProgress * 0.9} />
                <path
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={isHot ? 5 : 3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeOpacity={isHot ? 1 : 0.6}
                  strokeDasharray={len}
                  strokeDashoffset={isHot ? len * (1 - drawProgress) : 0}
                />
                {pts.map((p, pi) => {
                  const appear = fadeProgress(frame, 12 + si * 4 + pi * 5, 10);
                  if (appear <= 0.02) return null;
                  return (
                    <circle
                      key={`p-${pi}`}
                      cx={p.x}
                      cy={p.y}
                      r={isHot ? 7 : 5}
                      fill="#0d1016"
                      stroke={color}
                      strokeWidth={3}
                      opacity={appear}
                    />
                  );
                })}
              </g>
            );
          })}

          {/* 底部横轴标签 */}
          {usable[0].points.map((p, i) => (
            <text
              key={`x-${i}`}
              x={x(i)}
              y={plotH + 40}
              textAnchor="middle"
              fill={mutedColor}
              fontSize={22}
              fontFamily={FONT_SANS}
              opacity={tickProgress}
            >
              {p.label}
            </text>
          ))}
        </svg>
      </div>
    </ChartShell>
  );
};