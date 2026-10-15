import {
  AbsoluteFill,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { FONT_SANS } from "../fonts";
import type { SpringConfig } from "../theme";

export type ChangeDirection = "up" | "down" | "neutral";

export type ComparisonCardProps = {
  leftLabel: string;
  rightLabel: string;
  leftValue: string;
  rightValue: string;
  leftColor?: string;
  rightColor?: string;
  title?: string;
  changeIndicator?: string;
  changeDirection?: ChangeDirection;
  cardBackgroundColor?: string;
  textColor?: string;
  titleFontSize?: number;
  labelFontSize?: number;
  valueFontSize?: number;
  floating?: boolean;
  spring?: SpringConfig;
};

/**
 * 对比卡：左/右两栏并置，中间竖线 + 涨跌徽章，四阶段依次入场。
 *
 * 迁移自 OpenMontage/remotion-composer/src/components/ComparisonCard.tsx。
 * 改动：① 字体本地化；② 新增 floating（竖版压在画面之上，深色卡 + 亮色文字）；
 * ③ 去掉硬编码的横版宽度基准；④ spring 可注入主题。
 */
export const ComparisonCard: React.FC<ComparisonCardProps> = ({
  leftLabel,
  rightLabel,
  leftValue,
  rightValue,
  leftColor = "#2563EB",
  rightColor = "#10B981",
  title,
  changeIndicator,
  changeDirection = "neutral",
  cardBackgroundColor = "rgba(15,18,24,0.74)",
  textColor = "#F8FAFC",
  titleFontSize = 48,
  labelFontSize = 30,
  valueFontSize = 88,
  floating = true,
  spring: springConfig = { damping: 14, stiffness: 90, mass: 1 },
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = spring({ frame, fps, config: { damping: 20 } });

  const leftOpacity = spring({ frame: frame - 6, fps, config: { damping: 18 } });
  const leftSlide = spring({ frame: frame - 6, fps, config: springConfig, from: -40, to: 0 });
  const leftScale = spring({
    frame: frame - 6,
    fps,
    config: { damping: 12, stiffness: 100 },
    from: 0.9,
    to: 1,
  });

  const dividerDraw = spring({
    frame: frame - 16,
    fps,
    config: { damping: 14, stiffness: 80 },
  });

  const rightOpacity = spring({ frame: frame - 24, fps, config: { damping: 18 } });
  const rightSlide = spring({ frame: frame - 24, fps, config: springConfig, from: 40, to: 0 });
  const rightScale = spring({
    frame: frame - 24,
    fps,
    config: { damping: 12, stiffness: 100 },
    from: 0.9,
    to: 1,
  });

  const indicatorOpacity = spring({ frame: frame - 32, fps, config: { damping: 15 } });
  const indicatorScale = spring({
    frame: frame - 32,
    fps,
    config: { damping: 10, stiffness: 130 },
    from: 0.6,
    to: 1,
  });

  const directionArrow = changeDirection === "up" ? "↑" : changeDirection === "down" ? "↓" : "↔";
  const directionColor =
    changeDirection === "up" ? "#10B981" : changeDirection === "down" ? "#EF4444" : "#9CA3AF";

  const side = (
    label: string,
    value: string,
    color: string,
    opacity: number,
    slide: number,
    scale: number,
  ) => (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        padding: "34px 18px",
        opacity,
        transform: `translateX(${slide}px) scale(${scale})`,
        gap: 12,
      }}
    >
      <div
        style={{
          width: 46,
          height: 4,
          backgroundColor: color,
          borderRadius: 2,
          marginBottom: 6,
        }}
      />
      <div
        style={{
          fontFamily: FONT_SANS,
          fontWeight: 600,
          fontSize: labelFontSize,
          color: textColor,
          opacity: 0.7,
          letterSpacing: "0.05em",
          textAlign: "center",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: FONT_SANS,
          fontWeight: 800,
          fontSize: valueFontSize,
          color,
          lineHeight: 1.1,
          textAlign: "center",
        }}
      >
        {value}
      </div>
    </div>
  );

  return (
    <AbsoluteFill
      style={{
        background: "transparent",
        justifyContent: "center",
        alignItems: "center",
        padding: 64,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: "86%",
          gap: 28,
        }}
      >
        {title ? (
          <div
            style={{
              fontFamily: FONT_SANS,
              fontWeight: 700,
              fontSize: titleFontSize,
              color: textColor,
              textAlign: "center",
              opacity: titleOpacity,
              letterSpacing: "-0.02em",
              textShadow: "0 2px 10px rgba(0,0,0,0.6)",
            }}
          >
            {title}
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "stretch",
            width: "100%",
            borderRadius: 22,
            backgroundColor: cardBackgroundColor,
            overflow: "hidden",
            boxShadow: "0 18px 48px rgba(0,0,0,0.42)",
            border: "1px solid rgba(255,255,255,0.10)",
            backdropFilter: floating ? "blur(10px)" : undefined,
            minHeight: 300,
          }}
        >
          {side(leftLabel, leftValue, leftColor, leftOpacity, leftSlide, leftScale)}

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              width: 84,
              position: "relative",
            }}
          >
            <div
              style={{
                width: 2,
                height: `${dividerDraw * 100}%`,
                backgroundColor: "rgba(255,255,255,0.22)",
                position: "absolute",
                top: `${((1 - dividerDraw) / 2) * 100}%`,
              }}
            />
            {changeIndicator ? (
              <div
                style={{
                  position: "relative",
                  zIndex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4,
                  opacity: indicatorOpacity,
                  transform: `scale(${indicatorScale})`,
                }}
              >
                <div
                  style={{
                    width: 50,
                    height: 50,
                    borderRadius: 25,
                    backgroundColor: "rgba(15,18,24,0.95)",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    border: "1px solid rgba(255,255,255,0.14)",
                  }}
                >
                  <span style={{ fontFamily: FONT_SANS, fontWeight: 700, fontSize: 26, color: directionColor }}>
                    {directionArrow}
                  </span>
                </div>
                <div
                  style={{
                    fontFamily: FONT_SANS,
                    fontWeight: 700,
                    fontSize: 20,
                    color: directionColor,
                    whiteSpace: "nowrap",
                  }}
                >
                  {changeIndicator}
                </div>
              </div>
            ) : null}
          </div>

          {side(rightLabel, rightValue, rightColor, rightOpacity, rightSlide, rightScale)}
        </div>
      </div>
    </AbsoluteFill>
  );
};