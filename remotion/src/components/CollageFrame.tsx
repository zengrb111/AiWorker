import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_SANS } from "../fonts";
import type { SpringConfig } from "../theme";
import { hexToRgb, rgba } from "./color";

export type CollageFrameProps = {
  /** 主色（胶带与贴纸描边用）。 */
  accentColor: string;
  /** 第二色（胶带备用、撕纸渐变末端）。 */
  secondaryColor: string;
  /** 文字色，用于贴纸文字。 */
  textColor: string;
  /** 弹性参数，与主题一致。 */
  spring?: SpringConfig;
  /** 贴纸文字；不传则不显示贴纸。 */
  stickerText?: string;
  /** 是否显示撕纸边框。 */
  tornEdge?: boolean;
};

/**
 * 拼贴胶带层：撕纸边框 + 胶带贴纸 + 手写贴纸。
 *
 * 「拼贴风」的辨识度不在配色而在**材质**：纸边是被撕开的、胶带是歪着贴上去的。
 * 这些无法用换主题色表达，必须有独立图层。
 *
 * 实现要点：
 * - 撕纸边用 SVG 的 `fillRule="evenodd"` 做**真正的中间镂空**（外圈与内圈之间的
 *   区域才被填充）。早先想用两层 clip-path 挖空，那是行不通的 —— clip-path
 *   不支持 even-odd，只能整块裁掉。
 * - 锯齿角度是**确定性伪随机**（i 取模），不用 Math.random：逐帧渲染下
 *   random 会让每一帧的边缘都不一样，渲染结果不可复现。
 * - 胶带的旋转角固定，但四条边角度各不相同，看起来才像手工贴的。
 */
export const CollageFrame: React.FC<CollageFrameProps> = ({
  accentColor,
  secondaryColor,
  textColor,
  spring: springConfig = { damping: 12, stiffness: 170, mass: 1 },
  stickerText,
  tornEdge = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const stickerIn = spring({ frame, fps, config: springConfig });
  const stickerOpacity = spring({ frame, fps, config: { damping: 20 } });
  const tapeIn = spring({ frame: frame - 4, fps, config: { damping: 16 } });

  /** 一条胶带。angle 固定，四条边各不相同才有手工感。 */
  const tape = (style: React.CSSProperties, angle: number, color: string, width = 120) => (
    <div
      style={{
        position: "absolute",
        width,
        height: 34,
        background: rgba(color, 0.72),
        transform: `rotate(${angle}deg)`,
        boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
        // 胶带两端渐隐，中间实，模拟半透明胶带纸
        maskImage: "linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent)",
        WebkitMaskImage: "linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent)",
        opacity: tapeIn,
        ...style,
      }}
    />
  );

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {tornEdge ? <TornPaperBorder accentColor={accentColor} secondaryColor={secondaryColor} /> : null}

      {/* 四条胶带：分别贴四角 */}
      {tape({ top: "5%", left: "7%" }, -8, accentColor)}
      {tape({ top: "6%", right: "9%" }, 6, secondaryColor, 100)}
      {tape({ bottom: "8%", left: "9%" }, 5, secondaryColor, 110)}
      {tape({ bottom: "6%", right: "7%" }, -7, accentColor, 130)}

      {/* 手写贴纸：微倾斜 + 弹性入场，落地有「啪」一下贴上的手感 */}
      {stickerText ? (
        <AbsoluteFill
          style={{ right: 56, bottom: 230, alignItems: "flex-end", justifyContent: "flex-end" }}
        >
          <div
            style={{
              padding: "14px 26px",
              background: "#FFFEF7",
              color: textColor,
              fontFamily: FONT_SANS,
              fontWeight: 700,
              fontSize: 34,
              lineHeight: 1.2,
              transform: `rotate(-4deg) scale(${stickerIn})`,
              opacity: stickerOpacity,
              boxShadow: "0 6px 18px rgba(0,0,0,0.22)",
              border: `2px solid ${rgba(accentColor, 0.5)}`,
              // 贴纸边缘做成微不规则，像手撕的
              clipPath: "polygon(2% 0%, 98% 3%, 100% 40%, 97% 97%, 40% 100%, 3% 96%, 0% 55%)",
            }}
          >
            {stickerText}
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};

/**
 * 撕纸边框：只画边框，中间镂空。
 *
 * 用 SVG 的 evenodd 填充规则 —— 外圈路径与内圈路径之间的区域才被填充。
 * 这是唯一能「只留边框又保持不规则边缘」的做法（clip-path 做不到挖空）。
 */
export const TornPaperBorder: React.FC<{ accentColor: string; secondaryColor: string }> = ({
  accentColor,
  secondaryColor,
}) => {
  const { r: ar, g: ag, b: ab } = hexToRgb(accentColor);
  const { r: sr, g: sg, b: sb } = hexToRgb(secondaryColor);

  /** 确定性伪随机：i 取模造齿。绝不用 Math.random（逐帧渲染必须可复现）。 */
  const jitter = (i: number, salt: number) => ((i * salt) % 11) - 5;

  const outer = React.useMemo(() => {
    const n = 28;
    const pts: string[] = ["M 0 0"];
    for (let i = 0; i <= n; i++) pts.push(`L ${(i / n) * 1080} ${jitter(i, 37)}`);
    for (let i = 0; i <= n; i++) pts.push(`L ${1074 + jitter(i, 29)} ${(i / n) * 1920}`);
    for (let i = n; i >= 0; i--) pts.push(`L ${(i / n) * 1080} ${1914 + jitter(i, 41)}`);
    for (let i = n; i >= 0; i--) pts.push(`L ${jitter(i, 31)} ${(i / n) * 1920}`);
    pts.push("Z");
    return pts.join(" ");
  }, []);

  const inner = React.useMemo(() => {
    const n = 24;
    const pts: string[] = ["M 20 20"];
    for (let i = 0; i <= n; i++) pts.push(`L ${20 + (i / n) * 1040} ${20 + jitter(i, 43)}`);
    for (let i = 0; i <= n; i++) pts.push(`L ${1040 + jitter(i, 47)} ${20 + (i / n) * 1880}`);
    for (let i = n; i >= 0; i--) pts.push(`L ${20 + (i / n) * 1040} ${1880 + jitter(i, 53)}`);
    for (let i = n; i >= 0; i--) pts.push(`L ${20 + jitter(i, 59)} ${20 + (i / n) * 1880}`);
    pts.push("Z");
    return pts.join(" ");
  }, []);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <svg width="100%" height="100%" viewBox="0 0 1080 1920" preserveAspectRatio="none">
        <defs>
          <linearGradient id="tornPaper" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={`rgb(${ar},${ag},${ab})`} />
            <stop offset="100%" stopColor={`rgb(${sr},${sg},${sb})`} />
          </linearGradient>
        </defs>
        <path d={`${outer} ${inner}`} fill="url(#tornPaper)" fillRule="evenodd" />
      </svg>
    </AbsoluteFill>
  );
};
