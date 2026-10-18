import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_SANS } from "../fonts";
import type { SpringConfig } from "../theme";

/**
 * 数据型图层的共用外壳：玻璃卡 + 标题行 + 绘图区 + 注释。
 *
 * ## 为什么所有图表共用一个外壳
 *
 * 早先的 StatCard / TextCard 各自决定 padding、圆角、边框与入场动画，
 * 结果同一支片子里 6 个数据图层长得像 6 个产品。现在把这层「卡」的样式
 * 收到一处：换主题只需改这里，各图表只关心自己画什么。
 *
 * 尺寸为什么是死的常量：竖版 1080×1920 是固定画布，且下方 420px 要留给字幕
 * （SAFE_AREA_BOTTOM），所以绘图区高度必须提前定死，否则图表会压到字幕上。
 */

/** 卡片左右外边距（1080 − 56×2 = 968）。 */
export const CARD_MARGIN = 56;
/** 卡片内容宽度（968 − 48×2 = 872）。 */
export const CHART_WIDTH = 872;
/** 绘图区高度。标题行 + 注释 + 上下内边距之外的净高。 */
export const CHART_PLOT_HEIGHT = 620;
/** 卡片顶部位置。往下留出顶部彩条与页眉的呼吸空间。 */
export const CARD_TOP = 230;

export type ChartShellProps = {
  title: string;
  /** 右上角的小字单位，例如「万元」「%」。 */
  unit?: string;
  /** 卡片底部注释。 */
  note?: string;
  accent: string;
  textColor: string;
  mutedColor: string;
  spring?: SpringConfig;
  children?: React.ReactNode;
};

/** 数值格式化：去掉无意义的小数位，整数直接显示。 */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 10000) return `${(value / 10000).toFixed(abs >= 100000 ? 0 : 1)}万`;
  if (Number.isInteger(value)) return String(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

/**
 * 0→1 的入场进度。`delay` 让元素依次出现（错峰），而不是整张图一起弹出来。
 *
 * 刻意**不是 React Hook**：`.map()` 里逐项调用是本组件的常规写法，
 * 而 Hook 的调用次数必须恒定，否则渲染多张图表的片子会直接崩。
 * 它本来就是 frame 的纯函数，给个 `use` 前缀反而会诱使人写进 Hook 位置。
 */
export function enterProgress(
  frame: number,
  fps: number,
  delay = 0,
  config?: SpringConfig
): number {
  return spring({
    frame: frame - delay,
    fps,
    config: config ?? { damping: 200, mass: 0.6 },
    from: 0,
    to: 1,
  });
}

/** 线性淡入，进度同样由帧号推导。 */
export function fadeProgress(frame: number, delay = 0, durationInFrames = 12): number {
  return interpolate(frame - delay, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

export const ChartShell: React.FC<ChartShellProps> = ({
  title,
  unit,
  note,
  accent,
  textColor,
  mutedColor,
  spring: springConfig = { damping: 200, mass: 0.6 },
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 16, stiffness: 90, mass: 1 }, from: 0, to: 1 });
  const bodyIn = spring({ frame: frame - 4, fps, config: springConfig, from: 0, to: 1 });
  // 注释淡入进度在条件渲染之外算好：它是 frame 的纯函数，不涉及 Hook。
  const noteIn = fadeProgress(frame, 14);

  return (
    <div
      style={{
        position: "absolute",
        left: CARD_MARGIN,
        top: CARD_TOP,
        width: 968,
        boxSizing: "border-box",
        padding: "48px 48px 40px",
        borderRadius: 32,
        background: "rgba(13,16,22,0.80)",
        border: `1px solid ${accent}3d`,
        // accent 辉光：卡片外描一圈主色的柔光，是「有设计感」最省力的一处
        boxShadow: `0 26px 70px rgba(0,0,0,0.55), 0 0 64px ${accent}1f`,
        backdropFilter: "blur(14px)",
        transform: `translateY(${interpolate(enter, [0, 1], [40, 0])}px) scale(${interpolate(enter, [0, 1], [0.95, 1])})`,
        opacity: enter,
      }}
    >
      {/* 标题行：左标题 + 右单位 */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontFamily: FONT_SANS,
            fontSize: 46,
            fontWeight: 700,
            color: textColor,
            letterSpacing: "0.01em",
            lineHeight: 1.2,
          }}
        >
          {/* 主色竖条：标题前的强调色锚点 */}
          <div style={{ width: 6, height: 40, borderRadius: 3, background: accent, flexShrink: 0 }} />
          <span>{title}</span>
        </div>
        {unit ? (
          <div
            style={{
              fontFamily: FONT_SANS,
              fontSize: 26,
              fontWeight: 500,
              color: mutedColor,
              paddingBottom: 6,
              flexShrink: 0,
            }}
          >
            单位：{unit}
          </div>
        ) : null}
      </div>

      {/* 绘图区 */}
      <div style={{ marginTop: 36, height: CHART_PLOT_HEIGHT, overflow: "hidden", opacity: bodyIn }}>
        {children}
      </div>

      {note ? (
        <div
          style={{
            marginTop: 28,
            fontFamily: FONT_SANS,
            fontSize: 25,
            lineHeight: 1.5,
            color: mutedColor,
            opacity: noteIn,
          }}
        >
          {note}
        </div>
      ) : null}
    </div>
  );
};