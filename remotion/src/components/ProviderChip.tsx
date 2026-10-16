import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_DISPLAY, FONT_SANS } from "../fonts";

export type ProviderChipPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type ProviderChipProps = {
  providers: string[];
  cycleSeconds?: number;
  position?: ProviderChipPosition;
  accentColor?: string;
  label?: string;
  /** 边距（px）。竖版默认 64。 */
  inset?: number;
  /** 底部位置的下边距，需避开字幕带（字幕 MarginV=340）。 */
  bottomInset?: number;
};

/**
 * 轮播标签：依次切换的一列胶囊（工具名 / 模型名 / 品牌）。
 *
 * 迁移自 OpenMontage/remotion-composer/src/components/ProviderChip.tsx。
 * 改动：① 字体本地化（原依赖 Space Grotesk）；② 位置边距可传 —— 横版写死的
 * 48/96 对 1080×1920 太小；③ 底部默认留出字幕安全区，否则会被烧录字幕压住。
 */
export const ProviderChip: React.FC<ProviderChipProps> = ({
  providers,
  cycleSeconds = 2.5,
  position = "bottom-right",
  accentColor = "#22D3EE",
  label = "generated with",
  inset = 64,
  bottomInset = 430,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 没有任何标签时直接不渲染，避免 providers.length === 0 时取模得到 NaN
  if (!providers.length) return null;

  const cycleFrames = Math.max(1, Math.round(cycleSeconds * fps));
  const idx = Math.floor(frame / cycleFrames) % providers.length;
  const current = providers[idx];
  const framesIntoCycle = frame % cycleFrames;

  const springIn = spring({
    frame: framesIntoCycle,
    fps,
    config: { damping: 14, stiffness: 200 },
    durationInFrames: Math.ceil(fps * 0.35),
  });

  const fadeOut =
    framesIntoCycle > cycleFrames - fps * 0.25
      ? interpolate(
          framesIntoCycle,
          [cycleFrames - fps * 0.25, cycleFrames],
          [1, 0],
          { extrapolateRight: "clamp" }
        )
      : 1;

  const alpha = Math.min(springIn, fadeOut);
  const translateY = interpolate(springIn, [0, 1], [12, 0]);

  const posStyle: React.CSSProperties = {
    [position.includes("top") ? "top" : "bottom"]: position.includes("top") ? inset : bottomInset,
    [position.includes("left") ? "left" : "right"]: inset,
  };

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          ...posStyle,
          display: "flex",
          flexDirection: "column",
          alignItems: position.includes("right") ? "flex-end" : "flex-start",
          gap: 10,
          opacity: alpha,
          transform: `translateY(${translateY}px)`,
        }}
      >
        <div
          style={{
            fontSize: 22,
            color: "rgba(255,255,255,0.62)",
            fontFamily: FONT_SANS,
            fontWeight: 500,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            textShadow: "0 2px 8px rgba(0,0,0,0.6)",
          }}
        >
          {label}
        </div>
        <div
          style={{
            padding: "14px 28px",
            background: "rgba(11, 15, 26, 0.82)",
            border: `2px solid ${accentColor}`,
            borderRadius: 999,
            color: accentColor,
            fontFamily: FONT_DISPLAY,
            fontWeight: 700,
            fontSize: 30,
            letterSpacing: 0.3,
            backdropFilter: "blur(8px)",
            boxShadow: `0 8px 32px ${accentColor}30`,
          }}
        >
          {current}
        </div>
      </div>
    </AbsoluteFill>
  );
};