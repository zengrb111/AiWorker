import React from "react";
import { AbsoluteFill, interpolate, random, useCurrentFrame } from "remotion";
import type { ParticleType } from "../vertical/schema";

export type ParticleFieldProps = {
  type: ParticleType;
  color: string;
  /** 0~1，决定数量与亮度。 */
  intensity: number;
  /** 场景总帧数，用于让飘落/漂浮在场景内循环闭合。 */
  durationInFrames: number;
  seed?: number;
};

type Particle = {
  x: number;
  y: number;
  size: number;
  /** 每帧位移（占画面高度的比例）。 */
  vy: number;
  drift: number;
  phase: number;
  alpha: number;
  spin: number;
};

const COUNT_BY_TYPE: Record<Exclude<ParticleType, "none" | "mist" | "light-rays">, number> = {
  fireflies: 26,
  petals: 24,
  sparkles: 34,
};

/**
 * 氛围粒子。
 *
 * 确定性是硬要求：位置与参数全部由 `random(seed + i)` 生成，与 frame 无关；
 * 每帧位移同样由 frame 直接算出，不用 CSS animation。同一 props 必得同一画面。
 */
export const ParticleField: React.FC<ParticleFieldProps> = ({
  type,
  color,
  intensity,
  durationInFrames,
  seed = 0,
}) => {
  const frame = useCurrentFrame();

  if (type === "none" || intensity <= 0) return null;

  const span = Math.max(1, durationInFrames);

  if (type === "mist") {
    // 薄雾：几条大半径径向渐变缓慢横移，纯 CSS 渐变，无动画 API。
    const bands = 4;
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        {Array.from({ length: bands }, (_, i) => {
          const drift = Math.sin((frame / span) * Math.PI * 2 + random(`${seed}-mist-${i}`) * Math.PI * 2) * 12;
          const top = 30 + random(`${seed}-mist-top-${i}`) * 55;
          const alpha = (0.1 + random(`${seed}-mist-a-${i}`) * 0.12) * intensity;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${-30 + drift}%`,
                width: "160%",
                top: `${top}%`,
                height: "34%",
                background: `radial-gradient(ellipse at center, ${color} 0%, transparent 70%)`,
                opacity: alpha,
                filter: "blur(28px)",
              }}
            />
          );
        })}
      </AbsoluteFill>
    );
  }

  if (type === "light-rays") {
    // 光柱：斜向柔光条，缓慢呼吸。
    const rays = 5;
    return (
      <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen" }}>
        {Array.from({ length: rays }, (_, i) => {
          const r = random(`${seed}-ray-${i}`);
          const breathe = 0.55 + 0.45 * Math.sin((frame / span) * Math.PI * 2 + r * Math.PI * 2);
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${r * 100 - 10}%`,
                top: "-25%",
                width: `${6 + r * 9}%`,
                height: "160%",
                background: `linear-gradient(180deg, transparent 0%, ${color} 45%, transparent 100%)`,
                opacity: (0.06 + r * 0.08) * intensity * breathe,
                filter: "blur(16px)",
                transform: `rotate(${18 + r * 12}deg)`,
              }}
            />
          );
        })}
      </AbsoluteFill>
    );
  }

  const baseCount = COUNT_BY_TYPE[type as Exclude<ParticleType, "none" | "mist" | "light-rays">];
  const count = Math.max(1, Math.round(baseCount * intensity));

  const particles: Particle[] = Array.from({ length: count }, (_, i) => {
    const r1 = random(`${seed}-${type}-x-${i}`);
    const r2 = random(`${seed}-${type}-y-${i}`);
    const r3 = random(`${seed}-${type}-s-${i}`);
    const r4 = random(`${seed}-${type}-v-${i}`);
    const r5 = random(`${seed}-${type}-d-${i}`);
    const r6 = random(`${seed}-${type}-p-${i}`);
    return {
      x: r1 * 100,
      y: r2 * 100,
      size: 1.6 + r3 * (type === "sparkles" ? 3.4 : 5.2),
      vy: 0.12 + r4 * 0.5,
      drift: 0.2 + r5 * 0.9,
      phase: r6 * Math.PI * 2,
      alpha: 0.28 + r6 * 0.5,
      spin: (r4 - 0.5) * 120,
    };
  });

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {particles.map((p, i) => {
        // 场景内循环：把位移对 span 取模，保证场景末尾与开头衔接。
        const travelled = ((p.vy * frame) % 110) - 0;
        const y = ((p.y + travelled + 110) % 110) - 5;
        const x = p.x + Math.sin((frame / span) * Math.PI * 2 + p.phase) * p.drift;
        const twinkle =
          type === "sparkles" || type === "fireflies"
            ? 0.35 + 0.65 * Math.abs(Math.sin((frame / span) * Math.PI * 3 + p.phase))
            : 1;
        const fadeEdge = interpolate(y, [-5, 8, 100, 105], [0, 1, 1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${x}%`,
              top: `${y}%`,
              width: `${p.size}px`,
              height: `${p.size}px`,
              borderRadius: type === "petals" ? "60% 12% 60% 12%" : "50%",
              background: color,
              boxShadow:
                type === "fireflies" || type === "sparkles"
                  ? `0 0 ${p.size * 4}px ${color}`
                  : "none",
              opacity: p.alpha * twinkle * fadeEdge * intensity,
              transform: `rotate(${p.spin}deg)`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
