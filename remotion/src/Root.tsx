import React from "react";
import { Composition } from "remotion";
import type { ClipStoryboard, Storyboard } from "./vertical/schema";
import { VERTICAL_FPS, VERTICAL_HEIGHT, VERTICAL_WIDTH, secondsToFrames } from "./vertical/frames";
import { storyboardTotalFrames } from "./vertical/layout";
import { VerticalStoryboard } from "./vertical/VerticalStoryboard";
import { VerticalMontage } from "./vertical/VerticalMontage";
import { VerticalRemake } from "./vertical/VerticalRemake";

/**
 * 渲染入口的注册表。
 *
 * 只有三个 composition，全部固定 1080x1920@30fps 竖版。
 *
 * 时长不写死，由 calculateMetadata 从传入的分镜算出 —— 算的是**内容排版的总帧数**
 * （见 vertical/layout.ts），不是 props 里声明的 durationSeconds。
 * 早先按 durationSeconds 算是黑屏与「口播被掐断」的根源：AI 估的分镜长度与真实配音
 * 长度对不上，差值无人填充。现在成片长度纯由排版推导，与口播天然对齐。
 */

type StoryboardProps = { storyboard: Storyboard };
type ClipStoryboardProps = { storyboard: ClipStoryboard };

const calcStoryboardMetadata = ({ props }: { props: StoryboardProps }) => ({
  width: VERTICAL_WIDTH,
  height: VERTICAL_HEIGHT,
  fps: VERTICAL_FPS,
  durationInFrames: props.storyboard ? storyboardTotalFrames(props.storyboard) : secondsToFrames(20),
});

const calcClipStoryboardMetadata = ({ props }: { props: ClipStoryboardProps }) => ({
  width: VERTICAL_WIDTH,
  height: VERTICAL_HEIGHT,
  fps: VERTICAL_FPS,
  durationInFrames: props.storyboard ? storyboardTotalFrames(props.storyboard) : secondsToFrames(20),
});

/** 预览用分镜：同时演示时间轴、文字图层与动态背景。 */
const previewStoryboard: Storyboard = {
  version: 1,
  theme: "warm-default",
  width: 1080,
  height: 1920,
  fps: 30,
  durationSeconds: 11,
  beats: [
    { startMs: 0, endMs: 3600, text: "城市里总有一些不起眼的温暖" },
    { startMs: 3600, endMs: 7400, text: "它们藏在每一盏亮着的窗里" },
    { startMs: 7400, endMs: 11000, text: "也藏在你我今天的一次停留" },
  ],
  scenes: [
    {
      id: "s1",
      images: [],
      outSeconds: 3.6,
      animation: "ken-burns",
      particles: "fireflies",
      particleIntensity: 0.6,
      lightingFrom: "#3b2f2a",
      lightingTo: "#0f0d0b",
    },
    {
      id: "s2",
      images: [],
      outSeconds: 7.4,
      animation: "drift-up",
      particles: "none",
      vignette: true,
    },
    {
      id: "s3",
      images: [],
      outSeconds: 11,
      animation: "parallax",
      particles: "sparkles",
      vignette: true,
    },
  ],
  overlays: [
    {
      id: "o1",
      kind: "section_title",
      position: "top",
      inSeconds: 0.4,
      outSeconds: 3.4,
      text: "本段要点",
      subtitle: "城市温暖观察",
    },
    {
      id: "o2",
      kind: "stat_reveal",
      position: "bottom",
      outSeconds: 7.2,
      value: "92%",
      label: "受访者表示曾被陌生人的善意打动",
    },
  ],
  captions: [
    { text: "这是一条竖版成片预览", startMs: 200, endMs: 3200 },
    { text: "字幕与片尾都走固定模板", startMs: 3400, endMs: 7400 },
  ],
  outro: { text: "关注获取更多", subtitle: "竖版短视频批量出片", durationSeconds: 2.5 },
};

const previewClips: ClipStoryboard = {
  version: 1,
  theme: "cool-night",
  width: 1080,
  height: 1920,
  fps: 30,
  durationSeconds: 10,
  beats: [{ startMs: 0, endMs: 10000, text: "片段按分镜顺序拼接并转场" }],
  clips: [
    { id: "c1", src: "", outSeconds: 3, transition: "fade" },
    { id: "c2", src: "", outSeconds: 6, transition: "slide" },
    { id: "c3", src: "", outSeconds: 10, transition: "wipe" },
  ],
  captions: [{ text: "片段按分镜顺序拼接并转场", startMs: 200, endMs: 6400 }],
  outro: { text: "关注获取更多", durationSeconds: 2.5 },
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="VerticalStoryboard"
        component={VerticalStoryboard}
        width={VERTICAL_WIDTH}
        height={VERTICAL_HEIGHT}
        fps={VERTICAL_FPS}
        durationInFrames={secondsToFrames(20)}
        calculateMetadata={calcStoryboardMetadata}
        defaultProps={{ storyboard: previewStoryboard }}
      />
      <Composition
        id="VerticalMontage"
        component={VerticalMontage}
        width={VERTICAL_WIDTH}
        height={VERTICAL_HEIGHT}
        fps={VERTICAL_FPS}
        durationInFrames={secondsToFrames(20)}
        calculateMetadata={calcClipStoryboardMetadata}
        defaultProps={{ storyboard: previewClips }}
      />
      <Composition
        id="VerticalRemake"
        component={VerticalRemake}
        width={VERTICAL_WIDTH}
        height={VERTICAL_HEIGHT}
        fps={VERTICAL_FPS}
        durationInFrames={secondsToFrames(20)}
        calculateMetadata={calcClipStoryboardMetadata}
        defaultProps={{ storyboard: previewClips }}
      />
    </>
  );
};
