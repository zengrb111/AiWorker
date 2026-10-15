import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { FONT_SANS } from "../fonts";
import type { SpringConfig } from "../theme";

export type CalloutType = "info" | "warning" | "tip" | "quote";

export type CalloutBoxProps = {
  text: string;
  type?: CalloutType;
  icon?: string;
  title?: string;
  borderColor?: string;
  backgroundColor?: string;
  textColor?: string;
  fontSize?: number;
  titleFontSize?: number;
  /** 浮在画面之上时不铺底色（竖版默认）。 */
  floating?: boolean;
  containerBackgroundColor?: string;
  spring?: SpringConfig;
};

/** 各类型的默认图标 / 描边 / 底色。 */
const TYPE_DEFAULTS: Record<CalloutType, { icon: string; border: string; bg: string; fg: string }> = {
  info: { icon: "ℹ️", border: "#2563EB", bg: "#EFF6FF", fg: "#1F2937" },
  warning: { icon: "⚠️", border: "#F59E0B", bg: "#FFFBEB", fg: "#1F2937" },
  tip: { icon: "💡", border: "#10B981", bg: "#ECFDF5", fg: "#1F2937" },
  quote: { icon: "“", border: "#9CA3AF", bg: "#F9FAFB", fg: "#374151" },
};

/**
 * 提示框：图标 + 标题 + 正文，带描边生长动画。
 *
 * 迁移自 OpenMontage/remotion-composer/src/components/CalloutBox.tsx。
 * 改动：① 字体本地化；② 新增 floating（竖版压在画面之上时用深色半透底，
 * 否则纯白底会显得像后贴的贴纸）；③ spring 可注入主题；④ 竖版字号整体上调。
 */
export const CalloutBox: React.FC<CalloutBoxProps> = ({
  text,
  type = "info",
  icon,
  title,
  borderColor,
  backgroundColor,
  textColor,
  fontSize = 38,
  titleFontSize = 44,
  floating = true,
  containerBackgroundColor = "#FFFFFF",
  spring: springConfig = { damping: 13, stiffness: 90, mass: 1 },
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const defaults = TYPE_DEFAULTS[type];
  const resolvedBorder = borderColor || defaults.border;
  const resolvedBg = backgroundColor || (floating ? "rgba(15,18,24,0.76)" : defaults.bg);
  const resolvedFg = textColor || (floating ? "#F8FAFC" : defaults.fg);
  const resolvedIcon = icon || defaults.icon;

  const slideX = spring({ frame, fps, config: springConfig, from: -80, to: 0 });
  const opacity = spring({ frame, fps, config: { damping: 18 } });
  const scale = spring({
    frame,
    fps,
    config: { damping: 11, stiffness: 100 },
    from: 0.96,
    to: 1,
  });
  const iconScale = spring({
    frame: frame - 5,
    fps,
    config: { damping: 10, stiffness: 120 },
    from: 0.5,
    to: 1,
  });
  const iconOpacity = spring({ frame: frame - 5, fps, config: { damping: 20 } });
  const textOpacity = spring({ frame: frame - 8, fps, config: { damping: 20 } });
  const borderDraw = spring({
    frame: frame - 3,
    fps,
    config: { damping: 14, stiffness: 80 },
  });

  const isQuote = type === "quote";

  return (
    <AbsoluteFill
      style={{
        background: floating ? "transparent" : containerBackgroundColor,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          opacity,
          transform: `translateX(${slideX}px) scale(${scale})`,
          width: "84%",
          position: "relative",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "flex-start",
            backgroundColor: resolvedBg,
            borderRadius: 18,
            padding: "34px 38px",
            overflow: "hidden",
            position: "relative",
            border: `1px solid ${resolvedBorder}55`,
            boxShadow: "0 18px 48px rgba(0,0,0,0.42)",
            backdropFilter: floating ? "blur(10px)" : undefined,
          }}
        >
          {/* 左侧描边自上而下生长 */}
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: 7,
              height: `${borderDraw * 100}%`,
              backgroundColor: resolvedBorder,
              borderRadius: "18px 0 0 18px",
            }}
          />

          <div
            style={{
              fontSize: isQuote ? 76 : 48,
              lineHeight: 1,
              marginRight: 24,
              flexShrink: 0,
              opacity: iconOpacity,
              transform: `scale(${iconScale})`,
              color: isQuote ? resolvedBorder : undefined,
              fontFamily: isQuote ? "Georgia, serif" : undefined,
              fontWeight: isQuote ? 700 : undefined,
              marginTop: isQuote ? -12 : 0,
            }}
          >
            {resolvedIcon}
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              flex: 1,
              opacity: textOpacity,
            }}
          >
            {title ? (
              <div
                style={{
                  fontFamily: FONT_SANS,
                  fontWeight: 700,
                  fontSize: titleFontSize,
                  color: isQuote ? resolvedFg : resolvedBorder,
                  lineHeight: 1.3,
                }}
              >
                {title}
              </div>
            ) : null}
            <div
              style={{
                fontFamily: isQuote ? "Georgia, serif" : FONT_SANS,
                fontStyle: isQuote ? "italic" : "normal",
                fontSize,
                color: resolvedFg,
                lineHeight: 1.55,
              }}
            >
              {text}
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};