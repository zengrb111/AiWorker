import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_SANS } from "../fonts";
import {
  CHART_PLOT_HEIGHT,
  CHART_WIDTH,
  ChartShell,
  enterProgress,
  fadeProgress,
  formatValue,
  type ChartShellProps,
} from "./ChartShell";
import type { ChartDataPoint } from "../vertical/schema";

export type BarChartProps = Omit<ChartShellProps, "children"> & {
  items: ChartDataPoint[];
  highlightIndex?: number;
};

/** 底部留给类目标签的高度（**在绘图区之外**，否则标签会压在柱子上）。 */
const LABEL_BAND = 62;
/** 顶部留给数值标签的高度。 */
const VALUE_BAND = 62;

export const BarChart: React.FC<BarChartProps> = ({
  items,
  highlightIndex,
  accent,
  textColor,
  mutedColor,
  ...shell
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const usable = items.filter((it) => it && typeof it.label === "string" && it.label.trim());
  if (!usable.length) return null;

  const values = usable.map((it) => (Number.isFinite(it.value) ? it.value : 0));
  // 柱状图**必须**从 0 起算（截断基线会夸大差异）；有负值时 0 线落在中间。
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  // 绘图区 = 顶部数值带 + 柱体区；标签带在它**下面**，两者不重叠。
  const plotHeight = CHART_PLOT_HEIGHT - VALUE_BAND - LABEL_BAND;
  const zeroTop = VALUE_BAND + (max / span) * plotHeight;

  const gap = usable.length >= 5 ? 16 : 26;
  const columnWidth = (CHART_WIDTH - gap * (usable.length - 1)) / usable.length;

  return (
    <ChartShell accent={accent} textColor={textColor} mutedColor={mutedColor} {...shell}>
      <div style={{ position: "relative", width: CHART_WIDTH, height: CHART_PLOT_HEIGHT }}>
        {/* 零基准线 */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: zeroTop,
            height: 2,
            background: `${accent}4d`,
          }}
        />

        <div
          style={{
            display: "flex",
            gap,
            // 高度只到柱体区底部，标签另开一条带，不叠在柱子上
            height: VALUE_BAND + plotHeight,
            alignItems: "stretch",
          }}
        >
          {usable.map((item, i) => {
            const grow = enterProgress(frame, fps, 6 + i * 5);
            const value = values[i];
            const barHeight = Math.max(4, ((value - min) / span) * plotHeight);
            const isHot = highlightIndex === i;
            // 正值从基准线往上长，负值从基准线往下长。
            const top = value >= 0 ? zeroTop - barHeight : zeroTop;

            return (
              <div key={`${item.label}-${i}`} style={{ width: columnWidth, position: "relative" }}>
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top,
                    height: barHeight * grow,
                    borderRadius: value >= 0 ? "12px 12px 0 0" : "0 0 12px 12px",
                    background: isHot
                      ? `linear-gradient(180deg, ${accent} 0%, ${accent}85 100%)`
                      : `linear-gradient(180deg, ${accent}66 0%, ${accent}26 100%)`,
                    boxShadow: isHot ? `0 0 36px ${accent}40` : "none",
                  }}
                />

                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: Math.max(0, top - 52),
                    textAlign: "center",
                    fontFamily: FONT_SANS,
                    fontSize: isHot ? 40 : 31,
                    fontWeight: isHot ? 800 : 600,
                    color: isHot ? accent : textColor,
                    opacity: fadeProgress(frame, 6 + i * 5),
                  }}
                >
                  {formatValue(item.value)}
                </div>
              </div>
            );
          })}
        </div>

        {/* 类目标签：单独一条带，在柱体区下方 */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: VALUE_BAND + plotHeight + 12,
            display: "flex",
            gap,
          }}
        >
          {usable.map((item, i) => {
            const isHot = highlightIndex === i;
            return (
              <div
                key={`lb-${item.label}-${i}`}
                style={{
                  width: columnWidth,
                  textAlign: "center",
                  fontFamily: FONT_SANS,
                  fontSize: 26,
                  lineHeight: 1.3,
                  color: isHot ? textColor : mutedColor,
                  fontWeight: isHot ? 700 : 400,
                  opacity: fadeProgress(frame, 10 + i * 5),
                }}
              >
                {item.label}
              </div>
            );
          })}
        </div>
      </div>
    </ChartShell>
  );
};