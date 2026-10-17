import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { FONT_SANS } from "../fonts";
import { SAFE_AREA_BOTTOM } from "../vertical/frames";
import { fadeProgress } from "./ChartShell";
import type { ChromeSpec } from "../vertical/schema";

export type StoryChromeProps = {
  chrome?: ChromeSpec;
  accent: string;
  textColor: string;
  mutedColor: string;
  /** 成片总帧数，用来算进度线走过的比例。 */
  durationInFrames: number;
  /** 字幕底边距：页脚必须在这条线以上，否则会跟烧录字幕叠在一起。 */
  captionMarginBottom: number;
};

/**
 * 常驻页面装饰：顶部彩条 + 页眉 + 页脚 + 进度线。
 *
 * ## 为什么它是 storyboard 的一等字段而不是 overlay
 *
 * overlay 的出点被校验器限制在「最后一个场景的出点」以内（否则文字会压到下一镜头），
 * 而常驻装饰必须从第 0 帧贯穿到最后一帧 —— 在 overlay 机制里根本表达不出来。
 *
 * ## 为什么「有一个统一外壳」比「每条素材都做好看」更值
 *
 * 这是它真正的作用：单张画面的信息密度已经由图表图层负责了，
 * 而**跨整条时间轴的稳定性**（同款位置、同款字号、同款色条）只能由一个全片常驻层给。
 * 客户端那版的效果好，一半功劳在这个从不缺席的框架上。
 *
 * 全字段可选；`chrome` 缺省或全空时不渲染任何 DOM，对既有分镜零影响。
 */
export const StoryChrome: React.FC<StoryChromeProps> = ({
  chrome,
  accent,
  textColor,
  mutedColor,
  durationInFrames,
  captionMarginBottom,
}) => {
  const frame = useCurrentFrame();

  const header = chrome?.headerText?.trim() ?? "";
  const headerSubtitle = chrome?.headerSubtitle?.trim() ?? "";
  const footer = chrome?.footerText?.trim() ?? "";
  if (!chrome || (!chrome.topBar && !chrome.progress && !header && !headerSubtitle && !footer)) return null;

  const ink = chrome.color ?? textColor;
  // 进度线按时间轴线性推进；用 interpolate 而不是 CSS transition，
  // 因为 Remotion 是逐帧渲染的，transition 在这里不产生任何效果。
  const ratio =
    durationInFrames > 0
      ? interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
          extrapolateRight: "clamp",
        })
      : 0;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {/* 顶部彩条：入场时从 0 横向展开 */}
      {chrome.topBar ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            height: 8,
            width: `${(0.25 + ratio * 0.75) * 100}%`,
            background: `linear-gradient(90deg, ${accent}, ${accent}00)`,
            boxShadow: `0 0 24px ${accent}66`,
          }}
        />
      ) : null}

      {/* 页眉 */}
      {header || headerSubtitle ? (
        <div
          style={{
            position: "absolute",
            left: 56,
            top: 58,
            maxWidth: 800,
            opacity: fadeProgress(frame, 0, 14),
          }}
        >
          {header ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontFamily: FONT_SANS,
                fontSize: 30,
                fontWeight: 700,
                color: ink,
                letterSpacing: "0.02em",
                textShadow: "0 2px 10px rgba(0,0,0,0.7)",
              }}
            >
              <div style={{ width: 4, height: 26, borderRadius: 2, background: accent, flexShrink: 0 }} />
              {header}
            </div>
          ) : null}
          {headerSubtitle ? (
            <div
              style={{
                marginTop: 8,
                marginLeft: 16,
                fontFamily: FONT_SANS,
                fontSize: 23,
                color: mutedColor,
                textShadow: "0 2px 10px rgba(0,0,0,0.7)",
              }}
            >
              {headerSubtitle}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 页脚：贴着字幕区上沿，不与烧录字幕抢位置 */}
      {footer ? (
        <div
          style={{
            position: "absolute",
            left: 56,
            right: 56,
            // 页脚底边停在「字幕区」之上：字幕以 captionMarginBottom 为基准从底部排布，
            // 页面装饰必须让位，否则两者会叠在一起。
            bottom: Math.max(SAFE_AREA_BOTTOM - captionMarginBottom, 150),
            textAlign: "right",
            fontFamily: FONT_SANS,
            fontSize: 23,
            color: mutedColor,
            textShadow: "0 2px 10px rgba(0,0,0,0.7)",
            opacity: fadeProgress(frame, 4, 16),
          }}
        >
          {footer}
        </div>
      ) : null}

      {/* 底部常驻进度线 */}
      {chrome.progress ? (
        <div
          style={{
            position: "absolute",
            left: 56,
            right: 56,
            bottom: 132,
            height: 4,
            borderRadius: 2,
            background: "#ffffff1f",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${ratio * 100}%`,
              height: "100%",
              background: `linear-gradient(90deg, ${accent}66, ${accent})`,
              boxShadow: `0 0 16px ${accent}80`,
            }}
          />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};