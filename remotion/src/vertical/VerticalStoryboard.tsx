import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import type { SceneSpec, Storyboard } from "./schema";
import { resolveTheme } from "../theme";
import { CAPTION_MARGIN_BOTTOM, SAFE_AREA_BOTTOM } from "./frames";
import { layoutStoryboard } from "./layout";
import { CaptionLayer } from "../components/CaptionLayer";
import { CrossfadeImages, SceneFrameLayer } from "../components/SceneFrameLayer";
import { LightingGradient } from "../components/LightingGradient";
import { OutroCard } from "../components/OutroCard";
import { ParticleField } from "../components/ParticleField";
import { Vignette } from "../components/Vignette";
import { AnimatedBackground, BackdropImage } from "../components/AnimatedBackground";
import { OverlayLayer } from "../components/OverlayLayer";
import { ThemeEffects } from "../components/ThemeEffects";

export type VerticalStoryboardProps = {
  storyboard: Storyboard;
};

/**
 * 单个场景。
 *
 * 图层自下而上的顺序不能乱：
 *   背景图（模糊放大）→ 动态背景（漂移渐变）→ 画面区（图片 + 光影）→ 粒子 → 暗角
 * 前景图片区与背景层各自留出下方安全区给字幕。
 */
const Scene: React.FC<{
  scene: SceneSpec;
  from: number;
  frames: number;
  index: number;
  themeKey: string;
}> = ({ scene, from, frames, index, themeKey }) => {
  const theme = resolveTheme(themeKey);

  return (
    // from 必须给：缺省是 0，缺了会让所有场景从第 0 帧叠在一起，
    // 表现为「最长的那个场景结束画面就空了，中间一段黑屏」。
    <Sequence from={from} durationInFrames={frames} name={`scene-${index}-${scene.id}`}>
      <AbsoluteFill style={{ backgroundColor: scene.backgroundColor ?? theme.backgroundColor }}>
        {/* 场景专属背景图：模糊 + 放大，避免和前景图片抢注意力 */}
        {scene.backgroundImage ? (
          <BackdropImage src={scene.backgroundImage} overlay={scene.backgroundOverlay ?? 0.45} theme={theme} />
        ) : null}

        {/* 动态背景：整条片子的底噪，让画面不再「死」 */}
        <AnimatedBackground theme={theme} intensity={scene.backgroundImage ? 0.5 : 1} />

        <SceneFrameLayer durationInFrames={frames} bottom={SAFE_AREA_BOTTOM}>
          <CrossfadeImages
            images={scene.images}
            motion={scene.animation}
            durationInFrames={frames}
            seed={index + 1}
          />
          <LightingGradient
            from={scene.lightingFrom}
            to={scene.lightingTo}
            durationInFrames={frames}
          />
        </SceneFrameLayer>

        <ParticleField
          type={scene.particles ?? "none"}
          color={scene.particleColor ?? theme.particleColor}
          intensity={scene.particleIntensity ?? 0.6}
          durationInFrames={frames}
          seed={index * 13 + 3}
        />
        <Vignette enabled={scene.vignette ?? theme.vignette} />
      </AbsoluteFill>
    </Sequence>
  );
};

/**
 * 竖版图片分镜成片（一键生成视频 / 后台内容出片）。
 *
 * 图层自下而上：动态背景 → 场景（背景图 + 图片区 + 光影 + 粒子 + 暗角）
 *              → 文字图层（数据卡 / 小标题 / 进度条…）→ 片尾卡 → 字幕。
 *
 * 时间轴完全由分镜的绝对出点决定（见 vertical/layout.ts），成片长度 = 最后一个
 * 画面元素的出点 + 片尾，因此与口播天然对齐，不会出现「口播被掐断」。
 */
export const VerticalStoryboard: React.FC<VerticalStoryboardProps> = ({ storyboard }) => {
  const theme = resolveTheme(storyboard.theme);
  // 时间轴只在这里算一次，场景与片尾共用（layout 同时也是 Root.tsx 算 composition 时长的依据）。
  const layout = layoutStoryboard(storyboard);

  return (
    <AbsoluteFill style={{ backgroundColor: theme.backgroundColor }}>
      {storyboard.scenes.map((scene, i) => (
        <Scene
          key={scene.id}
          scene={scene}
          from={layout.spans[i].from}
          frames={layout.spans[i].frames}
          index={i}
          themeKey={storyboard.theme}
        />
      ))}

      {/* 文字图层：压在画面之上，时间轴与场景解耦 */}
      <OverlayLayer overlays={layout.overlays} themeKey={storyboard.theme} />

      {/* 主题视觉层：故障/酸性/拼贴/网格等质感。空 effects 时不渲染任何东西。 */}
      <ThemeEffects theme={theme} stickerText={storyboard.outro?.text} />

      {storyboard.outro && layout.outroFrom !== null ? (
        <Sequence from={layout.outroFrom} durationInFrames={layout.outroFrames} name="outro">
          <OutroCard
            text={storyboard.outro.text}
            subtitle={storyboard.outro.subtitle}
            color={theme.outroColor}
            background={theme.outroBackground}
            accent={theme.primaryColor}
            durationInFrames={layout.outroFrames}
          />
        </Sequence>
      ) : null}

      <CaptionLayer
        captions={storyboard.captions ?? []}
        color={theme.captionColor}
        outlineColor={theme.captionOutlineColor}
        marginBottom={CAPTION_MARGIN_BOTTOM}
      />
    </AbsoluteFill>
  );
};
