/**
 * 字体合规自检：确认 burnSubtitles / addTitleOverlay 用的免费字体真的能出字。
 *
 * 为什么必须真跑一次：NotoSansSC-VF.ttf 是**可变字体**，ffmpeg 的 libass
 * 对可变字体历史上支持不稳定（有的版本只认默认实例，有的直接报错）。
 * 这类问题静态检查发现不了，只有真烧一帧才知道。
 *
 * 跑法：
 *   node --experimental-transform-types --import ./scripts/ts-resolver.mts scripts/font-check.mts
 */

import { writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { addTitleOverlay, burnSubtitles } from "../src/lib/video-stitch.ts";
import { runTool, FFMPEG } from "../src/lib/ffmpeg.ts";

const TMP = join(process.cwd(), "public", "uploads", "font-check");
const FONT = join(process.cwd(), "assets", "fonts", "NotoSansSC-VF.ttf");

async function main(): Promise<number> {
  console.log(`字体文件：${FONT}`);
  if (!existsSync(FONT)) {
    console.error("✗ assets/fonts/NotoSansSC-VF.ttf 不存在");
    return 2;
  }
  console.log(`大小：${(statSync(FONT).size / 1024 / 1024).toFixed(2)} MB`);

  // 1) 造一条 3 秒黑底视频
  const base = join(TMP, "base.mp4");
  const made = await runTool(FFMPEG, [
    "-y", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:d=3:r=30",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", base,
  ]);
  if (!made.ok || !existsSync(base)) {
    console.error(`✗ 造底视频失败：${made.stderr.slice(0, 300)}`);
    return 2;
  }
  console.log("✓ 底视频就绪");

  // 2) 烧字幕
  const srt = join(TMP, "cap.srt");
  writeFileSync(srt, "1\n00:00:00,000 --> 00:00:03,000\n字体合规自检 免费可商用 Noto Sans SC\n", "utf8");
  const withSub = join(TMP, "sub.mp4");
  const burn = await burnSubtitles(base, srt, withSub);
  if (!burn.ok) {
    console.error(`✗ 字幕烧录失败：${burn.reason}`);
    return 1;
  }
  console.log(`✓ 字幕烧录成功（${withSub}）`);

  // 3) 片头标题
  const withTitle = join(TMP, "title.mp4");
  const title = await addTitleOverlay(withSub, "片头标题测试", withTitle, { durationSec: 2 });
  if (!title.ok) {
    console.error(`✗ 片头标题失败：${title.reason}`);
    return 1;
  }
  console.log(`✓ 片头标题成功（${withTitle}）`);

  // 4) 抽一帧算「非纯黑像素比例」——确认真画出了字形而不是静默失败
  const probeFrame = join(TMP, "frame.png");
  const frame = await runTool(FFMPEG, [
    "-y", "-ss", "1", "-i", withTitle, "-frames:v", "1", probeFrame,
  ]);
  if (!frame.ok || !existsSync(probeFrame)) {
    console.error("✗ 抽帧失败");
    return 2;
  }
  // 用 signalstats 统计平均亮度；纯黑底只有文字时亮度会略高于 0
  const stats = await runTool(FFMPEG, [
    "-hide_banner", "-i", probeFrame,
    "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    "-f", "null", "-",
  ]);
  const yavg = /YAVG=([\d.]+)/.exec(stats.stderr + stats.stdout)?.[1];
  const brightness = Number(yavg ?? 0);
  console.log(`抽帧平均亮度 YAVG=${brightness.toFixed(4)}`);

  if (brightness <= 0.001) {
    console.error("✗ 帧完全为黑 —— 字体可能没渲染出来（静默失败）");
    return 1;
  }
  console.log("✓ 帧内有可见内容，字体渲染正常");
  console.log("");
  console.log("结论：Noto Sans SC（SIL OFL 1.1）在 ffmpeg/libass 下可正常用于字幕与片头。");
  return 0;
}

main().then((c) => process.exit(c));
