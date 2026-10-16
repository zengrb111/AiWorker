import React from "react";
import type { ThemeConfig, VisualEffect } from "../theme";
import { AcidFlowLayer } from "./AcidFlowLayer";
import { CollageFrame } from "./CollageFrame";
import { GlitchLayer } from "./GlitchLayer";
import { SwissGridLayer } from "./SwissGridLayer";

export type ThemeEffectsProps = {
  theme: ThemeConfig;
  /** 拼贴风的贴纸文字；仅 collage 生效。 */
  stickerText?: string;
  /**
   * 用户在主题之外额外勾选的特效层。
   *
   * 与 `theme.effects` **取并集**：主题是基线（暖色主题本来就自带 collage），
   * 用户想加故障感不必被迫整套换成故障主题。
   */
  extraEffects?: VisualEffect[];
};

/**
 * 主题视觉层分发器。
 *
 * 主题的 `effects` 字段声明「我要什么质感」，这里负责把它变成真实图层。
 * 组件（VerticalStoryboard / ClipFilmstrip）只需要挂这一个组件，
 * 不需要知道每种风格怎么实现 —— 新增风格时只改 theme.ts 和这里，
 * 渲染模板不动。
 *
 * 顺序有讲究：质感层从轻到重叠。accent 层（如故障闪白）必须最后，
 * 否则会被后面的层盖住。
 */
export const ThemeEffects: React.FC<ThemeEffectsProps> = ({ theme, stickerText, extraEffects }) => {
  // 取并集并按「渲染顺序」归一，避免用户在勾选栏里换顺序能改变叠加次序。
  // 顺序固定为 acid-flow → swiss-grid → collage → glitch（由下方 JSX 的挂载次序保证）。
  const effects: VisualEffect[] = [];
  for (const e of [...(theme.effects ?? []), ...(extraEffects ?? [])]) {
    if (!effects.includes(e)) effects.push(e);
  }
  if (effects.length === 0) return null;

  const has = (e: VisualEffect) => effects.includes(e);

  return (
    <>
      {/* 1) 流体/金属质感（最底层，改变整体光感） */}
      {has("acid-flow") ? (
        <AcidFlowLayer
          primaryColor={theme.primaryColor}
          accentColor={theme.accentColor}
          intensity={0.85}
        />
      ) : null}

      {/* 2) 网格骨架（版式层，必须在质感之上才看得见） */}
      {has("swiss-grid") ? (
        <SwissGridLayer
          lineColor={theme.mutedTextColor}
          cellSize={108}
          opacity={0.55}
          crosses
        />
      ) : null}

      {/* 3) 撕纸边框与贴纸（实体物件，压在网格上） */}
      {has("collage") ? (
        <CollageFrame
          accentColor={theme.primaryColor}
          secondaryColor={theme.accentColor}
          textColor={theme.textColor}
          spring={theme.springConfig}
          stickerText={stickerText}
          tornEdge
        />
      ) : null}

      {/* 4) 故障信号（最上层，故障感要盖住一切才有「信号被干扰」的意思） */}
      {has("glitch") ? (
        <GlitchLayer
          primaryColor={theme.primaryColor}
          accentColor={theme.accentColor}
          intensity={1}
          scanlines
        />
      ) : null}
    </>
  );
};
