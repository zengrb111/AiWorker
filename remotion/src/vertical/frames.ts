/** 竖版成片的固定规格与帧数换算。所有合成模板共用，避免各处硬编码不一致。 */

export const VERTICAL_WIDTH = 1080;
export const VERTICAL_HEIGHT = 1920;
export const VERTICAL_FPS = 30;

/** 下方净空高度（px）：画面不铺满到底，字幕落在这条带里。 */
export const SAFE_AREA_BOTTOM = 420;

/** 字幕底边距，与 ffmpeg burnSubtitles 的 MarginV=340 保持一致。 */
export const CAPTION_MARGIN_BOTTOM = 340;

export const DEFAULT_OUTRO_SECONDS = 2.5;

/** 秒 → 帧。至少 1 帧，避免出现零长 Sequence。 */
export function secondsToFrames(seconds: number, fps: number = VERTICAL_FPS): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.round(seconds * fps));
}
