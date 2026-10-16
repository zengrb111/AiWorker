import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { FONT_DISPLAY } from "../fonts";
import { heroScrim } from "./color";
import type { SpringConfig } from "../theme";

export type HeroTitleProps = {
  title: string;
  subtitle?: string;
  /** 前导强调字与下划线的颜色。 */
  accentColor?: string;
  /** 其余标题字的颜色。亮色主题传主题的 textColor。 */
  textColor?: string;
  subtitleColor?: string;
  /**
   * 铺在标题后的柔光底。
   * 不给则按背景色自动反向取色（见 components/color.ts 的 heroScrim）——
   * 亮色主题必须用浅色遮罩，否则深色遮罩会把主题的深色文字压到看不见。
   */
  scrimBackground?: string;
  /** 背景色，用于自动决定遮罩明暗。 */
  backgroundColor?: string;
  /** 主标题字号。竖版建议 88。 */
  fontSize?: number;
  subtitleFontSize?: number;
  /** 前几个字用强调色。 */
  accentCharCount?: number;
  /** 是否浮在画面之上（不铺底）。 */
  floating?: boolean;
  spring?: SpringConfig;
};

/**
 * 主标题卡：逐字弹入 + 副标题 + 展开的下划线。
 *
 * 迁移自 OpenMontage/remotion-composer/src/components/HeroTitle.tsx。
 * 改动：① 字体本地化（原本依赖 Google Fonts 的 Space Grotesk）；
 * ② 遮罩改为可自动取色（这是本地版踩过的对比度事故点）；
 * ③ 新增 floating，竖版压在画面之上用；④ spring 可注入主题。
 */
export const HeroTitle: React.FC<HeroTitleProps> = ({
  title,
  subtitle,
  accentColor = "#22D3EE",
  textColor = "#F8FAFC",
  subtitleColor = "#A78BFA",
  scrimBackground,
  backgroundColor = "#0F172A",
  fontSize = 88,
  subtitleFontSize = 30,
  accentCharCount = 8,
  floating = true,
  spring: springConfig = { damping: 12, stiffness: 150, mass: 1 },
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scrim = scrimBackground ?? heroScrim(backgroundColor);
  const titleChars = Array.from(title);

  const body = (
    <div style={{ textAlign: "center", maxWidth: "90%" }}>
      {/* 主标题：逐字错开弹入 */}
      <div
        style={{
          fontSize,
          fontWeight: 800,
          fontFamily: FONT_DISPLAY,
          lineHeight: 1.2,
          display: "flex",
          justifyContent: "center",
          flexWrap: "wrap",
          textShadow: "0 4px 18px rgba(0,0,0,0.6)",
        }}
      >
        {titleChars.map((char, i) => {
          const delay = i * 1.2;
          const charSpring = spring({ frame: frame - delay, fps, config: springConfig });
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                opacity: charSpring,
                transform: `translateY(${interpolate(charSpring, [0, 1], [30, 0])}px)`,
                color: i < accentCharCount ? accentColor : textColor,
                whiteSpace: char === " " ? "pre" : undefined,
                minWidth: char === " " ? "0.3em" : undefined,
              }}
            >
              {char}
            </span>
          );
        })}
      </div>

      {subtitle ? (
        <div
          style={{
            marginTop: 22,
            opacity: spring({
              frame: frame - titleChars.length * 1.2 - 5,
              fps,
              config: { damping: 20 },
            }),
            fontSize: subtitleFontSize,
            fontWeight: 400,
            color: subtitleColor,
            fontFamily: FONT_DISPLAY,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            textShadow: "0 2px 10px rgba(0,0,0,0.6)",
          }}
        >
          {subtitle}
        </div>
      ) : null}

      {/* 下划线：从中间向两侧展开 */}
      <div
        style={{
          margin: "26px auto 0",
          height: 4,
          backgroundColor: accentColor,
          borderRadius: 2,
          width: interpolate(
            spring({ frame: frame - 15, fps, config: { damping: 15, stiffness: 60 } }),
            [0, 1],
            [0, fontSize * 5]
          ),
        }}
      />
    </div>
  );

  if (floating) {
    return (
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          background: scrim,
          padding: 64,
        }}
      >
        {body}
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        background: scrim,
      }}
    >
      {body}
    </AbsoluteFill>
  );
};