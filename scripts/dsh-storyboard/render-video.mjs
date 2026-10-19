/**
 * DSH 出片脚本（渲染 + 后期一条龙）。
 *
 * 由 DSH 沙箱内的 bash 工具调用，是本平台「DSH 调用 Remotion 生成视频并做后期」的承载者。
 * 与 src/lib/video/render.ts + src/lib/video-stitch.ts + src/lib/video/frame-check.ts
 * 的逻辑一一对应，但**不依赖 TypeScript 编译**：它跑在 DSH 子进程里，独立成一份自包含的
 * .mjs 最稳妥（同样的 Remotion 工程、同样的 ffmpeg 参数、同样的免费字体）。
 *
 * 通信协议（与平台 src/lib/video/pipeline.ts 约定）：
 *   --input  <manifest.json>   渲染清单（素材路径 / 分镜 / 配音 / 字幕 / 标题等）
 *   --output <result.json>     渲染结果（{ok, videoPath, coverPath, diagnostics} 或 {ok:false,error}）
 *
 * 约定（务必与平台一致）：
 *   - 成片最终写到 manifest.outputVideoAbs（形如 public/videos/<prefix>-<token>.mp4）
 *   - 封面写到 manifest.outputCoverAbs（形如 public/uploads/covers/<prefix>-<token>.jpg）
 *   - 中间产物（raw / pad / voice / sub / title）也落在 public/videos 下，文件名带后缀
 *
 * 永不抛未捕获异常：任何失败都写成 {ok:false,error} 让平台回退本地渲染。
 */

import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

/* -------------------------------------------------------------------------- */
/* 基础工具                                                                    */
/* -------------------------------------------------------------------------- */

function fail(resultPath, error) {
  const payload = { ok: false, error: String(error && error.message ? error.message : error) };
  try {
    writeFileSync(resultPath, JSON.stringify(payload), "utf8");
  } catch {
    // 连结果文件都写不出时，只能放弃；调用方会因「无结果文件」判定失败并回退
  }
  process.exit(0);
}

/**
 * 进度文件：每完成一步追加一行纯文本，平台在出片期间轮询它并流式推给会话。
 *
 * 路径由清单的 progressPath 指定（平台放在 uploads 工作目录，不会被渲染临时目录清理影响），
 * 这样 DSH 渲染这几分钟里用户能看到「正在渲染 / 混音 / 烧字幕 / 截封面」的真实进展。
 */
let progressPath = null;
function reportProgress(text) {
  if (!progressPath || !text) return;
  try {
    appendFileSync(progressPath, `${text}\n`, "utf8");
  } catch {
    // 进度写失败绝不影响出片
  }
}

function parseArgs(argv) {
  const out = { input: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") out.input = argv[++i];
    else if (argv[i] === "--output") out.output = argv[++i];
  }
  return out;
}

function tail(text, lines = 15) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-lines)
    .join("\n");
}

async function runFfmpeg(bin, args, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolveRun({ ok: false, code: -1, stdout, stderr: `${stderr}\n超时`, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ ok: false, code: -1, stdout, stderr: stderr + err.message, timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ ok: code === 0, code: code ?? -1, stdout, stderr, timedOut: false });
    });
  });
}

async function probeDuration(bin, path) {
  const r = await runFfmpeg(bin, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path,
  ], 60000);
  const n = parseFloat(r.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/* -------------------------------------------------------------------------- */
/* Remotion 渲染（对应 render.ts）                                              */
/* -------------------------------------------------------------------------- */

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);

function classifyMaterial(p) {
  const ext = extname(p).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  return "image";
}

/**
 * 素材复制进 Remotion 的 public 目录，返回相对 public 的路径（staticFile 只用相对路径）。
 * 与 render.ts::materializeAssets 同义。
 */
