import React from "react";
import type { ClipStoryboard } from "./schema";
import { ClipFilmstrip } from "./ClipFilmstrip";

export type VerticalRemakeProps = {
  storyboard: ClipStoryboard;
};

/**
 * 竖版复刻成片（一键复刻爆款）。
 *
 * 爆款短视频的节奏比口播剪辑更快：默认用滑动转场切镜、静图用轻微推拉，
 * 让素材即使是被拉伸的静态图也能撑住前三秒的留存。
 * 片段顺序与时长完全由 DSH 依据参考视频的节奏给出，渲染侧只负责执行。
 */
export const VerticalRemake: React.FC<VerticalRemakeProps> = ({ storyboard }) => (
  <ClipFilmstrip
    storyboard={storyboard}
    defaultImageMotion="drift-up"
    defaultTransition="slide"
  />
);
