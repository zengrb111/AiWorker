import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import type { CameraMotion } from "../vertical/schema";

export type KenBurnsImageProps = {
  /**
   * 图片路径，相对 Remotion 的 public 目录（即 remotion/public/）。
   * 组件内部会用 staticFile() 解析，调用方不要自己拼 URL。
   */
  src: string;
  motion: CameraMotion;
  /** 本场景真实帧数；不能用 useVideoConfig().durationInFrames，那是整个 composition 的总帧数。 */
  durationInFrames: number;
  seed?: number;
};

/**
 * 带运镜的整屏图片。
 * 位移/缩放全部由 frame 直接算出，不使用 CSS animation/transition（逐帧渲染下不可复现）。
 */
export const KenBurnsImage: React.FC<KenBurnsImageProps> = ({ src, motion, durationInFrames, seed = 0 }) => {
  const frame = useCurrentFrame();
  const span = Math.max(1, durationInFrames);
  const t = interpolate(frame, [0, span], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const phase = ((seed % 5) + 5) % 5 * 0.04;

  // 运镜幅度按竖版 1080x1920 标定。
  // 早先位移只有 ±3.5%~4.5%（38~86px），平摊到一个 3 秒场景的 90 帧里
  // 每帧不到 1 像素，视觉上等于静止 —— 这是「动画效果不多」最直接的原因。
  // 现在把缩放拉到 20%+、位移拉到 ±8%，并让平移类运镜额外保持 1.16 的放大，
  // 保证移动过程中画面边缘不会露白。
  let scale = 1.06;
  let translateX = 0;
  let translateY = 0;

  switch (motion) {
    case "zoom-in":
      scale = interpolate(t, [0, 1], [1.03, 1.24]);
      break;
    case "zoom-out":
      scale = interpolate(t, [0, 1], [1.24, 1.03]);
      break;
    case "pan-left":
      scale = 1.18;
      translateX = interpolate(t, [0, 1], [8, -8]);
      break;
    case "pan-right":
      scale = 1.18;
      translateX = interpolate(t, [0, 1], [-8, 8]);
      break;
    case "drift-up":
      scale = 1.18;
      translateY = interpolate(t, [0, 1], [6, -6]);
      break;
    case "drift-down":
      scale = 1.18;
      translateY = interpolate(t, [0, 1], [-6, 6]);
      break;
    case "ken-burns":
      scale = interpolate(t, [0, 1], [1.04, 1.22]);
      translateX = interpolate(t, [0, 1], [-5, 5]);
      translateY = interpolate(t, [0, 1], [3.5, -3.5]);
      break;
    case "parallax":
      // 双频正弦：慢频走大弧、快频做细微抖动，模拟真实手持感
      scale = interpolate(t, [0, 1], [1.14, 1.22]);
      translateX = 5.5 * Math.sin(t * Math.PI * 1.5 + phase) + 1.8 * Math.sin(t * Math.PI * 3.4);
      translateY = 2.6 * Math.cos(t * Math.PI * 1.1 + phase);
      break;
    case "static":
    default:
      scale = 1.06;
      break;
  }

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img
        src={staticFile(src)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `translate(${translateX}%, ${translateY}%) scale(${scale})`,
          transformOrigin: "center center",
          willChange: "transform",
        }}
      />
    </AbsoluteFill>
  );
};
