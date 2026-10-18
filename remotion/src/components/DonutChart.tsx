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

export type DonutChartProps = Omit<ChartShellProps, "children"> & {
  items: ChartDataPoint[];
  colors: string[];
  highlightIndex?: number;
};

/** 圆环直径。剩下的横向空间留给图例列表。 */
const DONUT_SIZE = 430;
const STROKE = 62;

/**
 * 环形图（占比构成，2~5 块）。
 *
 * 之前项目里的饼图是**先在 Node 里用 canvas 画成 PNG**再当图片素材用的 ——
 * 也就是说环是死的，旁白讲到第 2 块时画面不会跟着动。
 * 这里改成 Remotion 原生绘制：扇区按占比依次扫出，环心的数字跟着切换。
 *
 * 为什么用 SVG 弧段而不是 conic-gradient：
 * 逐帧确定性动画需要「第 n 帧环画到哪」，conic-gradient 做不到精确控制，
 * 而 path 的 strokeDashoffset 可以逐帧算出来。
 */
export const DonutChart: React.FC<DonutChartProps> = ({
  items,
  colors,
  highlightIndex,
  accent,
  textColor,
  mutedColor,
  ...shell
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const usable = items.filter((it) => it && typeof it.label === "string" && it.label.trim() && it.value > 0);
  if (!usable.length) return null;

  const total = usable.reduce((sum, it) => sum + it.value, 0);
  if (total <= 0) return null;

  const radius = (DONUT_SIZE - STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const hotIndex = highlightIndex ?? 0;

  const center = DONUT_SIZE / 2;
  const legendWidth = CHART_WIDTH - DONUT_SIZE - 40;
  const legendTop = Math.max(0, (CHART_PLOT_HEIGHT - usable.length * 104) / 2);

  return (
    <ChartShell accent={accent} textColor={textColor} mutedColor={mutedColor} {...shell}>
      <div style={{ position: "relative", width: CHART_WIDTH, height: CHART_PLOT_HEIGHT }}>
        <svg
          width={DONUT_SIZE}
          height={DONUT_SIZE}
          viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}
          style={{ display: "block" }}
        >
          {/* 底环 */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="#ffffff"
            strokeOpacity={0.07}
            strokeWidth={STROKE}
          />
          {/* 各扇区：dasharray 按占比分配，offset 随进度累加 */}
          {(() => {
            let consumed = 0;
            return usable.map((item, i) => {
              const ratio = item.value / total;
              const seg = circumference * ratio;
              const grow = enterProgress(frame, fps, 4 + i * 6);
              const dash = seg * grow;
              const offset = -circumference * consumed * grow;
              consumed += ratio;
              const isHot = i === hotIndex;
              return (
                <circle
                  key={`arc-${i}`}
                  cx={center}
                  cy={center}
                  r={radius}
                  fill="none"
                  stroke={colors[i % colors.length] ?? accent}
                  strokeWidth={isHot ? STROKE + 10 : STROKE}
                  strokeOpacity={isHot ? 1 : 0.72}
                  strokeDasharray={`${dash} ${circumference - dash}`}
                  strokeDashoffset={offset}
                  // 从 12 点方向起画，rotate(-90) 把 0 度转到正上方
                  transform={`rotate(-90 ${center} ${center})`}
                  strokeLinecap="butt"
                />
              );
            });
          })()}
        </svg>

        {/* 环心：显示高亮项的占比。数字跟着进度滚动，避免直接跳变。 */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: DONUT_SIZE,
            height: DONUT_SIZE,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            opacity: fadeProgress(frame, 10),
          }}
        >
          <div
            style={{
              fontFamily: FONT_SANS,
              fontSize: 92,
              fontWeight: 800,
              color: textColor,
              lineHeight: 1,
            }}
          >
            {Math.round((usable[hotIndex]?.value ?? 0) / total * 100)}
            <span style={{ fontSize: 44, color: accent, marginLeft: 4 }}>%</span>
          </div>
          <div
            style={{
              marginTop: 10,
              fontFamily: FONT_SANS,
              fontSize: 25,
              color: mutedColor,
              textAlign: "center",
              maxWidth: DONUT_SIZE - 90,
            }}
          >
            {usable[hotIndex]?.label}
          </div>
        </div>

        {/* 图例：色块 + 类目 + 数值 + 占比，右侧纵向排布 */}
        <div
          style={{
            position: "absolute",
            left: DONUT_SIZE + 40,
            top: legendTop,
            width: legendWidth,
          }}
        >
          {usable.map((item, i) => {
            const appear = fadeProgress(frame, 8 + i * 6);
            const isHot = i === hotIndex;
            return (
              <div
                key={`lg-${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  marginBottom: 26,
                  opacity: appear,
                }}
              >
                <div
                  style={{
                    width: 16,
                    height: 44,
                    borderRadius: 5,
                    background: colors[i % colors.length] ?? accent,
                    flexShrink: 0,
                    boxShadow: isHot ? `0 0 18px ${colors[i % colors.length] ?? accent}66` : "none",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: FONT_SANS,
                      fontSize: 28,
                      color: isHot ? textColor : mutedColor,
                      fontWeight: isHot ? 700 : 400,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {item.label}
                  </div>
                  <div
                    style={{
                      marginTop: 4,
                      fontFamily: FONT_SANS,
                      fontSize: 24,
                      color: isHot ? accent : mutedColor,
                    }}
                  >
                    {formatValue(item.value)} · {Math.round((item.value / total) * 100)}%
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ChartShell>
  );
};