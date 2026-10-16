import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_SANS } from "../fonts";
import type { SpringConfig } from "../theme";

export type StatCardProps = {
  stat: string;
  subtitle?: string;
  statFontSize?: number;
  subtitleFontSize?: number;
  color?: string;
  accentColor?: string;
  backgroundColor?: string;
  /** 不铺满整屏时只渲染内容（用作视频上的浮层卡片）。 */
  floating?: boolean;
  spring?: SpringConfig;
};

/**
 * 数据大字卡：一个巨大的数字 + 一行说明。
 *
 * 迁移自 OpenMontage/remotion-composer/src/components/StatCard.tsx。
 * 改动：① 字体本地化；② 新增 floating —— 竖版短视频是在画面**之上**压一张卡，
 * 不是整屏替换，所以不能像横版那样铺满背景；③ spring 可注入主题。
 */
export const StatCard: React.FC<StatCardProps> = ({
  stat,
  subtitle,
  statFontSize = 160,
  subtitleFontSize = 40,
  color = "#FFFFFF",
  accentColor = "#F59E0B",
  backgroundColor = "#1F2937",
  floating = false,
  spring: springConfig = { damping: 12, stiffness: 120, mass: 1 },
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({
    frame,
    fps,
    config: springConfig,
    from: 0.8,
    to: 1,
  });

  const subtitleOpacity = spring({
    frame: frame - 8,
    fps,
    config: { damping: 20 },
  });

  const body = (
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          transform: `scale(${scale})`,
          fontSize: statFontSize,
          color: accentColor,
          fontFamily: FONT_SANS,
          fontWeight: 800,
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
        }}
      >
        {stat}
      </div>
      {subtitle ? (
        <div
          style={{
            opacity: subtitleOpacity,
            fontSize: subtitleFontSize,
            color,
            fontFamily: FONT_SANS,
            fontWeight: 400,
            marginTop: 18,
            lineHeight: 1.35,
          }}
        >
          {subtitle}
        </div>
      ) : null}
    </div>
  );

  if (floating) {
    // 浮层卡片：半透明底 + 细边 + 轻微投影，压在画面之上
    return (
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          padding: 60,
        }}
      >
        <div
          style={{
            padding: "44px 56px",
            borderRadius: 26,
            background: "rgba(15,18,24,0.72)",
            border: `1px solid ${accentColor}44`,
            boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
            backdropFilter: "blur(10px)",
          }}
        >
          {body}
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        background: backgroundColor,
      }}
    >
      {body}
    </AbsoluteFill>
  );
};