import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { hexToRgb } from "./color";

export type GlitchLayerProps = {
  /** 主色（青色系），用于 RGB 错位的其中一色。 */
  primaryColor: string;
  /** 强调色（红色系），错位的另一色。 */
  accentColor: string;
  /** 整体强度 0~1。缺省 1。 */
  intensity?: number;
  /** 是否显示扫描线。 */
  scanlines?: boolean;
};

/**
 * 故障艺术层：RGB 色彩错位 + 横向撕裂 + 扫描线。
 *
 * 这是「故障风」辨识度的全部来源 —— 换配色换不出这个效果，必须真有像素级位移。
 * 迁移思路来自 Glitch Art 的经典手法：把画面复制三份，只留 R/G/B 单通道，
 * 然后让它们在不同时刻横向错开。
 *
 * 实现要点（都是踩过的坑）：
 * - 错位量用 **帧取整**，不用插值。插值会让 Remotion 在相邻帧之间做亚像素混合，
 *   观感变成「模糊」而不是「错位」，故障感全无。
 * - 撕裂是**偶发**的：一直错位会让画面始终脏。用伪随机（帧号取模）决定哪些帧撕，
 *   撕多久，观感才像信号干扰而不是坏掉的显示器。
 * - 混合用 screen 而非 normal：三通道叠加才是加色，normal 会互相遮挡。
 */
export const GlitchLayer: React.FC<GlitchLayerProps> = ({
  primaryColor,
  accentColor,
  intensity = 1,
  scanlines = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 伪随机：帧号取模。确定性可复现（不用 Math.random，逐帧渲染下不可复现）。
  const seed = frame % 97;
  const isTearing = seed < 26 * intensity; // 约 27% 的帧在撕
  const tearAmount = isTearing ? ((seed * 37) % 100) / 100 : 0;
  // 撕裂块的高度与位置也随帧变，避免整幅一起移（那像滑动而非故障）
  const bandTop = ((seed * 53) % 70) / 100;
  const bandHeight = 0.04 + ((seed * 29) % 100) / 1000;

  // 横向错位：撕裂帧上幅度大，静止帧上几乎为 0
  const shiftX = isTearing ? (tearAmount - 0.5) * 26 : 0;
  const shiftY = isTearing ? (tearAmount - 0.5) * 5 : 0;

  // 色差：主色与强调色各偏一点，幅度小但持续存在（故障风的底色）
  const chromaX = interpolate(Math.sin(frame / (fps * 1.7)), [-1, 1], [-2.5, 2.5]);

  const { r: pr, g: pg, b: pb } = hexToRgb(primaryColor);
  const { r: ar, g: ag, b: ab } = hexToRgb(accentColor);

  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen" }}>
      {/* 主色通道错位 */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(90deg, rgba(${pr},${pg},${pb},0.5), rgba(${pr},${pg},${pb},0.12))`,
          transform: `translate(${chromaX + shiftX}px, ${shiftY}px)`,
          mixBlendMode: "screen",
          opacity: isTearing ? 0.85 : 0.4,
        }}
      />
      {/* 强调色通道反向错位 */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(270deg, rgba(${ar},${ag},${ab},0.45), rgba(${ar},${ag},${ab},0.1))`,
          transform: `translate(${-chromaX - shiftX * 0.6}px, ${-shiftY}px)`,
          mixBlendMode: "screen",
          opacity: isTearing ? 0.8 : 0.35,
        }}
      />

      {/* 撕裂亮带：一块水平条带整体横移，是「画面被撕开」的关键视觉 */}
      {isTearing ? (
        <AbsoluteFill
          style={{
            top: `${bandTop * 100}%`,
            height: `${bandHeight * 100}%`,
            background: `linear-gradient(90deg, rgba(255,255,255,0.14), rgba(${pr},${pg},${pb},0.3), rgba(255,255,255,0.1))`,
            transform: `translateX(${shiftX * 1.8}px)`,
            mixBlendMode: "screen",
          }}
        />
      ) : null}

      {/* 扫描线：CRT 质感，密度按 1080 高度算，太疏不像显示器 */}
      {scanlines ? (
        <AbsoluteFill
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, transparent 1px, transparent 3px)",
            opacity: 0.5,
          }}
        />
      ) : null}

      {/* 偶发的整幅闪白：模拟信号丢失，极短，不抢戏 */}
      {seed === 13 || seed === 61 ? (
        <AbsoluteFill style={{ background: "rgba(255,255,255,0.09)", mixBlendMode: "screen" }} />
      ) : null}
    </AbsoluteFill>
  );
};
