import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { hexToRgb } from "./color";

export type AcidFlowLayerProps = {
  /** 主色。 */
  primaryColor: string;
  /** 强调色。 */
  accentColor: string;
  /** 整体强度 0~1，缺省 1。 */
  intensity?: number;
};

/**
 * 酸性设计层：高饱和流体渐变 + 金属光泽。
 *
 * 「酸性风」（Acid Graphics）的辨识度来自**材质反光**：像液态金属或全息贴纸，
 * 颜色在流动且带高光。这跟普通渐变的关键差别是——
 * 渐变是静态的，酸性是有**方向性高光在移动**的。
 *
 * 实现要点：
 * - 用多层大尺寸 radial-gradient 叠加，每层以不同周期漂移，叠加后才像流体
 *   （单层径向渐变平移看起来就是「一个球在滚」，很廉价）。
 * - 高光用 `mixBlendMode: "overlay"` 而非提高亮度：overlay 保留底层细节，
 *   提亮会把画面洗白。
 * - 所有运动都是 frame 的确定性函数，不用 CSS animation（逐帧渲染不可复现）。
 */
export const AcidFlowLayer: React.FC<AcidFlowLayerProps> = ({
  primaryColor,
  accentColor,
  intensity = 1,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const t = frame / fps;
  const { r: pr, g: pg, b: pb } = hexToRgb(primaryColor);
  const { r: ar, g: ag, b: ab } = hexToRgb(accentColor);

  // 三个流体团的中心，各自以不同周期与半径漂移
  const blobs = [
    {
      x: 30 + Math.sin(t * 0.6) * 26,
      y: 34 + Math.cos(t * 0.45) * 22,
      size: 620,
      rgb: [pr, pg, pb],
      alpha: 0.5 * intensity,
      speed: 0.6,
    },
    {
      x: 70 + Math.cos(t * 0.5) * 24,
      y: 62 + Math.sin(t * 0.7) * 20,
      size: 540,
      rgb: [ar, ag, ab],
      alpha: 0.42 * intensity,
      speed: 0.5,
    },
    {
      x: 48 + Math.sin(t * 0.85 + 1.4) * 30,
      y: 50 + Math.cos(t * 0.62 + 0.8) * 26,
      size: 700,
      rgb: [(pr + ar) >> 1, (pg + ag) >> 1, (pb + ab) >> 1],
      alpha: 0.34 * intensity,
      speed: 0.85,
    },
  ];

  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen" }}>
      {blobs.map((blob, i) => {
        const [r, g, b] = blob.rgb;
        return (
          <AbsoluteFill
            key={i}
            style={{
              background: `radial-gradient(circle at ${blob.x}% ${blob.y}%, rgba(${r},${g},${b},${blob.alpha}) 0%, rgba(${r},${g},${b},0.12) 38%, transparent 62%)`,
              filter: "blur(46px)",
            }}
          />
        );
      })}

      {/* 金属高光：一道斜向亮带缓慢扫过，是「液态金属」的决定性细节 */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(${105 + Math.sin(t * 0.4) * 22}deg,
            transparent 32%,
            rgba(255,255,255,0.14) 46%,
            rgba(255,255,255,0.22) 50%,
            rgba(255,255,255,0.14) 54%,
            transparent 68%)`,
          mixBlendMode: "overlay",
        }}
      />

      {/* 细密扫描纹：全息贴纸的微观结构，极低不透明度，只加「质感」不加「图案」 */}
      <AbsoluteFill
        style={{
          backgroundImage:
            "repeating-linear-gradient(115deg, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 2px, transparent 2px, transparent 7px)",
          mixBlendMode: "overlay",
        }}
      />
    </AbsoluteFill>
  );
};
