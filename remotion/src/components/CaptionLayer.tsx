import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { CaptionCue } from "../vertical/schema";
import { FONT_SANS } from "../fonts";

export type CaptionLayerProps = {
  captions: CaptionCue[];
  color: string;
  outlineColor: string;
  /** 字幕底边距（px）。与 ffmpeg burnSubtitles 的 MarginV=340 对齐，两种链路视觉一致。 */
  marginBottom?: number;
  fontSize?: number;
};

/**
 * 字幕层。
 *
 * 显示「当前时刻正在说的那一整句」，不是逐字打字机——短视频字幕的通行做法是整句呈现，
 * 观众才有时间读完。
 *
 * 与 ffmpeg `burnSubtitles` 的关系：出片链路里字幕统一由后期烧录（见 pipeline 的
 * burnSubtitles 步骤），因此本组件默认拿不到 captions，实际是空转的。
 * 保留它是为了 Studio 预览或将来改成纯 Remotion 出片时能直接复用。
 * 注意：**不要**两边同时给字幕，否则同一条话会被画两遍。
 * prompt 里已明确禁止模型输出 captions 字段。
 */
export const CaptionLayer: React.FC<CaptionLayerProps> = ({
  captions,
  color,
  outlineColor,
  marginBottom = 340,
  fontSize = 56,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (!captions.length) return null;

  const nowMs = (frame / fps) * 1000;
  const active = captions.find((c) => nowMs >= c.startMs && nowMs < c.endMs);
  if (!active) return null;

  const fade = interpolate(
    nowMs,
    [active.startMs, active.startMs + 200, active.endMs - 200, active.endMs],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          bottom: marginBottom,
          display: "flex",
          justifyContent: "center",
          opacity: fade,
        }}
      >
        <div
          style={{
            fontFamily: FONT_SANS,
            fontSize,
            fontWeight: 700,
            lineHeight: 1.34,
            color,
            textAlign: "center",
            textShadow: `0 0 10px ${outlineColor}, 3px 3px 0 ${outlineColor}, -3px 3px 0 ${outlineColor}, 3px -3px 0 ${outlineColor}, -3px -3px 0 ${outlineColor}`,
            padding: "10px 26px",
            borderRadius: 14,
            background: "rgba(0,0,0,0.34)",
          }}
        >
          {active.text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
