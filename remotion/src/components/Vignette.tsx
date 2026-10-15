import React from "react";
import { AbsoluteFill } from "remotion";

export type VignetteProps = {
  enabled: boolean;
  /** 中心亮度，0~1，越小越暗。 */
  strength?: number;
};

/**
 * 暗角。纯 CSS radial-gradient，无动画——它本来就该是静态的。
 * 竖版画面上下留白多，暗角主要作用是把注意力压回中心，同时给字幕区降噪。
 */
export const Vignette: React.FC<VignetteProps> = ({ enabled, strength = 0.55 }) => {
  if (!enabled) return null;
  const inner = Math.round((1 - strength) * 100);

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        background: `radial-gradient(ellipse at 50% 42%, transparent ${inner}%, rgba(0,0,0,${(
          strength * 0.72
        ).toFixed(3)}) 78%, rgba(0,0,0,${strength.toFixed(3)}) 100%)`,
      }}
    />
  );
};
