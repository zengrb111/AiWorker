import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import type { TransitionPresentation } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { none } from "@remotion/transitions/none";
import type { CameraMotion, ClipSpec, ClipStoryboard, TransitionKind } from "./schema";
import { resolveTheme } from "../theme";
import { CAPTION_MARGIN_BOTTOM, SAFE_AREA_BOTTOM, secondsToFrames } from "./frames";
import { layoutClipStoryboard } from "./layout";
import { CaptionLayer } from "../components/CaptionLayer";
import { ClipLayer } from "../components/ClipLayer";
import { OutroCard } from "../components/OutroCard";
import { Vignette } from "../components/Vignette";
import { AnimatedBackground } from "../components/AnimatedBackground";
import { OverlayLayer } from "../components/OverlayLayer";
import { ThemeEffects } from "../components/ThemeEffects";

/**
 * 转场 → 呈现组件。none 为硬切，不占额外时间。
 *
 * 四个呈现各自的 props 类型不同（FadeProps / SlideProps / WipeProps / NoneProps），
 * 这里抹平成统一类型只为让 PRESENTATION[k] 可按枚举取值，运行时行为不受影响。
 */
const PRESENTATION = {
  none: none(),
  fade: fade(),
  slide: slide({ direction: "from-right" }),
  wipe: wipe({ direction: "from-right" }),
} as unknown as Record<TransitionKind, TransitionPresentation<Record<string, unknown>>>;

export type ClipFilmstripProps = {
  storyboard: ClipStoryboard;
  /** 静图素材的默认运镜。 */
  defaultImageMotion?: CameraMotion;
  /** clip 未指定转场时的默认值。 */
  defaultTransition?: TransitionKind;
};

type PlannedClip = ClipSpec & { frames: number; transitionFrames: number };

/**
 * 片段拼接渲染器，VerticalMontage 与 VerticalRemake 共用。
 *
 * 时长契约（关键）：TransitionSeries 的总时长 = Σ序列时长 − Σ转场时长。
 * 因此每个片段的序列时长取「片段帧数 + 转场帧数」，转场吃掉重叠部分，
 * 成片总长就精确等于 Σ片段帧数，与 schema 里「durationSeconds 等于各片段之和」的校验一致，
 * AI 不需要（也无法）参与这种易错的补偿计算。
 */
export const ClipFilmstrip: React.FC<ClipFilmstripProps> = ({
  storyboard,
  defaultImageMotion = "ken-burns",
  defaultTransition = "fade",
}) => {
  const theme = resolveTheme(storyboard.theme);
  // 片尾起始帧与 Root.tsx 的 composition 时长取同一份排版，避免片尾被裁或尾部留黑。
  const layout = layoutClipStoryboard(storyboard);

  const planned: PlannedClip[] = storyboard.clips.map((clip, i) => {
    const kind = clip.transition ?? defaultTransition;
    // clip 0 忽略 transition（schema 明确它是「进入本片段」的转场，第一个片段无前驱）。
    // 其余片段的 transitionFrames 属于自己，用于它前面那道转场。
    const transitionFrames =
      i === 0 || kind === "none" ? 0 : Math.max(1, theme.transitionFrames);
    // 时长取自 layout 的绝对出点差值，与 Root.tsx 的 composition 时长同一份算法
    return {
      ...clip,
      frames: layout.spans[i]?.frames ?? secondsToFrames(clip.outSeconds),
      transitionFrames,
    };
  });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.backgroundColor }}>
      {/* 动态背景：让转场缝隙与静帧之间也有持续的底噪 */}
      <AnimatedBackground theme={theme} intensity={0.7} />

      <TransitionSeries>
        {planned.map((clip, i) => {
          const kind = clip.transition ?? defaultTransition;
          const presentation = PRESENTATION[kind] ?? PRESENTATION.none;
          // 序列填满「片段时长 + 它自己的进入转场时长」：转场期间两个序列各显示一部分，
          // 内容必须覆盖整个序列窗口，否则转场中段会露底。
          const sequenceFrames = clip.frames + clip.transitionFrames;

          return (
            <React.Fragment key={clip.id || i}>
              {/*
                转场放在本片段之前、用本片段的 transitionFrames。
                这是 TransitionSeries 总长能精确等于 Σ片段帧数的唯一摆法：
                  Σ序列 = Σ(f_i + t_i)，Σ转场 = Σ_{i≥1} t_i
                  ⇒ 总长 = Σf_i + t_0，而 t_0 恒为 0
                若把 Transition 放到片段之后（旧写法），末片段的 t_{n-1} 没有任何转场来消费，
                成片必然多出 0.5 秒，且 clip0→clip1 永远是硬切（t_0 恒 0）。
              */}
              {i > 0 && clip.transitionFrames > 0 ? (
                <TransitionSeries.Transition
                  presentation={presentation}
                  timing={linearTiming({ durationInFrames: clip.transitionFrames })}
                />
              ) : null}
              <TransitionSeries.Sequence durationInFrames={sequenceFrames} name={`clip-${i}`}>
                <AbsoluteFill style={{ bottom: SAFE_AREA_BOTTOM, overflow: "hidden" }}>
                  <ClipLayer
                    src={clip.src}
                    durationInFrames={sequenceFrames}
                    trimStartFrames={secondsToFrames(clip.trimStartSeconds ?? 0)}
                    motion={defaultImageMotion}
                    muted
                  />
                </AbsoluteFill>
              </TransitionSeries.Sequence>
            </React.Fragment>
          );
        })}
      </TransitionSeries>

      <Vignette enabled={theme.vignette} />

      {/* 文字图层（数据卡 / 小标题 / 进度条），压在画面之上 */}
      <OverlayLayer overlays={layout.overlays} themeKey={storyboard.theme} />

      {/* 主题视觉层：故障/酸性/拼贴/网格等质感 */}
      <ThemeEffects theme={theme} stickerText={storyboard.outro?.text} />

      {layout.outroFrom !== null ? (
        <Sequence from={layout.outroFrom} durationInFrames={layout.outroFrames} name="outro">
          <OutroCard
            text={storyboard.outro?.text ?? ""}
            subtitle={storyboard.outro?.subtitle}
            color={theme.outroColor}
            background={theme.outroBackground}
            accent={theme.primaryColor}
            durationInFrames={layout.outroFrames}
          />
        </Sequence>
      ) : null}

      <CaptionLayer
        captions={storyboard.captions ?? []}
        color={theme.captionColor}
        outlineColor={theme.captionOutlineColor}
        marginBottom={CAPTION_MARGIN_BOTTOM}
      />
    </AbsoluteFill>
  );
};