function materializeAssets(materials, workDirAbs) {
  mkdirSync(workDirAbs, { recursive: true });
  return materials.map((material, i) => {
    // ⚠ materials 的元素是 { absolutePath, kind } 对象，不是路径字符串。
    // 早期这里直接把元素传给 extname()/copyFileSync()，会抛
    // "The 'path' argument must be of type string. Received an instance of Object"。
    const abs = material.absolutePath;
    const name = `${String(i + 1).padStart(2, "0")}${extname(abs).toLowerCase() || ".bin"}`;
    const dest = join(workDirAbs, name);
    copyFileSync(abs, dest);
    const relativePath = `generated/${workDirAbs.split(/[\\/]/).pop()}/${name}`;
    return { relativePath, absolutePath: dest };
  });
}

/** 把分镜里的素材路径重写为本次复制后的相对路径（对应 render.ts::bindStoryboardPaths）。 */
function bindStoryboardPaths(storyboard, bound) {
  const pool = bound.map((b) => b.relativePath);
  if (storyboard && "scenes" in storyboard) {
    let cursor = 0;
    return {
      ...storyboard,
      scenes: storyboard.scenes.map((scene) => {
        const images = scene.images
          .map((img) => {
            if (!img) return null;
            const known = pool.includes(img) ? img : pool[cursor % pool.length];
            cursor++;
            return known;
          })
          .filter(Boolean);
        return { ...scene, images: images.length ? images : [pool[0]].filter(Boolean) };
      }),
    };
  }
  return {
    ...storyboard,
    clips: storyboard.clips.map((clip, i) => ({
      ...clip,
      src: pool.includes(clip.src) ? clip.src : pool[i % pool.length],
    })),
  };
}

/** 写 storyboard.json（无 BOM，否则 Remotion 的 JSON.parse 会报 Unexpected token）。 */
function writeProps(workDirAbs, payload) {
  mkdirSync(workDirAbs, { recursive: true });
  const propsPath = join(workDirAbs, "storyboard.json");
  writeFileSync(propsPath, JSON.stringify(payload, null, 2), "utf8");
  return propsPath;
}

/**
 * 调用 Remotion CLI 渲染一条竖版。与 render.ts::renderVertical 内部 Remotion 部分同义。
 * 返回 { ok, outputPath, detail }。
 */
