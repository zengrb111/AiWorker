import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { FONT_DISPLAY } from "../fonts";
import type { SpringConfig } from "../theme";

export type SectionTitleProps = {
  title: string;
  subtitle?: string;
  accentColor?: string;
  /** 标题色。亮色主题需传主题的 textColor。 */
  textColor?: string;
  position?: "top" | "center" | "bottom";
  /** 内边距（px）。竖版建议 72，横版 60。 */
  padding?: number;
  /** 标题字号。竖版建议 40，横版 28。 */
  fontSize?: number;
  subtitleFontSize?: number;
  /** 离场淡出提前量（帧）。 */
  exitFrames?: number;
  /** 入场弹性；不给则用一组偏活泼的默认值。 */
  spring?: SpringConfig;
  /** 标题字间距。 */
  letterSpacing?: string;
  /** 是否大写（英文小标题常用）。中文标题关掉。 */
  uppercase?: boolean;
};

/**
 * 段落小标题：强调色横条 + 主标题 + 副标题，逐级错开入场。
 *
 * 迁移自 OpenMontage/remotion-composer/src/components/SectionTitle.tsx，
 * 改动：① 字体换成本地栈（不依赖 Google Fonts）；② position 从横版的
 * top-left/bottom-left 改为竖版的 top/center/bottom；③ 字号与内边距改为可传，
 * 横竖两版共用同一个组件；④ spring 参数可注入主题。
 */
export const SectionTitle: React.FC<SectionTitleProps> = ({
  title,
  subtitle,
  accentColor = "#22D3EE",
  textColor = "#F8FAFC",
  position = "top",
  padding = 72,
  fontSize = 40,
  subtitleFontSize = 24,
  exitFrames = 15,
  spring: springConfig = { damping: 15, stiffness: 80, mass: 1 },
  letterSpacing = "0.05em",
  uppercase = false,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const slideIn = spring({ frame, fps, config: springConfig });

  const exitStart = durationInFrames - exitFrames;
  const fadeOut = interpolate(frame, [exitStart, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const opacity = Math.min(slideIn, fadeOut);

  const positionStyles: React.CSSProperties =
    position === "center"
      ? { justifyContent: "center", alignItems: "center" }
      : position === "bottom"
      ? { justifyContent: "flex-end", alignItems: "flex-start", padding }
      : { justifyContent: "flex-start", alignItems: "flex-start", padding };

  return (
    <AbsoluteFill style={positionStyles}>
      <div
        style={{
          opacity,
          transform: `translateX(${interpolate(slideIn, [0, 1], [-40, 0])}px)`,
        }}
      >
        {/* 强调色横条：随入场横向展开 */}
        <div
          style={{
            width: interpolate(slideIn, [0, 1], [0, 60]),
            height: 5,
            backgroundColor: accentColor,
            marginBottom: 14,
            borderRadius: 3,
          }}
        />
        <div
          style={{
            fontSize,
            fontWeight: 700,
            color: textColor,
            fontFamily: FONT_DISPLAY,
            letterSpacing,
            textTransform: uppercase ? "uppercase" : "none",
            textShadow: "0 2px 10px rgba(0,0,0,0.65)",
            lineHeight: 1.25,
          }}
        >
          {title}
        </div>
        {subtitle ? (
          <div
            style={{
              fontSize: subtitleFontSize,
              fontWeight: 400,
              color: accentColor,
              fontFamily: FONT_DISPLAY,
              marginTop: 6,
              opacity: spring({ frame: frame - 8, fps, config: { damping: 20 } }),
              textShadow: "0 2px 8px rgba(0,0,0,0.65)",
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};