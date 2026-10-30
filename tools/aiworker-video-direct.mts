/**
 * One-off direct render: same VerticalStoryboard pipeline, but with a locked
 * narration that contains every required beat (hotspot → product value →
 * exports/free → follow + comment CTA). Used because the LLM narration stage
 * repeatedly dropped the last CTA under a 20-second budget.
 */
import { join } from "node:path";
import { runVideoPipeline, pickBgm } from "../src/lib/video/pipeline";

const userId = "cmu939ge0000b265q7aniwqav";
const prep = join(
  process.cwd(),
  "public",
  "uploads",
  "gen-video-prep",
  "1792768688278-7w5fmfr4"
);
const materials = [0, 1, 2, 3, 4, 5].map((i) => join(prep, `ref-${i}.jpg`));
const narration =
  "去年676万对登记。AI回忆录把照片做成实体书：AI代笔排版、老照片修复，PDF／长图／视频／链接导出，免费版可用。关注我，评论区回「回忆录」领工具地址。";
const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const workDir = join(process.cwd(), "public", "uploads", "gen-video-work", token);

const result = await runVideoPipeline({
  mode: "generate",
  token,
  materials,
  requirement:
    "AI回忆录20秒竖版宣传片：今日热点「去年全国结婚登记676万对」开场，照片做成实体书，AI代笔、分页排版、老照片修复，PDF/长图/视频/链接导出，免费版可用，片尾引导关注并评论区领取工具地址。温暖治愈，经典白字。",
  narrationText: narration,
  targetSeconds: 17,
  title: "把日子装订成书",
  outroText: "关注 AI回忆录 · 评论区领取工具地址",
  userId,
  theme: "warm-default",
  look: { captionStyle: "classic" },
  bgmPath: pickBgm(),
  workDir,
  renderViaDsh: false,
  onProgress: (text) => console.error(`[direct] ${text}`),
});

console.log(
  JSON.stringify({
    ok: result.ok,
    error: result.error,
    token,
    title: result.title,
    videoPath: result.videoUrl ?? null,
    coverPath: result.coverUrl ?? null,
    durationSeconds: result.diagnostics?.narrationSeconds ?? 0,
    narration: result.narration,
    sceneCount: result.diagnostics?.sceneCount ?? 0,
    engine: result.engineUsed,
    postSteps: result.diagnostics?.postSteps,
  })
);