async function renderVertical(opts) {
  const { cli, entry, compositionId, outputPath, propsPath, browserExe, timeoutMs, onProgress } = opts;
  if (!existsSync(entry)) return { ok: false, outputPath, detail: `找不到 Remotion 入口：${entry}` };
  if (!existsSync(cli)) return { ok: false, outputPath, detail: "找不到 @remotion/cli" };
  onProgress?.("正在渲染竖版成片...");
  const args = [cli, "render", entry, compositionId, outputPath, `--props=${propsPath}`];
  const extraEnv = browserExe ? { REMOTION_BROWSER_EXECUTABLE: browserExe } : {};
  const result = await new Promise((resolveRender) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...extraEnv, NODE_OPTIONS: "", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolveRender({ code: -1, stderr: `${stderr}\n渲染超时`, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRender({ code: -1, stderr: stderr + err.message, timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRender({ code: code ?? -1, stderr, timedOut: false });
    });
  });
  if (result.timedOut) return { ok: false, outputPath, detail: `渲染超时（${Math.round(timeoutMs / 1000)}s）` };
  if (result.code !== 0 || !existsSync(outputPath)) {
    return { ok: false, outputPath, detail: `渲染失败（退出码 ${result.code}）。\n${tail(result.stderr)}` };
  }
  return { ok: true, outputPath, detail: "渲染完成" };
}

/* -------------------------------------------------------------------------- */
/* 后期（对应 video-stitch.ts）                                                 */
/* -------------------------------------------------------------------------- */

const TARGET_W = 1080;
const TARGET_H = 1920;
const TARGET_FPS = 30;

/** 字体候选：**动态**取 cwd，确保 main() 里 chdir 到项目根后能找到仓库内字体。 */
function fontCandidates() {
  return [
    join(process.cwd(), "assets", "fonts", "NotoSansSC-VF.ttf"),
    "C:\\Windows\\Fonts\\NotoSansSC-VF.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  ];
}

function resolveFreeFont() {
  for (const c of fontCandidates()) if (existsSync(c)) return c;
  return null;
}

const CAPTION_STYLES = {
  classic: "FontSize=56,Bold=0,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=340",
  "bold-yellow": "FontSize=62,Bold=1,PrimaryColour=&H00E1FF&,OutlineColour=&H00101010&,BorderStyle=1,Outline=5,Shadow=2,Alignment=2,MarginV=360",
  "boxed-dark": "FontSize=52,Bold=1,PrimaryColour=&HFFFFFF&,OutlineColour=&HC0000000&,BackColour=&HB0000000&,BorderStyle=3,Outline=14,Shadow=0,Alignment=2,MarginV=320",
  "minimal-line": "FontSize=48,Bold=0,PrimaryColour=&HFFFFFF&,OutlineColour=&H40000000&,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=380",
};

function resolveBin(name, fromManifest, envName) {
  if (fromManifest) return fromManifest;
  if (process.env[envName]) return process.env[envName];
  return name;
}

async function burnSubtitles(ffmpeg, inputPath, srtPath, outputPath, look = "classic", onProgress) {
  if (!existsSync(inputPath)) return { ok: false, reason: `输入不存在：${inputPath}` };
  if (!existsSync(srtPath)) return { ok: false, reason: `字幕文件不存在：${srtPath}` };
  const resolvedFont = resolveFreeFont();
  if (!resolvedFont) {
    return { ok: false, reason: "未找到免费可商用中文字体（Noto Sans SC）。" };
  }
  const escaped = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const escapedFont = resolvedFont.replace(/\\/g, "/").replace(/:/g, "\\:");
  const fontfile = `fontfile=${escapedFont}`;
  const style = CAPTION_STYLES[look] || CAPTION_STYLES.classic;
  const filter = `subtitles='${escaped}':charenc=UTF-8:force_style='${fontfile},PlayResX=1080,PlayResY=1920,${style}'`;
  onProgress?.("正在烧录字幕...");
  const r = await runFfmpeg(ffmpeg, [
    "-y", "-i", inputPath, "-vf", filter,
    "-c:v", "libx264", "-preset", "medium", "-c:a", "copy", outputPath,
  ], 240000);
  if (!r.ok || !existsSync(outputPath)) return { ok: false, reason: `字幕烧录失败：${tail(r.stderr, 5)}` };
  return { ok: true, outputPath };
}

function fmtSrtTime(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}

const MAX_CHARS_PER_LINE = 14;
function wrapSubtitleText(text) {
  const chars = Array.from(text.replace(/\s+/g, ""));
  if (chars.length <= MAX_CHARS_PER_LINE) return chars.join("");
  const lines = [];
  for (let i = 0; i < chars.length; i += MAX_CHARS_PER_LINE) {
    lines.push(chars.slice(i, i + MAX_CHARS_PER_LINE).join(""));
  }
  return lines.join("\n");
}

function buildSrtFromCaptions(captions, srtPath) {
  const cues = (captions || []).filter((c) => c.word && c.word.trim() && c.endMs > c.startMs);
  if (!cues.length) return { ok: false, cueCount: 0 };
  const blocks = cues.map((c, i) => {
    const text = wrapSubtitleText(c.word.trim());
    return `${i + 1}\n${fmtSrtTime(c.startMs / 1000)} --> ${fmtSrtTime(c.endMs / 1000)}\n${text}\n`;
  });
  writeFileSync(srtPath, blocks.join("\n"), "utf-8");
  return { ok: true, cueCount: cues.length };
}

async function padVideoToDuration(ffmpeg, inputPath, outputPath, extraSeconds, onProgress) {
  if (!existsSync(inputPath)) return { ok: false, reason: `输入不存在：${inputPath}` };
  if (!(extraSeconds > 0)) return { ok: false, reason: "无需延长" };
  onProgress?.(`正在延长画面 ${extraSeconds.toFixed(1)} 秒以对齐口播...`);
  const r = await runFfmpeg(ffmpeg, [
    "-y", "-i", inputPath,
    "-vf", `tpad=stop_mode=clone:stop_duration=${extraSeconds.toFixed(2)}`,
    "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "copy", outputPath,
  ], 300000);
  if (!r.ok || !existsSync(outputPath)) return { ok: false, reason: `画面延长失败：${tail(r.stderr, 4)}` };
  return { ok: true, outputPath };
}

async function muxNarration(ffmpeg, ffprobe, videoPath, audioPath, outputPath, opts = {}) {
  const { bgmPath, bgmVolume = 0.16, onProgress } = opts;
  if (!existsSync(videoPath)) return { ok: false, reason: `视频不存在：${videoPath}` };
  if (!existsSync(audioPath)) return { ok: false, reason: `配音不存在：${audioPath}` };
  const vDur = await probeDuration(ffprobe, videoPath);
  const aDur = await probeDuration(ffprobe, audioPath);
  const bgmOk = !!bgmPath && existsSync(bgmPath);
  onProgress?.(`正在合成配音${bgmOk ? " + 背景音乐" : ""}（画面 ${vDur.toFixed(1)}s / 配音 ${aDur.toFixed(1)}s）...`);
  const extend = aDur > vDur + 0.2;
  const inputs = ["-i", videoPath, "-i", audioPath];
  if (bgmOk) inputs.push("-stream_loop", "-1", "-i", bgmPath);
  const filters = [];
  if (extend) {
    const extra = (aDur - vDur + 0.3).toFixed(2);
    filters.push(`[0:v]tpad=stop_mode=clone:stop_duration=${extra}[v]`);
  }
  if (bgmOk) {
    filters.push("[1:a]apad[v1]", `[2:a]volume=${bgmVolume}[b1]`, "[v1][b1]amix=inputs=2:duration=longest:dropout_transition=0[a]");
  } else {
    filters.push("[1:a]apad[a]");
  }
  const args = [
    "-y", ...inputs, "-filter_complex", filters.join(";"),
    "-map", extend ? "[v]" : "0:v", "-map", "[a]",
    ...(extend ? ["-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p"] : ["-c:v", "copy"]),
    "-c:a", "aac", "-b:a", "192k", "-shortest", outputPath,
  ];
  const r = await runFfmpeg(ffmpeg, args, 300000);
  if (!r.ok || !existsSync(outputPath)) return { ok: false, reason: `配音合成失败：${tail(r.stderr, 4)}` };
  return { ok: true, outputPath };
}

async function addTitleOverlay(ffmpeg, inputPath, title, outputPath, opts = {}) {
  if (!existsSync(inputPath)) return { ok: false, reason: `输入不存在：${inputPath}` };
  const clean = title.replace(/\r?\n/g, " ").trim();
  if (!clean) return { ok: true, outputPath: inputPath };
  const dur = opts.durationSec ?? 3;
  const titleFile = join(opts.workDir || process.cwd(), `title-${Date.now()}.txt`);
  writeFileSync(titleFile, clean, "utf-8");
  const escTxt = titleFile.replace(/\\/g, "/").replace(/:/g, "\\:");
  const resolvedFont = resolveFreeFont();
  if (!resolvedFont) return { ok: false, reason: "未找到免费可商用中文字体（Noto Sans SC）。" };
  const fontfile = resolvedFont.replace(/\\/g, "/").replace(/:/g, "\\:");
  const filter =
    `drawtext=fontfile='${fontfile}':textfile='${escTxt}':` +
    `fontsize=76:fontcolor=white:borderw=6:bordercolor=black@0.85:` +
    `box=1:boxcolor=black@0.35:boxborderw=34:` +
    `x=(w-text_w)/2:y=h*0.26:enable='lt(t\\,${dur})'`;
  opts.onProgress?.(`正在添加片头标题（前 ${dur}s）...`);
  const r = await runFfmpeg(ffmpeg, [
    "-y", "-i", inputPath, "-vf", filter, "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "copy", outputPath,
  ], 300000);
  if (!r.ok || !existsSync(outputPath)) return { ok: false, reason: `片头标题叠加失败：${tail(r.stderr, 4)}` };
  return { ok: true, outputPath };
}

async function extractCoverFrame(ffmpeg, inputPath, outputPath, atSec) {
  if (!existsSync(inputPath)) return { ok: false, reason: `输入不存在：${inputPath}` };
  const r = await runFfmpeg(ffmpeg, [
    "-y", "-ss", atSec.toFixed(2), "-i", inputPath, "-frames:v", "1", "-q:v", "2", outputPath,
  ], 60000);
  if (!r.ok || !existsSync(outputPath)) return { ok: false, reason: `封面截图失败：${tail(r.stderr, 3)}` };
  return { ok: true, outputPath };
}

/* -------------------------------------------------------------------------- */
/* 画面黑屏自检（对应 frame-check.ts）                                          */
/* -------------------------------------------------------------------------- */

const MIN_BLACK_SECONDS = 2.0;
const PIXEL_THRESHOLD = 0.1;
const TAIL_IGNORE_SECONDS = 3.0;
const DEFAULT_TOLERANCE_SECONDS = 1.5;

function parseBlackSpans(text) {
  const spans = [];
  const re = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: Number(m[1]), end: Number(m[2]), duration: Number(m[3]) });
  }
  return spans;
}

