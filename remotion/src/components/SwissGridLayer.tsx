import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { rgba } from "./color";

export type SwissGridLayerProps = {
  /** 网格线颜色（主题的 accentColor 或 mutedTextColor）。 */
  lineColor: string;
  /** 网格单元尺寸（px）。竖版建议 108。 */
  cellSize?: number;
  /** 整体不透明度 0~1，缺省 0.5。 */
  opacity?: number;
  /** 是否显示十字标记（瑞士风的标志性细节）。 */
  crosses?: boolean;
};

/**
 * 瑞士网格层：严格网格 + 十字标记。
 *
 * 瑞士国际主义风格的两大特征：**数学化的网格系统**与**极少的装饰**。
 * 所以这一层刻意做得非常克制 —— 线条细、透明度低、静止不动。
 * 一旦让它闪动或加粗，「严谨」就变成「花哨」，风格反而没了。
 *
 * 与 AnimatedBackground 里那张呼吸网格的区别：那张是氛围底噪（会缓慢明暗变化），
 * 这张是**版式骨架**，必须稳定。两者不要同时用。
 */
export const SwissGridLayer: React.FC<SwissGridLayerProps> = ({
  lineColor,
  cellSize = 108,
  opacity = 0.5,
  crosses = true,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  // 竖版下按高度均分列数，保证格子是正方形（横竖都用同一 cellSize 会变形）
  const cols = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);

  // 唯一的「动」：网格整体极缓慢地淡入淡出，像版式在呼吸。
  // 幅度压到 ±8%，肉眼几乎不可察，但画面不会彻底死掉。
  const breathe = 1 + Math.sin(frame / 90) * 0.08;

  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: opacity * breathe }}>
      {/* 横线 */}
      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, ${rgba(
            lineColor,
            0.16
          )} 0px, ${rgba(lineColor, 0.16)} 1px, transparent 1px, transparent ${cellSize}px)`,
        }}
      />
      {/* 竖线 */}
      <AbsoluteFill
        style={{
          backgroundImage: `repeating-linear-gradient(90deg, ${rgba(
            lineColor,
            0.16
          )} 0px, ${rgba(lineColor, 0.16)} 1px, transparent 1px, transparent ${cellSize}px)`,
        }}
      />

      {/* 十字标记：瑞士网格的标志细节，标在格子交点上 */}
      {crosses
        ? Array.from({ length: rows + 1 }, (_, r) =>
            Array.from({ length: cols + 1 }, (_, c) => (
              <div
                key={`${r}-${c}`}
                style={{
                  position: "absolute",
                  left: c * cellSize,
                  top: r * cellSize,
                  width: 11,
                  height: 11,
                  transform: "translate(-50%, -50%)",
                  // 用两条 1px 线拼十字，比字符「+」更细更准
                  backgroundImage: `linear-gradient(${rgba(lineColor, 0.5)}, ${rgba(
                    lineColor,
                    0.5
                  )}), linear-gradient(${rgba(lineColor, 0.5)}, ${rgba(lineColor, 0.5)})`,
                  backgroundSize: "11px 1px, 1px 11px",
                  backgroundPosition: "center",
                  backgroundRepeat: "no-repeat",
                }}
              />
            ))
          ).flat()
        : null}
    </AbsoluteFill>
  );
};
