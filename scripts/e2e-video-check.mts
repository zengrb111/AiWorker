/**
 * 端到端出片自检：真跑一次 runVideoPipeline（DSH 分镜 + Remotion 渲染 + 全部后期），
 * 然后对成片做画面黑屏扫描。
 *
 * 为什么必须有这个：黑屏只在「真实分镜 + 真实渲染」下才暴露。
 * 上一轮 E2E 只断言了时长/分辨率/封面存在，4/5 时长是纯黑也照样「通过」，
 * 最后是用户肉眼发现的。现在成片必须过画面扫描才算通过。
 *
 * 跑法（项目根，用项目指定的 Node）：
 *   node --experimental-strip-types --import ./scripts/ts-resolver.mts scripts/e2e-video-check.mts
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runVideoPipeline } from "../src/lib/video/pipeline.ts";
import { checkVideoFrames } from "../src/lib/video/frame-check.ts";

/** 复用项目里现成的参考图，避免依赖外部素材。 */
const REF_ROOT = join(process.cwd(), "public", "uploads", "gen-video-refs");

function pickImages(limit = 5): string[] {
  if (!existsSync(REF_ROOT)) {
    throw new Error(`找不到参考图目录：${REF_ROOT}（先跑过一次一键生成视频才会有）`);
  }
  const batches = readdirSync(REF_ROOT).sort();
  for (const batch of batches) {
    const dir = join(REF_ROOT, batch);
    const images = readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .map((f) => join(dir, f));
    if (images.length >= 3) return images.slice(0, limit);
  }
  throw new Error(`${REF_ROOT} 下没有足够的参考图`);
}

async function main(): Promise<void> {
  const images = pickImages();
  console.log(`素材：${images.length} 张`);

  const token = `e2e-${Date.now().toString(36)}`;
  const result = await runVideoPipeline({
    mode: "generate",
    token,
    materials: images,
    requirement: "用温暖治愈的笔触，讲述城市里那些不起眼的温暖瞬间，节奏舒缓，20 秒左右。",
    targetSeconds: 20,
    title: "城市里的温暖瞬间",
    outroText: "关注获取更多",
    onProgress: (text) => console.log(`  · ${text}`),
  });

  console.log("");
  console.log(`出片：ok=${result.ok} engine=${result.engineUsed}`);
  console.log(`诊断：${JSON.stringify(result.diagnostics)}`);
  if (!result.ok || !result.videoUrl) {
    console.error(`✗ 出片失败：${result.error}`);
    process.exit(1);
  }

  const abs = join(process.cwd(), "public", result.videoUrl.replace(/^\//, ""));
  const check = await checkVideoFrames(abs);

  console.log("");
  console.log(`成片：${result.videoUrl}`);
  console.log(`规格：${check.resolution} / ${check.durationSeconds.toFixed(2)}s`);
  console.log(`封面：${result.coverUrl ?? "（无）"}`);
  for (const s of check.spans) {
    console.log(`  黑屏 ${s.start.toFixed(2)}s → ${s.end.toFixed(2)}s（${s.duration.toFixed(2)}s）`);
  }
  if (check.ignoredTailSpans.length) {
    console.log(`  （片尾 ${check.ignoredTailSpans.length} 段深色画面已按片尾卡忽略）`);
  }

  if (!check.ok) {
    console.error(`✗ 画面检查失败：${check.detail}`);
    process.exit(1);
  }
  console.log("");
  console.log(`✓ 端到端通过：${check.detail}`);
}

main().catch((err) => {
  console.error(`自检异常：${err instanceof Error ? err.stack : String(err)}`);
  process.exit(2);
});