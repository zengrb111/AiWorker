import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { FONT_DISPLAY } from "../fonts";
import type { SpringConfig } from "../theme";

export type StatRevealProps = {
  stat: string;
  label?: string;
  accentColor?: string;
  /** 说明文字色。亮色主题传主题的 textColor。 */
  textColor?: string;
  /**
   * 摆放位置。top / center / bottom 是竖版契约的三个位置；
   * right 保留自横版（Explainer 里贴右侧角落用）。
   */
  position?: "top" | "center" | "bottom" | "right";
  /** 主数字字号。竖版建议 130，横版 96。 */
  statFontSize?: number;
  labelFontSize?: number;
  /** 是否用浮层卡片包裹（竖版压在画面之上用）。 */
  floating?: boolean;
  exitFrames?: number;
  spring?: SpringConfig;
};

/**
 * 数据揭晓：数字弹入 + 辉光扩散 + 标签淡入，角落/居中摆放。
 *
 * 迁移自 OpenMontage/remotion-composer/src/components/StatReveal.tsx。
 * 改动：① 字体本地化；② position 适配竖版；③ 新增 floating；
 * ④ spring 可注入主题（默认比 StatCard 更弹，配合揭晓的强调感）。
 */
export const StatReveal: React.FC<StatRevealProps> = ({
  stat,
  label,
  accentColor = "#A78BFA",
  textColor = "#F8FAFC",
  position = "bottom",
  statFontSize = 130,
  labelFontSize = 30,
  floating = true,
  exitFrames = 12,
  spring: springConfig = { damping: 10, stiffness: 100, mass: 0.8 },
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const scale = spring({ frame, fps, config: springConfig, from: 0, to: 1 });
  const glow = spring({ frame: frame - 5, fps, config: { damping: 20, stiffness: 60 } });

  const exitStart = durationInFrames - exitFrames;
  const fadeOut = interpolate(frame, [exitStart, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const opacity = Math.min(spring({ frame, fps, config: { damping: 20 } }), fadeOut);

  // top 用较大的上边距，避开状态栏与 section_title 的常驻位置
  const positionStyles: React.CSSProperties =
    position === "center"
      ? { justifyContent: "center", alignItems: "center" }
      : position === "right"
      ? { justifyContent: "center", alignItems: "flex-end", paddingRight: 80 }
      : position === "top"
      ? { justifyContent: "flex-start", alignItems: "center", paddingTop: 200 }
      : { justifyContent: "flex-end", alignItems: "flex-end", padding: 80 };

  // 只有贴右的旧横版用法才右对齐，其余（top/center/bottom）一律居中
  const body = (
    <div
      style={{
        opacity,
        transform: `scale(${scale})`,
        textAlign: position === "right" ? "right" : "center",
      }}
    >
      <div
        style={{
          fontSize: statFontSize,
          fontWeight: 800,
          color: accentColor,
          fontFamily: FONT_DISPLAY,
          lineHeight: 1,
          letterSpacing: "-0.02em",
          textShadow: `0 0 ${interpolate(glow, [0, 1], [0, 30])}px ${accentColor}66, 0 4px 12px rgba(0,0,0,0.5)`,
        }}
      >
        {stat}
      </div>
      {label ? (
        <div
          style={{
            fontSize: labelFontSize,
            fontWeight: 500,
            color: textColor,
            fontFamily: FONT_DISPLAY,
            marginTop: 10,
            opacity: spring({ frame: frame - 10, fps, config: { damping: 20 } }),
            textShadow: "0 2px 8px rgba(0,0,0,0.65)",
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );

  if (!floating) return <AbsoluteFill style={positionStyles}>{body}</AbsoluteFill>;

  return (
    <AbsoluteFill style={positionStyles}>
      <div
        style={{
          padding: "36px 48px",
          borderRadius: 24,
          background: "rgba(15,18,24,0.66)",
          border: `1px solid ${accentColor}3A`,
          boxShadow: "0 16px 44px rgba(0,0,0,0.42)",
          backdropFilter: "blur(10px)",
        }}
      >
        {body}
      </div>
    </AbsoluteFill>
  );
};