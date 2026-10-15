import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { FONT_SANS } from "../fonts";
import type { SpringConfig } from "../theme";

export type ProgressAnimationStyle = "fill" | "pulse" | "step";

export type ProgressSegment = {
  value: number;
  color?: string;
  label?: string;
};

export type ProgressBarProps = {
  progress: number;
  label?: string;
  color?: string;
  backgroundColor?: string;
  trackColor?: string;
  showPercentage?: boolean;
  animationStyle?: ProgressAnimationStyle;
  segments?: ProgressSegment[];
  height?: number;
  borderRadius?: number;
  textColor?: string;
  labelFontSize?: number;
  percentageFontSize?: number;
  /** 轨道占屏宽比例，缺省 0.78（竖版）。横版传 0.7 即原值。 */
  trackWidthRatio?: number;
  /** 浮在画面之上时不铺底色（竖版默认）。 */
  floating?: boolean;
  spring?: SpringConfig;
};

/**
 * 进度条 / 占比条：填充、脉冲、阶梯三种动画，可分段。
 *
 * 迁移自 OpenMontage/remotion-composer/src/components/ProgressBar.tsx。
 * 改动：① 字体本地化；② 轨道宽度从写死的 1920 基准改为比例（原值 1344/1920 = 0.7，
 * 竖版用 0.78 更好看）；③ 新增 floating（竖版压在画面之上用深色半透轨）；
 * ④ spring 可注入主题。
 */
export const ProgressBar: React.FC<ProgressBarProps> = ({
  progress,
  label,
  color = "#2563EB",
  backgroundColor = "#FFFFFF",
  trackColor = "rgba(255,255,255,0.16)",
  showPercentage = true,
  animationStyle = "fill",
  segments,
  height = 34,
  borderRadius = 12,
  textColor = "#F8FAFC",
  labelFontSize = 44,
  percentageFontSize = 62,
  trackWidthRatio = 0.78,
  floating = true,
  spring: springConfig = { damping: 15, stiffness: 100, mass: 1 },
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const clampedProgress = Math.max(0, Math.min(100, progress));

  const containerOpacity = spring({ frame, fps, config: { damping: 20 } });
  const containerScale = spring({
    frame,
    fps,
    config: springConfig,
    from: 0.95,
    to: 1,
  });

  let fillFraction: number;

  if (animationStyle === "fill") {
    fillFraction = interpolate(
      frame,
      [10, Math.max(30, durationInFrames * 0.5)],
      [0, clampedProgress / 100],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
  } else if (animationStyle === "pulse") {
    const base = interpolate(
      frame,
      [10, Math.max(30, durationInFrames * 0.4)],
      [0, clampedProgress / 100],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    const pulsePhase = interpolate(
      frame,
      [durationInFrames * 0.4, durationInFrames * 0.9],
      [0, Math.PI * 4],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    fillFraction = base >= clampedProgress / 100 - 0.01 ? base * (1 + Math.sin(pulsePhase) * 0.015) : base;
  } else {
    const stepCount = segments?.length ?? 5;
    const rawProgress = interpolate(
      frame,
      [10, Math.max(30, durationInFrames * 0.6)],
      [0, clampedProgress / 100],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
    fillFraction = Math.floor(rawProgress * stepCount) / stepCount;
  }

  const percentOpacity = spring({ frame: frame - 15, fps, config: { damping: 20 } });
  const displayedPercent = Math.round(fillFraction * 100);
  const isSegmented = Boolean(segments?.length);

  return (
    <AbsoluteFill
      style={{
        background: floating ? "transparent" : backgroundColor,
        justifyContent: "center",
        alignItems: "center",
        padding: 64,
      }}
    >
      <div
        style={{
          opacity: containerOpacity,
          transform: `scale(${containerScale})`,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 26,
        }}
      >
        {label ? (
          <div
            style={{
              fontFamily: FONT_SANS,
              fontWeight: 700,
              fontSize: labelFontSize,
              color: textColor,
              textAlign: "center",
              textShadow: "0 2px 10px rgba(0,0,0,0.6)",
            }}
          >
            {label}
          </div>
        ) : null}

        <div style={{ width: `${trackWidthRatio * 100}%`, position: "relative" }}>
          <div
            style={{
              width: "100%",
              height,
              backgroundColor: trackColor,
              borderRadius,
              overflow: "hidden",
              position: "relative",
              display: "flex",
              boxShadow: floating ? "0 14px 36px rgba(0,0,0,0.36)" : undefined,
            }}
          >
            {isSegmented ? (
              segments!.map((seg, i) => (
                <div
                  key={i}
                  style={{
                    width: `${(seg.value / 100) * 100}%`,
                    height: "100%",
                    backgroundColor: seg.color || color,
                    transform: `scaleX(${spring({
                      frame: frame - (10 + i * 8),
                      fps,
                      config: { damping: 14, stiffness: 80 },
                    })})`,
                    transformOrigin: "left",
                    borderRight: i < segments!.length - 1 ? `2px solid rgba(0,0,0,0.45)` : "none",
                  }}
                />
              ))
            ) : (
              <div
                style={{
                  width: `${fillFraction * 100}%`,
                  height: "100%",
                  backgroundColor: color,
                  borderRadius,
                }}
              />
            )}
          </div>

          {isSegmented ? (
            <div style={{ display: "flex", width: "100%", marginTop: 10 }}>
              {segments!.map((seg, i) => (
                <div
                  key={i}
                  style={{
                    width: `${(seg.value / 100) * 100}%`,
                    fontFamily: FONT_SANS,
                    fontWeight: 500,
                    fontSize: 22,
                    color: textColor,
                    textAlign: "center",
                    opacity: spring({
                      frame: frame - (10 + i * 8) - 6,
                      fps,
                      config: { damping: 20 },
                    }),
                  }}
                >
                  {seg.label}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {showPercentage && !isSegmented ? (
          <div
            style={{
              fontFamily: FONT_SANS,
              fontWeight: 800,
              fontSize: percentageFontSize,
              color,
              opacity: percentOpacity,
              textShadow: "0 2px 12px rgba(0,0,0,0.5)",
            }}
          >
            {displayedPercent}%
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};