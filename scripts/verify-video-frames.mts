/**
 * 成片画面自检的命令行入口：确认整条视频真的有画面，而不是「只有开头几秒有，后面全黑」。
 *
 * 为什么需要这个工具：出片流水线里「Remotion 渲染成功」只代表退出码为 0，
 * 不代表每一帧都有内容。VerticalStoryboard 的 Sequence 漏了 from 时，
 * 4/5 的成片是纯黑但渲染完全成功 —— 靠肉眼才发现。
 *
 * 出片流水线内的同一套检查在 src/lib/video/frame-check.ts（流水线用 TS 编译，
 * Node 的 --experimental-strip-types 无法解析它那些无扩展名的 import，
 * 所以这里是一份独立的 CLI 实现）。两边判据必须一致，改一处记得改另一处：
 *   ① 容差 1.5s  ② blackdetect 门槛 2.0s  ③ 忽略末尾 3.0s 的片尾卡。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-video-frames.mts public/videos/gen-video-xxx.mp4
 *   node --experimental-strip-types scripts/verify-video-frames.mts <video> --tolerance 1.5 --tail-ignore 3
 *
 * 退出码：0 = 通过；1 = 检出超长黑屏；2 = 用法/环境错误。
 */

import { spawn } from "node:child_process";

/* --- 与 src/lib/video/frame-check.ts 保持一致的判据 --- */
const DEFAULT_TOLERANCE_SECONDS = 1.5;
const MIN_BLACK_SECONDS = 2.0;
const PIXEL_THRESHOLD = 0.1;
const DEFAULT_TAIL_IGNORE_SECONDS = 3.0;

type RunResult = { code: number; stdout: string; stderr: string };

function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(bin, args, { windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", (err) => done({ code: -1, stdout, stderr: `${stderr}\n${err.message}` }));
    child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}

/** 取 --flag 后面的数值，缺失或非法时返回 undefined。 */
function numberFlag(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : undefined;
}

function parseBlackSpans(text: string) {
  const spans: { start: number; end: number; duration: number }[] = [];
  const re = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: Number(m[1]), end: Number(m[2]), duration: Number(m[3]) });
  }
  return spans;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const video = args[0];

  if (!video) {
    console.error(
      "用法：node --experimental-strip-types scripts/verify-video-frames.mts <video.mp4> [--tolerance 1.5] [--tail-ignore 3]",
    );
    return 2;
  }

  const tolerance = numberFlag(args, "--tolerance") ?? DEFAULT_TOLERANCE_SECONDS;
  const tailIgnore = numberFlag(args, "--tail-ignore") ?? DEFAULT_TAIL_IGNORE_SECONDS;

  const probe = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1",
    video,
  ]);
  const info = probe.stdout.trim();
  const duration = Number(/^duration=([\d.]+)$/m.exec(info)?.[1] ?? NaN);
  const size = /width=(\d+)\s+height=(\d+)/.exec(info);

  console.log(`文件：${video}`);
  console.log(`分辨率：${size ? `${size[1]}x${size[2]}` : "未知"}`);
  console.log(`时长：${Number.isFinite(duration) ? `${duration.toFixed(2)} 秒` : "未知"}`);

  if (!Number.isFinite(duration) || duration <= 0) {
    console.error("✗ 无法探测时长，检查文件是否有效");
    return 2;
  }

  const scan = await run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i", video,
    "-vf", `blackdetect=d=${MIN_BLACK_SECONDS}:pix_th=${PIXEL_THRESHOLD}`,
    "-an",
    "-f", "null", "-",
  ]);

  const all = parseBlackSpans(`${scan.stderr}\n${scan.stdout}`);
  const tailFrom = duration - tailIgnore;
  const spans = all.filter((s) => s.start < tailFrom);
  const ignoredTail = all.filter((s) => s.start >= tailFrom);

  for (const s of spans) {
    const where = s.end <= 1 ? "位于片头" : "位于中段";
    console.log(
      `${s.duration > tolerance ? "✗ 超限" : "· 可接受"} 黑屏 ${s.start.toFixed(2)}s → ${s.end.toFixed(
        2,
      )}s（${s.duration.toFixed(2)}s，${where}）`,
    );
  }
  if (ignoredTail.length) {
    console.log(`· 已忽略片尾 ${tailIgnore}s 内的 ${ignoredTail.length} 段深色画面（片尾卡为深底设计，非缺陷）`);
  }

  const bad = spans.filter((s) => s.duration > tolerance);
  if (bad.length === 0) {
    console.log(`✓ 画面检查通过：全片无超过 ${tolerance}s 的黑屏（门槛 ${MIN_BLACK_SECONDS}s，片尾忽略 ${tailIgnore}s）`);
    return 0;
  }

  const worst = bad.reduce((a, b) => (b.duration > a.duration ? b : a));
  console.error(
    `✗ 画面检查失败：${bad.length} 段超长黑屏，最长 ${worst.duration.toFixed(1)}s` +
      `（${worst.start.toFixed(1)}s → ${worst.end.toFixed(1)}s）`,
  );
  console.error("  常见原因：① Sequence 漏 from 造成场景叠在第 0 帧；② 场景时长之和 + 片尾 < 成片时长。");
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`自检异常：${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });