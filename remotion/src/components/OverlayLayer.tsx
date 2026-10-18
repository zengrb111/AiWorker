import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { DATA_OVERLAY_KINDS, type OverlaySpec } from "../vertical/schema";
import type { OverlaySpan } from "../vertical/layout";
import { resolveTheme, type ThemeConfig } from "../theme";
import { SectionTitle } from "./SectionTitle";
import { StatCard } from "./StatCard";
import { StatReveal } from "./StatReveal";
import { TextCard } from "./TextCard";
import { HeroTitle } from "./HeroTitle";
import { CalloutBox, type CalloutType } from "./CalloutBox";
import { ComparisonCard } from "./ComparisonCard";
import { ProgressBar } from "./ProgressBar";
import { ProviderChip } from "./ProviderChip";
import { BarChart } from "./BarChart";
import { LineChart } from "./LineChart";
import { DonutChart } from "./DonutChart";
import { KpiGrid } from "./KpiGrid";
import { SpecTable } from "./SpecTable";
import { BulletList } from "./BulletList";

/**
 * 竖版文字图层分发器。
 *
 * 分镜里的 `overlays` 是「声明」，这里是「执行」：把 OverlaySpec 翻译成具体组件 + 竖版尺寸。
 *
 * 为什么要有这一层而不是让 AI 直接写 JSX：
 * 1. AI 只描述「这句话压一张 92% 的数据卡」，具体字号、配色、弹簧参数由主题和本层决定，
 *    保证观感统一、可复现；
 * 2. 横版组件原尺寸按 1920x1080 调过，竖版必须整体放大并换成深色浮层，
 *    否则白底卡片压在深色画面上会像后贴的贴纸。
 */
export type OverlayLayerProps = {
  overlays: OverlaySpan[];
  themeKey: string;
};

const POSITION_MAP: Record<string, "top" | "center" | "bottom"> = {
  top: "top",
  center: "center",
  bottom: "bottom",
};

function renderOverlay(overlay: OverlaySpec, theme: ThemeConfig): React.ReactNode {
  const accent = overlay.accentColor ?? theme.primaryColor;
  const position = POSITION_MAP[overlay.position ?? "center"] ?? "center";
  const text = overlay.text ?? "";
  const subtitle = overlay.subtitle ?? "";

  switch (overlay.kind) {
    case "section_title":
      return (
        <SectionTitle
          title={text}
          subtitle={subtitle || undefined}
          accentColor={accent}
          textColor={theme.textColor}
          position={position}
          spring={theme.springConfig}
          padding={72}
          fontSize={40}
          subtitleFontSize={24}
          uppercase={false}
        />
      );

    case "stat_reveal":
      return (
        <StatReveal
          stat={overlay.value ?? text}
          label={overlay.label ?? (subtitle || undefined)}
          accentColor={accent}
          textColor={theme.textColor}
          position={position}
          statFontSize={130}
          labelFontSize={30}
          spring={theme.springConfig}
        />
      );

    case "stat_card":
      return (
        <StatCard
          stat={overlay.value ?? text}
          subtitle={overlay.label ?? (subtitle || undefined)}
          accentColor={accent}
          color={theme.textColor}
          statFontSize={150}
          subtitleFontSize={38}
          floating
          spring={theme.springConfig}
        />
      );

    case "hero_title":
      return (
        <HeroTitle
          title={text}
          subtitle={subtitle || undefined}
          accentColor={accent}
          textColor={theme.textColor}
          subtitleColor={theme.accentColor}
          backgroundColor={theme.backgroundColor}
          fontSize={88}
          subtitleFontSize={30}
          spring={theme.springConfig}
        />
      );

    case "text_card":
      return (
        <TextCard
          text={text}
          color={theme.textColor}
          fontSize={62}
          floating
          spring={theme.springConfig}
        />
      );

    case "callout":
      return (
        <CalloutBox
          text={text}
          title={overlay.label || undefined}
          type={(overlay.tone as CalloutType) ?? "info"}
          borderColor={accent}
          fontSize={38}
          titleFontSize={44}
          floating
          spring={theme.springConfig}
        />
      );

    case "comparison":
      return (
        <ComparisonCard
          leftLabel={overlay.leftLabel ?? "之前"}
          rightLabel={overlay.rightLabel ?? "之后"}
          leftValue={overlay.leftValue ?? overlay.value ?? "-"}
          rightValue={overlay.rightValue ?? "-"}
          title={text || undefined}
          leftColor={accent}
          rightColor={theme.accentColor}
          textColor={theme.textColor}
          floating
          spring={theme.springConfig}
        />
      );

    case "progress":
      return (
        <ProgressBar
          progress={Math.max(0, Math.min(100, overlay.progress ?? 0))}
          label={text || overlay.label || undefined}
          color={accent}
          textColor={theme.textColor}
          labelFontSize={44}
          percentageFontSize={62}
          floating
          spring={theme.springConfig}
        />
      );

    case "provider_chip":
      return (
        <ProviderChip
          providers={overlay.providers?.length ? overlay.providers : [theme.label]}
          accentColor={accent}
          label={overlay.label || "generated with"}
          inset={64}
          bottomInset={430}
        />
      );

    default:
      // 未知类型静默跳过：渲染层不该因为 AI 冒出新枚举就整条失败，
      // 校验器已经拦过一次，这里只是最后一道保险。
      return null;
  }
}

