import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { Video } from "@remotion/media";
import { KenBurnsImage } from "./KenBurnsImage";

export type ClipLayerProps = {
  /**
   * 素材路径，相对 Remotion 的 public 目录（即 remotion/public/）。
   * 组件内部用 staticFile() 解析，调用方不要自己拼 URL。
   */
  src: string;
  /** 本片段在成片中占用的帧数。 */
  durationInFrames: number;
  /** 裁切起点（帧）。图片忽略。 */
  trimStartFrames?: number;
  /** 静止图片的运镜；视频片段忽略。 */
  motion?: Parameters<typeof KenBurnsImage>[0]["motion"];
  muted?: boolean;
};

const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv|avi)$/i;

export const isVideoSrc = (src: string): boolean => VIDEO_EXT.test(src);

/**
 * 单个素材片段。
 *
 * 视频用 `@remotion/media` 的 `<Video>`（Remotion v4 推荐，`OffthreadVideo` 属核心包但非首选）；
 * 图片走 KenBurnsImage 施加运镜，避免成片里出现死图。
 */
export const ClipLayer: React.FC<ClipLayerProps> = ({
  src,
  durationInFrames,
  trimStartFrames = 0,
  motion = "static",
  muted = true,
}) => {
  const span = Math.max(1, durationInFrames);

  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "#000" }}>
      {isVideoSrc(src) ? (
        <Video
          src={staticFile(src)}
          trimBefore={trimStartFrames}
          durationInFrames={span}
          muted={muted}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <KenBurnsImage src={src} motion={motion} durationInFrames={span} />
      )}
    </AbsoluteFill>
  );
};

export const isVideoMaterial = isVideoSrc;

export const ClipThumb: React.FC<{ src: string }> = ({ src }) =>
  isVideoSrc(src) ? (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", color: "#888" }}>
      视频
    </AbsoluteFill>
  ) : (
    <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  );
