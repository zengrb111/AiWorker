import React from "react";
import type { ClipStoryboard } from "./schema";
import { ClipFilmstrip } from "./ClipFilmstrip";

export type VerticalMontageProps = {
  storyboard: ClipStoryboard;
};

/**
 * 竖版剪辑成片（一键剪视频）。
 *
 * 与「一键复刻爆款」的区别在节奏策略而非渲染能力：
 * 剪辑面向用户自己的素材，默认 fade 转场 + ken-burns 静图运镜，节奏克制；
 * 复刻面向参考爆款，默认更短的滑动转场。见 VerticalRemake。
 */
export const VerticalMontage: React.FC<VerticalMontageProps> = ({ storyboard }) => (
  <ClipFilmstrip
    storyboard={storyboard}
    defaultImageMotion="ken-burns"
    defaultTransition="fade"
  />
);
