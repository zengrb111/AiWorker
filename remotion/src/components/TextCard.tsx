import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_SANS } from "../fonts";
import type { SpringConfig } from "../theme";

export type TextCardProps = {
  text: string;
  fontSize?: number;
  color?: string;
  backgroundColor?: string;
  /** 不铺满整屏时只渲染内容（用作视频上的浮层卡片）。 */
  floating?: boolean;
  /** 卡片内边距。 */
  padding?: number;
  spring?: SpringConfig;
};

/**
 * 纯文字卡：一段话居中显示，轻微缩放入场。
 *
 * 迁移自 OpenMontage/remotion-composer/src/components/TextCard.tsx。
 * 改动：① 字体本地化；② 新增 floating（竖版压在画面之上，不铺满背景）；
 * ③ spring 可注入主题。
 */
export const TextCard: React.FC<TextCardProps> = ({
  text,
  fontSize = 68,
  color = "#FFFFFF",
  backgroundColor = "#1F2937",
  floating = true,
  padding = 48,
  spring: springConfig = { damping: 15, stiffness: 100, mass: 1 },
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = spring({ frame, fps, config: { damping: 20 } });
  const scale = spring({
    frame,
    fps,
    config: springConfig,
    from: 0.95,
    to: 1,
  });

  const body = (
    <div
      style={{
        opacity,
        transform: `scale(${scale})`,
        fontSize,
        color,
        fontFamily: FONT_SANS,
        fontWeight: 700,
        textAlign: "center",
        maxWidth: "86%",
        lineHeight: 1.35,
      }}
    >
      {text}
    </div>
  );

  if (floating) {
    return (
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          padding: 64,
        }}
      >
        <div
          style={{
            padding,
            borderRadius: 26,
            background: "rgba(15,18,24,0.70)",
            border: "1px solid rgba(255,255,255,0.10)",
            boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
            backdropFilter: "blur(10px)",
          }}
        >
          {body}
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        background: backgroundColor,
      }}
    >
      {body}
    </AbsoluteFill>
  );
};