/**
 * 数据型图层：柱/线/环/卡组/表格/要点卡片。
 *
 * 与规划型图层分开一个函数，因为它们的入参形状完全不同 ——
 * 规划型只带单值字段（value/label/progress），数据型带数组字段
 * （items/series/cards/rows/bullets）。合成一个函数会让每个 case 都写一堆
 * `?? undefined` 的防御，反而看不出每类图层到底要什么。
 *
 * 这些 kind **不由模型输出**，由服务端把文章分析产出的图表翻译后注入
 * （src/lib/video/chart-overlays.ts），所以数值天然过了溯源闸门。
 */
function renderDataOverlay(overlay: OverlaySpec, theme: ThemeConfig): React.ReactNode {
  const accent = overlay.accentColor ?? theme.primaryColor;
  const muted = theme.mutedTextColor;
  const shell = {
    title: overlay.text || overlay.label || "",
    unit: overlay.unit,
    note: overlay.note,
    accent,
    textColor: theme.textColor,
    mutedColor: muted,
    spring: theme.springConfig,
  };

  switch (overlay.kind) {
    case "bar_chart":
      return <BarChart {...shell} items={overlay.items ?? []} highlightIndex={overlay.highlightIndex} />;

    case "line_chart":
      return (
        <LineChart
          {...shell}
          series={overlay.series ?? []}
          colors={theme.chartColors}
          highlightIndex={overlay.highlightIndex}
        />
      );

    case "donut":
      return (
        <DonutChart
          {...shell}
          items={overlay.items ?? []}
          colors={theme.chartColors}
          highlightIndex={overlay.highlightIndex}
        />
      );

    case "kpi_grid":
      return <KpiGrid {...shell} subtitle={overlay.subtitle} cards={overlay.cards ?? []} />;

    case "spec_table":
      return (
        <SpecTable
          {...shell}
          subtitle={overlay.subtitle}
          columns={overlay.columns ?? []}
          rows={overlay.rows ?? []}
        />
      );

    case "bullet_list":
      return <BulletList {...shell} subtitle={overlay.subtitle} bullets={overlay.bullets ?? []} />;

    default:
      return null;
  }
}

/**
 * 把一组文字图层按帧区间渲染到画面之上。
 *
 * 每个图层包在 Sequence 里，因此图层时间轴与场景解耦 ——
 * 一张数据卡可以跨两个场景存在，也可以在场景中途进场。
 */
export const OverlayLayer: React.FC<OverlayLayerProps> = ({ overlays, themeKey }) => {
  const theme = resolveTheme(themeKey);
  if (!overlays.length) return null;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {overlays.map((span, i) => {
        const body = DATA_OVERLAY_KINDS.includes(span.overlay.kind)
          ? renderDataOverlay(span.overlay, theme)
          : renderOverlay(span.overlay, theme);
        if (body === null) return null;
        return (
          <Sequence
            key={span.overlay.id || `overlay-${i}`}
            from={span.from}
            durationInFrames={span.frames}
            name={`overlay-${span.overlay.kind}`}
          >
            {body}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};