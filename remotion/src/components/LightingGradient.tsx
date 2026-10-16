import React from "react";
import { AbsoluteFill, interpolate, interpolateColors, useCurrentFrame } from "remotion";

export type LightingGradientProps = {
  /** 起始光色 #rrggbb；缺省不启用。 */
  from?: string;
  /** 结束光色 #rrggbb；缺省不启用。 */
  to?: string;
  durationInFrames: number;
  /** 叠加不透明度上限，默认 0.28——过重会盖掉画面。 */
  opacity?: number;
};

/**
 * 光影渐变：在图片上叠一层随场景推进缓慢漂移的色光。
 * 颜色由 frame 逐帧插值，混合模式 screen，只提亮不压暗。
 */
export const LightingGradient: React.FC<LightingGradientProps> = ({
  from,
  to,
  durationInFrames,
  opacity = 0.28,
}) => {
  const frame = useCurrentFrame();
  if (!from || !to) return null;

  const span = Math.max(1, durationInFrames);
  const t = interpolate(frame, [0, span], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const color = interpolateColors(t, [0, 1], [from, to]);
  const y = interpolate(t, [0, 1], [38, 62]);

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        mixBlendMode: "screen",
        background: `linear-gradient(180deg, ${color} 0%, transparent 45%, ${color} 100%)`,
        backgroundPosition: `50% ${y.toFixed(2)}%`,
        backgroundSize: "100% 160%",
        opacity,
      }}
    />
  );
};