async function checkVideoFrames(ffmpeg, ffprobe, path) {
  const probe = await runFfmpeg(ffprobe, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1", path,
  ], 60000);
  const info = probe.stdout.trim();
  const duration = Number(/^duration=([\d.]+)$/m.exec(info)?.[1] ?? NaN);
  const size = /width=(\d+)\s+height=(\d+)/.exec(info);
  const meta = { durationSeconds: Number.isFinite(duration) ? duration : 0, resolution: size ? `${size[1]}x${size[2]}` : "未知" };
  if (meta.durationSeconds <= 0) return { ok: true, detail: "无法探测时长，跳过画面检查", spans: [], ignoredTailSpans: [] };
  let text = "";
  try {
    const scan = await runFfmpeg(ffmpeg, [
      "-hide_banner", "-nostats", "-i", path,
      "-vf", `blackdetect=d=${MIN_BLACK_SECONDS}:pix_th=${PIXEL_THRESHOLD}`, "-an", "-f", "null", "-",
    ], 120000);
    text = `${scan.stderr}\n${scan.stdout}`;
  } catch (err) {
    return { ok: true, detail: `画面检查执行失败，跳过：${err.message}`, spans: [], ignoredTailSpans: [] };
  }
  const all = parseBlackSpans(text);
  const tailFrom = meta.durationSeconds - TAIL_IGNORE_SECONDS;
  const spans = all.filter((s) => s.start < tailFrom);
  const ignoredTailSpans = all.filter((s) => s.start >= tailFrom);
  const bad = spans.filter((s) => s.duration > DEFAULT_TOLERANCE_SECONDS);
  if (bad.length === 0) {
    return { ok: true, detail: `画面正常，无超过 ${DEFAULT_TOLERANCE_SECONDS}s 的黑屏`, spans, ignoredTailSpans };
  }
  const worst = bad.reduce((a, b) => (b.duration > a.duration ? b : a));
  return {
    ok: false,
    detail: `检出 ${bad.length} 段超长黑屏，最长 ${worst.duration.toFixed(1)}s（${worst.start.toFixed(1)}s → ${worst.end.toFixed(1)}s）。常见原因：Sequence 漏 from，或场景时长之和 + 片尾 < 成片时长。`,
    spans, ignoredTailSpans,
  };
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    fail(args.output, "缺少 --input 或 --output 参数");
    return;
  }
  const resultPath = args.output;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(args.input, "utf8"));
  } catch (err) {
    fail(resultPath, `无法读取/解析渲染清单：${err.message}`);
    return;
  }

  const ffmpeg = resolveBin("ffmpeg", manifest.ffmpegBin, "FFMPEG_BIN");
  const ffprobe = resolveBin("ffprobe", manifest.ffprobeBin, "FFPROBE_BIN");
  const projectRoot = manifest.projectRoot || process.cwd();
  // 统一切到项目根：后续 Remotion CLI、字体解析、素材目录都基于 process.cwd()。
  try {
    process.chdir(projectRoot);
  } catch {
    // chdir 失败不阻断：路径若本就是绝对路径，仍可正常渲染
  }
  const token = manifest.token;
  const prefix = manifest.prefix || "render";

  const entry = join(projectRoot, "remotion", "src", "index.tsx");
  const cli = join(projectRoot, "node_modules", "@remotion", "cli", "remotion-cli.js");
  const generatedRoot = join(projectRoot, "remotion", "public", "generated");
  const workDirAbs = join(generatedRoot, `render-${token}`);
  const videosDir = join(projectRoot, "public", "videos");
  const coverDir = join(projectRoot, "public", "uploads", "covers");
  mkdirSync(videosDir, { recursive: true });
  mkdirSync(coverDir, { recursive: true });
  mkdirSync(workDirAbs, { recursive: true });

  // 进度文件：平台在出片期间轮询它，把 DSH 的渲染过程流式推给会话。
  progressPath = manifest.progressPath || join(workDirAbs, "render-progress.log");

  const rawAbs = join(videosDir, `${prefix}-${token}-raw.mp4`);
  const finalVideoAbs = manifest.outputVideoAbs || join(videosDir, `${prefix}-${token}.mp4`);
  const finalCoverAbs = manifest.outputCoverAbs || join(coverDir, `${prefix}-${token}.jpg`);

  const diagnostics = { steps: [] };
  const record = (step, ok, detail) => {
    diagnostics.steps.push({ step, ok, detail });
    // 同步写进度文件：每一步都让平台能流式推给会话。
    reportProgress(`${ok ? "✓" : "✗"} ${step}${detail ? `：${detail}` : ""}`);
  };

  try {
    reportProgress("已读取渲染清单，正在准备素材与画面…");
    // ---- 1. 素材 + 分镜绑定 ----
    const materials = (manifest.materials || []).filter((p) => existsSync(p)).map((abs) => ({ absolutePath: abs, kind: classifyMaterial(abs) }));
    if (!materials.length) {
      fail(resultPath, "没有可用素材，无法渲染");
      return;
    }
    const bound = materializeAssets(materials, workDirAbs);
    const storyboard = bindStoryboardPaths(manifest.storyboard, bound);
    const propsPath = writeProps(workDirAbs, { storyboard });

    // ---- 2. Remotion 渲染 ----
    // 渲染是最长的一段（数分钟），先报一句，避免用户以为卡住。
    reportProgress("正在渲染竖版画面（Remotion），这一步通常需要 1~5 分钟…");
    const render = await renderVertical({
      cli, entry, compositionId: manifest.compositionId, outputPath: rawAbs, propsPath,
      browserExe: manifest.browserExe || process.env.REMOTION_BROWSER_EXECUTABLE || undefined,
      timeoutMs: manifest.renderTimeoutMs || 900000,
    });
    record("Remotion 渲染", render.ok, render.detail);
    if (!render.ok) {
      fail(resultPath, `画面渲染失败：${render.detail}`);
      return;
    }

    // ---- 3. 画面黑屏自检 ----
    if (!manifest.skipFrameCheck) {
      const check = await checkVideoFrames(ffmpeg, ffprobe, rawAbs);
      record("画面黑屏自检", check.ok, check.detail);
      diagnostics.frameCheck = check;
    }

    // ---- 4. 后期 ----
    let currentAbs = rawAbs;

    if (manifest.audioPath && existsSync(manifest.audioPath)) {
      const rendered = await probeDuration(ffprobe, currentAbs);
      const aDur = await probeDuration(ffprobe, manifest.audioPath);
      const gap = aDur - rendered;
      if (Number.isFinite(gap) && gap > 0.3) {
        const paddedAbs = join(videosDir, `${prefix}-${token}-pad.mp4`);
        const pad = await padVideoToDuration(ffmpeg, currentAbs, paddedAbs, gap);
        record("画面延长", pad.ok, pad.ok ? `+${gap.toFixed(1)}s` : pad.reason);
        if (pad.ok) currentAbs = paddedAbs;
      }
      const muxedAbs = join(videosDir, `${prefix}-${token}-voice.mp4`);
      const mux = await muxNarration(ffmpeg, ffprobe, currentAbs, manifest.audioPath, muxedAbs, {
        bgmPath: manifest.bgmPath && existsSync(manifest.bgmPath) ? manifest.bgmPath : undefined,
        onProgress: () => {},
      });
      record("配音混音", mux.ok, mux.ok ? undefined : mux.reason);
      if (mux.ok) currentAbs = muxedAbs;
    }

    const captions = manifest.captions && manifest.captions.length ? manifest.captions : null;
    if (captions) {
      const srtPath = join(workDirAbs, "captions.srt");
      const srt = buildSrtFromCaptions(captions, srtPath);
      if (srt.ok) {
        const subAbs = join(videosDir, `${prefix}-${token}-sub.mp4`);
        const burn = await burnSubtitles(ffmpeg, currentAbs, srtPath, subAbs, manifest.captionStyle || "classic");
        record("字幕烧录", burn.ok, burn.ok ? `${srt.cueCount} 句` : burn.reason);
        if (burn.ok) currentAbs = subAbs;
      } else {
        record("字幕烧录", false, "字幕数据为空");
      }
    }

    const titleText = manifest.titleText && manifest.titleText.trim();
    if (titleText) {
      const titleAbs = join(videosDir, `${prefix}-${token}-title.mp4`);
      const overlay = await addTitleOverlay(ffmpeg, currentAbs, titleText, titleAbs, {
        durationSec: manifest.titleSeconds || 3, workDir: workDirAbs,
      });
      record("片头标题", overlay.ok, overlay.ok ? undefined : overlay.reason);
      if (overlay.ok) currentAbs = titleAbs;
    }

    // 最终成片：把 currentAbs 拷贝/移动到 finalVideoAbs
    if (currentAbs !== finalVideoAbs) {
      copyFileSync(currentAbs, finalVideoAbs);
    }

    // ---- 5. 封面 ----
    const duration = await probeDuration(ffprobe, finalVideoAbs);
    const cover = await extractCoverFrame(ffmpeg, finalVideoAbs, finalCoverAbs, Math.max(1, Math.min(4, duration * 0.35)));
    record("封面截取", cover.ok, cover.ok ? undefined : cover.reason);

    // 成功：清理 Remotion 临时素材
    rmSync(workDirAbs, { recursive: true, force: true });

    reportProgress("出片完成，正在回传成片信息…");
    writeFileSync(resultPath, JSON.stringify({
      ok: true,
      videoPath: finalVideoAbs,
      coverPath: cover.ok ? finalCoverAbs : null,
      diagnostics,
    }), "utf8");
  } catch (err) {
    fail(resultPath, `出片异常：${err && err.message ? err.message : err}`);
  }
}

main();
