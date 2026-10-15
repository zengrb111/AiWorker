/**
 * 成片画面自检：确认整条视频真的有画面，而不是「只有开头几秒有，后面全黑」。
 *
 * 为什么必须自动做：
 * 「Remotion 渲染成功」只代表退出码为 0，不代表每一帧都有内容。
 * 之前 VerticalStoryboard 的 Sequence 漏了 from，所有场景叠在第 0 帧，
 * 于是 4/5 的成片是纯黑 —— 而当时的人工 E2E 只断言了时长/分辨率/封面存在，
 * 黑屏完美地溜了过去，最后是用户肉眼发现的。
 *
 * 做法用 ffmpeg 的 blackdetect 全片扫描（不抽帧、不引额外依赖）：
 * 它输出 `black_start:X black_end:Y black_duration:Z` 形式的黑屏区间。
 *
 * 片尾卡按设计就是「深底 + 大字」，主体背景亮度必然低于 blackdetect 的阈值，
 * 全片扫描一定会把它报出来 —— 那是误报。所以固定忽略末尾 OUTRO_SECONDS + 余量。
 */

import { FFMPEG, FFPROBE, runTool } from "../ffmpeg";

/** 短于这个秒数的黑屏不算问题（转场、淡入淡出都会瞬时偏暗）。 */
const DEFAULT_TOLERANCE_SECONDS = 1.5;

/** blackdetect 的 d 参数：比容差略大，只有「真的超了容差」才会被报出来。 */
const MIN_BLACK_SECONDS = 2.0;

/** 像素亮度阈值：亮度低于此比例的像素算黑。 */
const PIXEL_THRESHOLD = 0.1;

/** 片尾卡设计时长 + 余量。模板里片尾固定存在（兜底分镜也带 outro），按固定值忽略是安全的。 */
const TAIL_IGNORE_SECONDS = 3.0;

export type BlackSpan = { start: number; end: number; duration: number };

export type FrameCheckOptions = {
  /** 超过这个时长的黑屏算缺陷。缺省 1.5s。 */
  toleranceSeconds?: number;
  /** 忽略末尾多少秒（片尾卡）。缺省 3s。 */
  tailIgnoreSeconds?: number;
};

export type FrameCheckResult = {
  ok: boolean;
  /** 视频时长（秒）；探测失败为 0。 */
  durationSeconds: number;
  /** 非片尾区检出的黑屏区间。 */
  spans: BlackSpan[];
  /** 被当作片尾卡忽略掉的区间，仅供日志参考。 */
  ignoredTailSpans: BlackSpan[];
  /** 宽高，形如 "1080x1920"。 */
  resolution: string;
  /** 供 notify / 日志直接使用的一句话结论。 */
  detail: string;
};

function parseBlackSpans(text: string): BlackSpan[] {
  const spans: BlackSpan[] = [];
  const re = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: Number(m[1]), end: Number(m[2]), duration: Number(m[3]) });
  }
  return spans;
}

/** 探测时长与分辨率。失败返回 0 / "未知"。 */
export async function probeVideoMeta(path: string): Promise<{ durationSeconds: number; resolution: string }> {
  const probe = await runTool(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1",
    path,
  ]);
  const info = probe.stdout.trim();
  const duration = Number(/^duration=([\d.]+)$/m.exec(info)?.[1] ?? NaN);
  const size = /width=(\d+)\s+height=(\d+)/.exec(info);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    resolution: size ? `${size[1]}x${size[2]}` : "未知",
  };
}

/** 全片扫描黑屏。永不抛错，异常一律按「无法判定」处理并 ok=true（不该因为自检工具挂了就丢掉成片）。 */
export async function checkVideoFrames(path: string, options: FrameCheckOptions = {}): Promise<FrameCheckResult> {
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const tailIgnore = options.tailIgnoreSeconds ?? TAIL_IGNORE_SECONDS;
  const meta = await probeVideoMeta(path);

  if (meta.durationSeconds <= 0) {
    return {
      ok: true,
      durationSeconds: 0,
      spans: [],
      ignoredTailSpans: [],
      resolution: meta.resolution,
      detail: "无法探测时长，跳过画面检查",
    };
  }

  let text = "";
  try {
    const scan = await runTool(FFMPEG, [
      "-hide_banner",
      "-nostats",
      "-i", path,
      "-vf", `blackdetect=d=${MIN_BLACK_SECONDS}:pix_th=${PIXEL_THRESHOLD}`,
      "-an",
      "-f", "null", "-",
    ]);
    text = `${scan.stderr}\n${scan.stdout}`;
  } catch (err) {
    return {
      ok: true,
      durationSeconds: meta.durationSeconds,
      spans: [],
      ignoredTailSpans: [],
      resolution: meta.resolution,
      detail: `画面检查执行失败，跳过：${(err as Error).message}`,
    };
  }

  const all = parseBlackSpans(text);
  const tailFrom = meta.durationSeconds - tailIgnore;
  const spans = all.filter((s) => s.start < tailFrom);
  const ignoredTailSpans = all.filter((s) => s.start >= tailFrom);
  const bad = spans.filter((s) => s.duration > tolerance);

  if (bad.length === 0) {
    return {
      ok: true,
      durationSeconds: meta.durationSeconds,
      spans,
      ignoredTailSpans,
      resolution: meta.resolution,
      detail: `画面正常，无超过 ${tolerance}s 的黑屏`,
    };
  }

  const worst = bad.reduce((a, b) => (b.duration > a.duration ? b : a));
  return {
    ok: false,
    durationSeconds: meta.durationSeconds,
    spans,
    ignoredTailSpans,
    resolution: meta.resolution,
    detail:
      `检出 ${bad.length} 段超长黑屏，最长 ${worst.duration.toFixed(1)}s` +
      `（${worst.start.toFixed(1)}s → ${worst.end.toFixed(1)}s）。` +
      `常见原因：① Sequence 漏 from 造成场景叠在第 0 帧；② 场景时长之和 + 片尾 < 成片时长。`,
  };
}