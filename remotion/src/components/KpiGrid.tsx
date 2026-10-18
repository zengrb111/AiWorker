import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_SANS } from "../fonts";
import { enterProgress, fadeProgress } from "./ChartShell";
import type { KpiCard } from "../vertical/schema";

export type KpiGridProps = {
  title: string;
  subtitle?: string;
  cards: KpiCard[];
  accent: string;
  textColor: string;
  mutedColor: string;
};

/**
 * 数字卡组：2~4 张指标卡以网格排布。
 *
 * 与既有 `stat_card` 的区别，也是它存在的理由：
 *  · stat_card 只能一块，`value` 是**一整个字符串** —— 想让「120 亿」里
 *    「亿」用小一号、异色的字，就只能把整串塞进同一个 span，做不到；
 *  · 这里 value / unit / delta 分字段，且用 grid 一次呈现多个指标，
 *    是「一场发布会式的信息密度」，也是原方案里`display:grid` 那类布局的替代。
 *
 * 卡片数量决定列数：1 张全宽、2~3 张两列、4 张两列。
 */
export const KpiGrid: React.FC<KpiGridProps> = ({
  title,
  subtitle,
  cards,
  accent,
  textColor,
  mutedColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const usable = cards.filter((c) => c && typeof c.value === "string" && c.value.trim());
  if (!usable.length) return null;

  const columns = usable.length === 1 ? 1 : 2;
  const gap = 22;

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
          marginTop: 40,
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap,
        }}
      >
        {usable.map((card, i) => {
          const grow = enterProgress(frame, fps, 8 + i * 7, { damping: 18, stiffness: 110, mass: 1 });
          return (
            <div
              key={`kpi-${i}`}
              style={{
                // 单列时压扁一点，避免一张卡孤零零地撑满整屏
                padding: columns === 1 ? "48px 40px" : "36px 32px",
                borderRadius: 24,
                background: "rgba(13,16,22,0.80)",
                border: `1px solid ${accent}3d`,
                boxShadow: `0 18px 48px rgba(0,0,0,0.45), 0 0 44px ${accent}17`,
                backdropFilter: "blur(12px)",
                transform: `translateY(${(1 - grow) * 34}px)`,
                opacity: grow,
              }}
            >
              {card.label ? (
                <div
                  style={{
                    fontFamily: FONT_SANS,
                    fontSize: 26,
                    color: mutedColor,
                    marginBottom: 14,
                    lineHeight: 1.35,
                  }}
                >
                  {card.label}
                </div>
              ) : null}

              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{
                    fontFamily: FONT_SANS,
                    fontSize: columns === 1 ? 128 : 76,
                    fontWeight: 800,
                    color: accent,
                    lineHeight: 1.05,
                    letterSpacing: "-0.02em",
                  }}
                >
                  {card.value}
                </span>
                {card.unit ? (
                  <span
                    style={{
                      fontFamily: FONT_SANS,
                      fontSize: columns === 1 ? 40 : 30,
                      fontWeight: 600,
                      color: textColor,
                    }}
                  >
                    {card.unit}
                  </span>
                ) : null}
              </div>

              {card.delta ? (
                <div
                  style={{
                    marginTop: 16,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 14px",
                    borderRadius: 999,
                    background: `${accent}1f`,
                    border: `1px solid ${accent}40`,
                    fontFamily: FONT_SANS,
                    fontSize: 26,
                    color: accent,
                  }}
                >
                  {card.delta}
                  {card.deltaLabel ? (
                    <span style={{ color: mutedColor, fontSize: 22 }}>{card.deltaLabel}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};