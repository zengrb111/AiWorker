import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { ThemeConfig } from "../theme";
import { hexToRgb, isLightColor, rgba, shiftColor } from "./color";

export type AnimatedBackgroundProps = {
  theme: ThemeConfig;
  /** 整体不透明度；缺省 1。场景里有前景图时可降到 0.4 左右当底纹用。 */
  intensity?: number;
};

/**
 * 动态背景：缓慢漂移的渐变网格 + 悬浮光球 + 自适应网格线 + 顶部渐隐。
 *
 * 这是「设计感」最直接的来源 —— 画面不再是一张静止的图配一个滤镜，
 * 而是一直在极缓慢地流动，肉眼几乎察觉不到，但整体就不「死」了。
 *
 * 全部参数由主题驱动，所以换主题会连背景手感一起换：
 * - 亮底主题用浅网格线 + 弱光球，暗底主题反过来
 * - 光球颜色取自主题的 chartColors，而不是写死
 *
 * 迁移自 OpenMontage/remotion-composer/src/Explainer.tsx 的 AnimatedBackground。
 */
export const AnimatedBackground: React.FC<AnimatedBackgroundProps> = ({ theme, intensity = 1 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const bg = theme.backgroundColor;
  const light = isLightColor(bg);

  // 渐变角度缓慢摆动：周期 8 秒，幅度 30 度。慢到不抢戏，快到能察觉「活着」。
  const angle1 = 135 + Math.sin(frame / (fps * 8)) * 30;

  const { r: bgR, g: bgG, b: bgB } = hexToRgb(bg);
  const { r: priR, g: priG, b: priB } = hexToRgb(theme.primaryColor);
  const { r: accR, g: accG, b: accB } = hexToRgb(theme.accentColor);

  const gradient = `
    radial-gradient(ellipse at ${30 + Math.sin(frame / (fps * 10)) * 20}% ${
      40 + Math.cos(frame / (fps * 8)) * 20
    }%,
      rgba(${priR}, ${priG}, ${priB}, ${0.15 * intensity}) 0%, transparent 60%),
    radial-gradient(ellipse at ${70 + Math.cos(frame / (fps * 7)) * 20}% ${
      60 + Math.sin(frame / (fps * 9)) * 25
    }%,
      rgba(${accR}, ${accG}, ${accB}, ${0.1 * intensity}) 0%, transparent 55%),
    linear-gradient(${angle1}deg, ${bg} 0%, ${shiftColor(bg, light ? -0.05 : 0.05)} 40%, ${
      theme.surfaceColor
    } 70%, ${bg} 100%)
  `;

  // 光球：尺寸/速度各不相同，避免看出周期
  const orbColors = theme.chartColors.slice(0, 5);
  const orbOpacity = (light ? 0.06 : 0.08) * intensity;
  const orbs = [
    { x: 20, y: 30, size: 300, color: orbColors[0] || theme.primaryColor, speedX: 7, speedY: 11 },
    { x: 70, y: 60, size: 250, color: orbColors[1] || theme.accentColor, speedX: 9, speedY: 8 },
    { x: 40, y: 80, size: 200, color: orbColors[2] || theme.primaryColor, speedX: 13, speedY: 6 },
    { x: 80, y: 20, size: 350, color: orbColors[3] || theme.accentColor, speedX: 11, speedY: 14 },
    { x: 10, y: 70, size: 180, color: orbColors[4] || theme.primaryColor, speedX: 8, speedY: 10 },
  ];

  const gridColor = light ? "rgba(0,0,0,0.03)" : "rgba(255,255,255,0.02)";
  const fadeColor = light ? `rgba(${bgR},${bgG},${bgB},0.2)` : `rgba(${bgR},${bgG},${bgB},0.4)`;

  return (
    <AbsoluteFill style={{ background: gradient, overflow: "hidden" }}>
      {/* 悬浮光球 */}
      {orbs.map((orb, i) => {
        const ox = orb.x + Math.sin(frame / (fps * orb.speedX)) * 15;
        const oy = orb.y + Math.cos(frame / (fps * orb.speedY)) * 12;
        const { r, g, b } = hexToRgb(orb.color);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${ox}%`,
              top: `${oy}%`,
              width: orb.size,
              height: orb.size,
              borderRadius: "50%",
              background: `rgba(${r}, ${g}, ${b}, ${orbOpacity})`,
              filter: `blur(${orb.size * 0.4}px)`,
              transform: "translate(-50%, -50%)",
            }}
          />
        );
      })}

      {/* 网格线：缓慢呼吸，进一步强化「不是静止画面」 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `
            linear-gradient(${gridColor} 1px, transparent 1px),
            linear-gradient(90deg, ${gridColor} 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
          opacity: 0.5 + Math.sin(frame / (fps * 20)) * 0.2,
        }}
      />

      {/* 顶部渐隐，给画面制造纵深 */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "30%",
          background: `linear-gradient(to bottom, ${fadeColor}, transparent)`,
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * 场景背景图 + 可调暗色遮罩。
 *
 * 前景已经是一张图时，再叠一层「有设计感的动态背景」需要压暗，否则两层图会互相打架；
 * backgroundOverlay 就是这个压暗强度（0~1）。
 */
export const BackdropImage: React.FC<{
  src: string;
  /** 遮罩强度 0~1，越大越暗。 */
  overlay?: number;
  theme: ThemeConfig;
}> = ({ src, overlay = 0.45, theme }) => {
  const { r, g, b } = hexToRgb(theme.backgroundColor);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          backgroundImage: `url(${src})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: "blur(18px) saturate(1.1)",
          transform: "scale(1.08)",
        }}
      />
      {/* 暗角遮罩：把背景图压下去，保证前景文字可读 */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(to bottom, rgba(${r},${g},${b},${overlay}), rgba(${r},${g},${b},${
            overlay + 0.15
          }))`,
        }}
      />
    </AbsoluteFill>
  );
};