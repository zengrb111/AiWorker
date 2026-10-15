import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { KenBurnsImage } from "./KenBurnsImage";

export type SceneFrameLayerProps = {
  /** 图片区离顶部的距离（px），下方留净空给字幕。 */
  top?: number;
  bottom?: number;
  children: React.ReactNode;
  /** 场景帧数，用于入场淡入与出场淡出。 */
  durationInFrames: number;
};

/**
 * 单个场景的画面层：图片区 + 交叉淡化 + 出入场淡入淡出。
 *
 * 关键：交叉淡化按图片数均分场景时长，运镜用同一份真实帧数，
 * 绝不使用 useVideoConfig().durationInFrames（那是整个 composition 的总帧数）。
 */
export const SceneFrameLayer: React.FC<SceneFrameLayerProps> = ({
  top = 0,
  bottom = 420,
  children,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const span = Math.max(1, durationInFrames);

  // 淡化帧数取 [1, span-1]：写成 Math.min(12, span-1) 时，span=1 会得到 [0,0]，
  // 同样触发 Remotion 的 inputRange 严格递增校验。
  const fade = Math.max(1, Math.min(12, span - 1));
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const fadeIn = interpolate(frame, [0, fade], [0, 1], clamp);
  const fadeOut = interpolate(frame, [span - fade, span], [1, 0], clamp);

  return (
    <AbsoluteFill
      style={{
        top,
        bottom,
        backgroundColor: "#000",
        opacity: fadeIn * fadeOut,
        overflow: "hidden",
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export type CrossfadeImagesProps = {
  images: string[];
  motion: Parameters<typeof KenBurnsImage>[0]["motion"];
  durationInFrames: number;
  seed?: number;
  /** 交叉淡化帧数。 */
  fadeFrames?: number;
};

/**
 * 同一场景内多张图片按顺序交叉淡化。
 * 单张图时不做任何额外处理，直接铺满。
 */
export const CrossfadeImages: React.FC<CrossfadeImagesProps> = ({
  images,
  motion,
  durationInFrames,
  seed = 0,
  fadeFrames = 12,
}) => {
  const frame = useCurrentFrame();
  const span = Math.max(1, durationInFrames);
  const count = images.length;

  if (count === 1) {
    return <KenBurnsImage src={images[0]} motion={motion} durationInFrames={span} seed={seed} />;
  }

  // 每张图占用的时长；fadeFrames 从总时长里扣掉，避免总长溢出。
  const slot = Math.max(fadeFrames + 1, Math.floor((span + fadeFrames) / count));

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {images.map((src, i) => {
        const start = i * slot - fadeFrames;
        const visibleFrom = Math.max(0, start);
        const visibleTo = Math.min(span, start + slot + fadeFrames);
        if (visibleFrom >= span) return null;

        const localFrame = frame - visibleFrom;
        const localSpan = visibleTo - visibleFrom;
        const isLast = i === count - 1;

        // 淡化帧数必须严格小于本地时长。
        // 早先用 4 点插值 [0, f, span-f, span] 求淡入淡出曲线，但当 span <= 2f 时
        // 中间两个值会相等，Remotion 直接抛
        // "inputRange must be strictly monotonically increasing" 让整条渲染失败。
        // 拆成两个 2 点插值再取 min，视觉等价且天然规避 —— 每个区间都严格递增。
        const localFade = Math.max(1, Math.min(fadeFrames, localSpan - 1));
        const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
        const fadeIn = interpolate(localFrame, [0, localFade], [0, 1], clamp);
        const alpha = isLast
          ? fadeIn
          : Math.min(
              fadeIn,
              interpolate(localFrame, [localSpan - localFade, localSpan], [1, 0], clamp),
            );

        if (alpha <= 0) return null;

        return (
          <AbsoluteFill key={src + i} style={{ opacity: alpha }}>
            <KenBurnsImage
              src={src}
              motion={motion}
              durationInFrames={Math.max(1, localSpan)}
              seed={seed + i}
            />
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};
