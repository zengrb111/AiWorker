import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { FONT_DISPLAY } from "../fonts";

export type OutroCardProps = {
  text: string;
  subtitle?: string;
  color: string;
  background: string;
  accent: string;
  durationInFrames: number;
};

/**
 * 片尾卡。统一落版，缩放 + 上浮入场，全部由 frame 算出。
 */
export const OutroCard: React.FC<OutroCardProps> = ({
  text,
  subtitle,
  color,
  background,
  accent,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const span = Math.max(1, durationInFrames);

  // 两个关键帧都要夹在 [1, span-1] 内：直接用 Math.round(span * 0.35) 时，
  // 极短片尾（span<=2）会算出 0 或等于 span，区间出现重复值，
  // Remotion 会抛 "inputRange must be strictly monotonically increasing" 让整条渲染失败。
  const introTo = Math.max(1, Math.min(Math.round(span * 0.35), span - 1));
  const outroFrom = Math.max(1, Math.min(Math.round(span * 0.78), span - 1));
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

  const intro = interpolate(frame, [0, introTo], [0, 1], clamp);
  const outro = interpolate(frame, [outroFrom, span], [1, 0], clamp);
  const opacity = intro * outro;
  const scale = interpolate(intro, [0, 1], [0.88, 1]);
  const lift = interpolate(intro, [0, 1], [40, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: background,
        justifyContent: "center",
        alignItems: "center",
        padding: "0 110px",
        opacity,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 22,
          marginBottom: 34,
          opacity: 0.9,
        }}
      >
        <div style={{ width: 92, height: 3, backgroundColor: accent }} />
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 30, color: accent, letterSpacing: 8 }}>
          关注获取更多
        </div>
        <div style={{ width: 92, height: 3, backgroundColor: accent }} />
      </div>

      <div
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: 96,
          fontWeight: 800,
          lineHeight: 1.24,
          color,
          textAlign: "center",
          transform: `translateY(${lift}px) scale(${scale})`,
          textShadow: "0 6px 40px rgba(0,0,0,0.45)",
        }}
      >
        {text}
      </div>

      {subtitle ? (
        <div
          style={{
            marginTop: 40,
            fontFamily: FONT_DISPLAY,
            fontSize: 38,
            color,
            opacity: 0.7 * opacity,
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          {subtitle}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
