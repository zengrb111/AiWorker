/**
 * 分镜排版：把「绝对时间轴」换算成帧级时间轴。
 *
 * 存在的理由只有一个：**成片时长只能来自内容排版，绝不能来自模型声明的数字。**
 *
 * 早先有两处踩坑，都源于「时长有两个来源」：
 *   ① 成片时长按 `storyboard.durationSeconds` 算，而模型给的值与各场景之和有容差，
 *      差值无人填充 → 尾部黑屏；
 *   ② 后来改成 `max(排版长度, 声明时长)`，方向写反了 —— 声明值偏大时多出来的差值
 *      同样无人填充，黑屏依旧。
 *
 * 现在统一为：**排版末端就是成片末端**。模型算错只会让片子略短，
 * 由 pipeline 的 pad 兜底补齐（冻结末帧仅作应急），绝不会留黑。
 *
 * 组件与 Root.tsx 共用这里的同一份算法，避免「渲染按 A 算、时长按 B 算」再次漂移。
 */

import type { ClipStoryboard, OverlaySpec, Storyboard } from "./schema";
import { DEFAULT_OUTRO_SECONDS, secondsToFrames } from "./frames";

/** 单个场景/片段在时间轴上的占位。 */
export type Span = {
  /** 起始帧（含）。 */
  from: number;
  /** 持续帧数。 */
  frames: number;
};

/** 文字图层排版结果：帧区间 + 缺省继承的宿主场景。 */
export type OverlaySpan = {
  overlay: OverlaySpec;
  from: number;
  frames: number;
  /** 宿主场景序号，用于缺省定位。 */
  hostIndex: number;
};

export type StoryboardLayout = {
  spans: Span[];
  overlays: OverlaySpan[];
  /** 片尾起始帧；无片尾时为 null。 */
  outroFrom: number | null;
  outroFrames: number;
  /** 成片总帧数（= 排版末端）。 */
  totalFrames: number;
};

/**
 * 把一串「绝对出点秒」换算成首尾相接的帧区间。
 *
 * 第一个场景的起点固定为 0；其余场景起点等于前一个场景的出点。
 * 出点若与前一个相同或更早（校验器本应拦下），这里钳到 +1 帧，
 * 保证渲染不会因为「零长 Sequence」抛错 —— 渲染层的健壮性不能依赖上游一定正确。
 */
function spansFromOutPoints(outPoints: number[]): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const outSeconds of outPoints) {
    const outFrames = Math.max(cursor + 1, secondsToFrames(outSeconds));
    spans.push({ from: cursor, frames: outFrames - cursor });
    cursor = outFrames;
  }
  return spans;
}

/**
 * 排版文字图层。
 *
 * `inSeconds` / `outSeconds` 缺省时挂到「时间上最近的场景」上：
 * 这样 AI 只写文字不写时间也能用（多半场景），写了时间就精确生效。
 */
function layoutOverlays(overlays: OverlaySpec[] | undefined, spans: Span[]): OverlaySpan[] {
  if (!overlays?.length) return [];

  /** 时间上最接近 outSeconds 的场景序号。 */
  const nearestScene = (outSeconds: number): number => {
    const outFrames = secondsToFrames(outSeconds);
    let best = 0;
    let bestDelta = Number.POSITIVE_INFINITY;
    spans.forEach((span, i) => {
      const delta = Math.abs(span.from + span.frames - outFrames);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    });
    return best;
  };

  const out: OverlaySpan[] = [];
  overlays.forEach((overlay) => {
    const hasIn = overlay.inSeconds !== undefined;
    const hasOut = overlay.outSeconds !== undefined;

    // 宿主场景的选择：优先按出点找，只给了入点时按入点找，
    // 两个都没给时挂到第一个场景。
    // 早先无条件用 outSeconds ?? 0 挑宿主，导致「只给 inSeconds」的图层
    // 永远落到第 0 号场景上，随后出点被钳成 host.from + host.frames，
    // 于是 from 被 clamp 到 outFrames-1、frames 恒为 1 —— 图层只闪一帧。
    const anchorSeconds = hasOut
      ? (overlay.outSeconds as number)
      : hasIn
      ? (overlay.inSeconds as number)
      : 0;
    const hostIndex = nearestScene(anchorSeconds);
    const host = spans[hostIndex];
    if (!host) return;

    const hostEnd = host.from + host.frames;
    const from = hasIn ? secondsToFrames(overlay.inSeconds as number) : host.from;
    // 缺省出点 = 宿主场景末尾；但若入点已经晚于宿主末尾，至少给 1 帧而不是压成 0 或负
    const outFrames = hasOut
      ? secondsToFrames(overlay.outSeconds as number)
      : Math.max(from + 1, hostEnd);

    const clampedFrom = Math.max(0, Math.min(from, outFrames - 1));
    out.push({ overlay, from: clampedFrom, frames: Math.max(1, outFrames - clampedFrom), hostIndex });
  });
  return out;
}

/** 组装最终布局：排版末端即成片末端。 */
function assemble(spans: Span[], overlays: OverlaySpec[] | undefined, outro: Storyboard["outro"] | ClipStoryboard["outro"]): StoryboardLayout {
  const laidOverlays = layoutOverlays(overlays, spans);
  let cursor = spans.length ? spans[spans.length - 1].from + spans[spans.length - 1].frames : 0;

  const outroFrames = outro ? secondsToFrames(outro.durationSeconds ?? DEFAULT_OUTRO_SECONDS) : 0;
  const outroFrom = outroFrames > 0 ? cursor : null;
  if (outroFrom !== null) cursor += outroFrames;

  return {
    spans,
    overlays: laidOverlays,
    outroFrom,
    outroFrames,
    // 至少 1 帧；这里不再和任何「声明时长」取 max
    totalFrames: Math.max(cursor, 1),
  };
}

/** 图片分镜排版：场景按绝对出点首尾相接，片尾接在最后一个场景之后。 */
export function layoutStoryboard(storyboard: Storyboard): StoryboardLayout {
  const spans = spansFromOutPoints(storyboard.scenes.map((scene) => scene.outSeconds));
  return assemble(spans, storyboard.overlays, storyboard.outro);
}

/**
 * 片段分镜排版。
 *
 * 时长契约：TransitionSeries 的总时长 = Σ序列时长 − Σ转场时长，
 * 而每个片段的序列时长取「片段帧数 + 转场帧数」，转场吃掉重叠部分，
 * 于是总长精确等于 Σ片段帧数。故这里直接按出点差值累加即可。
 */
export function layoutClipStoryboard(storyboard: ClipStoryboard): StoryboardLayout {
  const outPoints = storyboard.clips.map((clip) => clip.outSeconds);
  const spans: Span[] = [];
  let cursor = 0;
  for (const outSeconds of outPoints) {
    const outFrames = Math.max(cursor + 1, secondsToFrames(outSeconds));
    spans.push({ from: cursor, frames: outFrames - cursor });
    cursor = outFrames;
  }
  return assemble(spans, storyboard.overlays, storyboard.outro);
}

/** 任意分镜的总帧数，供 calculateMetadata 用。 */
export function storyboardTotalFrames(storyboard: Storyboard | ClipStoryboard): number {
  return "scenes" in storyboard
    ? layoutStoryboard(storyboard).totalFrames
    : layoutClipStoryboard(storyboard).totalFrames;
}