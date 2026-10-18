import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_SANS } from "../fonts";
import { enterProgress, fadeProgress } from "./ChartShell";

export type BulletListProps = {
  title: string;
  subtitle?: string;
  bullets: string[];
  note?: string;
  accent: string;
  textColor: string;
  mutedColor: string;
};

/**
 * 要点卡片：2~6 条要点，以网格卡片排布。
 *
 * 与既有 `text_card` 的区别：text_card 是**一整块居中的大字**，
 * 承载 4 条要点时只能糊成一坨长文；这里是每条要点一张卡，
 * 带序号徽章，正文左对齐 —— 可扫读，且卡片可以错峰逐张弹出来。
 *
 * 列数：1 条全宽、2~4 条两列、5~6 条三列。
 */
export const BulletList: React.FC<BulletListProps> = ({
  title,
  subtitle,
  bullets,
  note,
  accent,
  textColor,
  mutedColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const usable = (bullets ?? []).filter((b) => typeof b === "string" && b.trim());
  if (!usable.length) return null;

  const columns = usable.length <= 2 ? 1 : usable.length >= 5 ? 3 : 2;
  const gap = 20;

  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: "0 56px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          fontFamily: FONT_SANS,
          fontSize: 46,
          fontWeight: 700,
          color: textColor,
          opacity: fadeProgress(frame, 0, 12),
        }}
      >
        <div style={{ width: 6, height: 40, borderRadius: 3, background: accent, flexShrink: 0 }} />
        {title}
      </div>
      {subtitle ? (
        <div
          style={{
            margin: "14px 0 0 22px",
            fontFamily: FONT_SANS,
            fontSize: 27,
            color: mutedColor,
            opacity: fadeProgress(frame, 3, 12),
          }}
        >
          {subtitle}
        </div>
      ) : null}

      <div
        style={{
          marginTop: 36,
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap,
        }}
      >
        {usable.map((text, i) => {
          const grow = enterProgress(frame, fps, 8 + i * 6, { damping: 18, stiffness: 120, mass: 1 });
          return (
            <div
              key={`bl-${i}`}
              style={{
                display: "flex",
                gap: 18,
                alignItems: "flex-start",
                padding: columns === 3 ? "26px 22px" : "32px 30px",
                borderRadius: 22,
                background: "rgba(13,16,22,0.80)",
                border: `1px solid ${accent}30`,
                boxShadow: "0 16px 42px rgba(0,0,0,0.42)",
                backdropFilter: "blur(12px)",
                transform: `translateY(${(1 - grow) * 30}px) scale(${0.97 + grow * 0.03})`,
                opacity: grow,
              }}
            >
              {/* 序号徽章 */}
              <div
                style={{
                  flexShrink: 0,
                  width: columns === 3 ? 38 : 46,
                  height: columns === 3 ? 38 : 46,
                  borderRadius: 999,
                  background: `${accent}26`,
                  border: `1px solid ${accent}52`,
                  color: accent,
                  fontFamily: FONT_SANS,
                  fontSize: columns === 3 ? 22 : 26,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {i + 1}
              </div>
              <div
                style={{
                  fontFamily: FONT_SANS,
                  fontSize: columns === 3 ? 25 : 30,
                  lineHeight: 1.5,
                  color: textColor,
                  textAlign: "left",
                }}
              >
                {text}
              </div>
            </div>
          );
        })}
      </div>

      {note ? (
        <div
          style={{
            marginTop: 28,
            fontFamily: FONT_SANS,
            fontSize: 25,
            lineHeight: 1.5,
            color: mutedColor,
            opacity: fadeProgress(frame, 20, 14),
          }}
        >
          {note}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};