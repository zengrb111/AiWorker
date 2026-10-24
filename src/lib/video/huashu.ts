/**
 * huashu-motion（花叔的动效片技能）CLI 封装。
 *
 * 为什么要有这一层：
 * - `om` 的所有能力（grab / new / render / check / studio / inbox / look / done）都是
 *   一次性或长驻的子进程命令，参数、超时、错误文案散落在接口里会很难维护。
 * - `om studio` 是**不会退出**的服务，必须 detached 起、轮询端口就绪，不能 await。
 * - 项目目录固定放在 public/uploads/huashu/<token>：成片能被 Next 直接静态托管，
 *   Studio 也只需要读这一个目录。
 *
 * 与 DSH 的分工（刻意划清）：
 * - 这里只做**确定性**的事：抓素材、建项目、渲染、拉评论、看帧、标记完成。
 * - 「写片、改片」由 DSH（render profile，放开 bash/fs）按 SKILL.md 完成，
 *   prompt 在本文件 buildFilmPrompt / buildEditPrompt 里生成。
 */

import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** huashu-motion 仓库根目录；可用 HUASHU_MOTION_ROOT 覆盖（换机器只改 env）。 */
export function huashuRoot(): string {
  const configured = (process.env.HUASHU_MOTION_ROOT || "").trim();
  return configured ? resolve(configured) : "C:/Users/zengr/huashu-motion";
}

/** `om` 的 Node 入口（Windows 上 bin/om 是 sh 脚本，不能直接跑）。 */
export function omEntry(): string {
  return join(huashuRoot(), "cli", "om.js");
}

export function huashuAvailable(): { ok: boolean; reason?: string } {
  const entry = omEntry();
  if (!existsSync(entry)) {
    return {
      ok: false,
      reason: `找不到 huashu-motion（${entry}）。设置环境变量 HUASHU_MOTION_ROOT 指向仓库根目录。`
    };
  }
  return { ok: true };
}

const DEFAULT_TIMEOUT_MS = 120_000;

export type OmResult = { stdout: string; stderr: string; code: number };

/**
 * 跑一条 om 命令。
 *
 * 刻意不用 execFileSync：项目里踩过 EBUSY（默认 stdio 在 Windows 上会抢句柄），
 * 统一走 spawn + 管道；stderr 保留尾部用于报错定位。
 */
export function omRun(
  args: string[],
  options: { timeoutMs?: number; cwd?: string; allowFailure?: boolean } = {}
): Promise<OmResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [omEntry(), ...args], {
      cwd: options.cwd || process.cwd(),
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // CodeBuddy 的 safe-delete shim 会从这里注入，子进程不需要
        NODE_OPTIONS: "",
        NO_COLOR: "1",
        PYTHONIOENCODING: "utf-8"
      }
    });

    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`om ${args[0]} 超时（${Math.round(timeoutMs / 1000)}s）。${tail(err)}`));
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      err += chunk;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 om（${process.execPath}）：${error.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result: OmResult = { stdout: out, stderr: err, code: code ?? 0 };
      // om inbox --wait 超时的退出码是 3，调用方需要把它当「没有新评论」而不是失败
      if (result.code !== 0 && !options.allowFailure) {
        reject(new Error(`om ${args[0]} 失败（code=${result.code}）：${tail(err) || tail(out)}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

function tail(text: string, lines = 12): string {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}

/** 项目目录：public/uploads/huashu/<token>，成片可直接用 /uploads/huashu/<token>/out/... 访问。 */
export function projectDirFor(token: string): string {
  return join(process.cwd(), "public", "uploads", "huashu", token);
}

/** `om new` 建项目（blank 模板；风格由 DSH 按产品自选，不预设模板）。 */
export async function omInit(dir: string): Promise<void> {
  mkdirSync(join(dir, "materials"), { recursive: true });
  await omRun(["new", dir], { timeoutMs: 60_000 });
}

/** `om grab`：把产品网站的真实素材（截图/logo/配色/字体）抓进 <dir>/materials。 */
export async function omGrab(url: string, dir: string): Promise<string> {
  const result = await omRun(["grab", url, dir], { timeoutMs: 180_000 });
  return result.stdout.trim();
}

/** `om check`：结构 / 脚本 / 动效规则 + 抽帧检查。0 error 才算过。 */
export async function omCheck(dir: string): Promise<OmResult> {
  // check 的「warnings」不阻断渲染，失败（error）才抛
  return omRun(["check", dir], { timeoutMs: 300_000 });
}

/**
 * `om render` → <dir>/out/<name>-vN.mp4。
 *
 * 本机 8 workers 会撞 CDP 60s 超时（SKILL.md 明确写了 --workers 2），
 * 所以这里固定 2，不做成参数。
 */
export async function omRender(dir: string): Promise<{ file: string; stdout: string }> {
  const result = await omRun(["render", dir, "--workers", "2"], { timeoutMs: 900_000 });
  const files = listRenderedVideos(dir);
  if (!files.length) {
    throw new Error(`om render 没有产出成片。输出尾部：\n${tail(result.stdout) || tail(result.stderr)}`);
  }
  return { file: files[0], stdout: result.stdout };
}

/** 目录下最新的成片（按 mtime 倒序）。 */
export function listRenderedVideos(dir: string): string[] {
  const outDir = join(dir, "out");
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((name) => /\.(mp4|webm|mov)$/i.test(name))
    .map((name) => join(outDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** ffprobe 读时长（秒）；读不到返回 null。 */
export function probeDuration(file: string): Promise<number | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.env.FFPROBE_BIN || "ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      file
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => resolvePromise(null));
    child.on("close", () => {
      const value = Number.parseFloat(out.trim());
      resolvePromise(Number.isFinite(value) ? value : null);
    });
  });
}

export type MotionComment = {
  id: string;
  text: string;
  /** 评论所在时间点（秒） */
  t?: number;
  /** 点中的元素 id */
  target?: string;
  status?: string;
};

/** `om inbox --wait`：阻塞等一条新评论，超时退出码 3 视为「没有」。 */
export async function omInboxWait(dir: string, timeoutSeconds = 55): Promise<MotionComment | null> {
  const result = await omRun(
    ["inbox", dir, "--wait", "--timeout", String(timeoutSeconds), "--json"],
    { timeoutMs: (timeoutSeconds + 30) * 1000, allowFailure: true }
  );
  if (result.code === 3 || !result.stdout.trim()) return null;
  if (result.code !== 0) {
    throw new Error(`om inbox 失败（code=${result.code}）：${tail(result.stderr) || tail(result.stdout)}`);
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as MotionComment | MotionComment[];
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    return item?.id ? item : null;
  } catch {
    // --json 在某些版本下会把提示混进 stdout；退化成「没有评论」比把整条链路判失败更合理
    return null;
  }
}

/**
 * 原子认领一条待处理评论（`om inbox --wait` 会先 snapshot 再 claim）。
 *
 * 为什么必须用它而不是「先 list 再处理」：list 只是读，不占位。
 * 平台可能同时有两个进程在扫（多个 dev server、手动点 + 自动 tick），
 * 两边都读到同一条 pending 就会各改一遍 —— 实测同一条评论被改了 2~3 次，
 * 既浪费几分钟模型调用，也会让人以为「AI 改重了」。
 */
export async function omInboxClaim(dir: string, timeoutSeconds = 2): Promise<MotionComment | null> {
  return omInboxWait(dir, timeoutSeconds);
}

/** `om look`：把评论所在那一帧 + 点选区域特写存成 PNG，供 DSH 真的「看」。 */
export async function omLook(commentId: string, dir: string): Promise<string> {
  const result = await omRun(["look", commentId, dir], { timeoutMs: 180_000 });
  return result.stdout.trim();
}

/** `om done`：告诉 studio 这条评论已处理（studio 里显示 note）。 */
export async function omDone(commentId: string, dir: string, note: string): Promise<void> {
  await omRun(["done", commentId, dir, "--note", note], { timeoutMs: 60_000 });
}

/**
 * 把评论退回「待处理」，让下一轮自动重试。
 *
 * om 的 inbox 是 append-only 事件日志（`.om/inbox.jsonl`），状态由折叠得出；
 * 一条被 claim 但改失败的评论会停在 `working`，永远不会再被扫到 ——
 * 实测「大部分改过来了、有条没过来」就是这么来的。
 * CLI 没有 reopen 子命令，但事件格式很简单（`{type:'reopen', id, note}`），
 * 直接追加一行即可，与 studio 自己的「重开」完全等价。
 */
export async function omInboxReopen(dir: string, commentId: string, note: string): Promise<void> {
  const file = join(dir, ".om", "inbox.jsonl");
  mkdirSync(join(dir, ".om"), { recursive: true });
  appendFileSync(file, JSON.stringify({ type: "reopen", id: commentId, note, at: new Date().toISOString() }) + "\n", "utf8");
}

/** `om inbox` 当前待处理评论（不阻塞），用于前端展示条数。 */
export async function omInboxList(dir: string): Promise<MotionComment[]> {
  const result = await omRun(["inbox", dir, "--json"], { timeoutMs: 60_000, allowFailure: true });
  if (result.code !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout.trim()) as MotionComment[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 起 Studio（不退出），并等它真正能访问。
 *
 * 端口从 startPort 往后找空位（om 自己会递增 20 次，这里只负责挑一个候选）。
 * 已在该端口跑着同一项目时直接复用 —— 否则每点一次「修改」就多一个 Node 进程。
 */
export async function ensureStudio(
  dir: string,
  startPort = 4850
): Promise<{ url: string; port: number; reused: boolean }> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await pingStudio(port, dir)) {
      return { url: `http://127.0.0.1:${port}`, port, reused: true };
    }
    if (await portInUse(port)) continue;

    const child = spawn(process.execPath, [omEntry(), "studio", dir, "--no-open", "--port", String(port)], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, NODE_OPTIONS: "", NO_COLOR: "1" }
    });
    child.unref();

    // Studio 起来会先扫项目再 listen，给 20s 余量
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      if (await pingStudio(port, dir)) {
        return { url: `http://127.0.0.1:${port}`, port, reused: false };
      }
      if (!alive(child)) break;
    }
    return { url: `http://127.0.0.1:${port}`, port, reused: false };
  }
  throw new Error("没有可用端口启动 Studio（4850-4869 都被占用）。");
}

async function pingStudio(port: number, dir: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const state = (await res.json()) as { root?: string };
    // 端口可能被另一个项目占着：必须确认是同一目录
    return !state.root || samePath(state.root, dir);
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [
      "-e",
      `const net=require("net");const s=net.connect(${port},"127.0.0.1");s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));`
    ], { windowsHide: true, stdio: "ignore" });
    child.on("close", (code) => resolvePromise(code === 0));
    child.on("error", () => resolvePromise(false));
  });
}

function alive(child: { exitCode: number | null }): boolean {
  return child.exitCode === null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 文件名（去掉扩展名），用来给版本记录一个可读的 note。 */
export function videoName(file: string): string {
  return basename(file, file.slice(file.lastIndexOf(".")));
}

/**
 * 硬裁到 N 秒（带 0.4s 音频淡出）。
 *
 * 只在 DSH 交出的片子超长时兜底：要求是 ≤20s，与其再跑一轮 10 分钟的 DSH，
 * 不如确定性地裁掉尾部。裁完仍然是一支能用的片子，只是结尾可能是硬切。
 */
export function trimToSeconds(file: string, seconds: number, outFile: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const args = [
      "-y",
      "-i", file,
      "-t", String(seconds),
      "-af", `afade=t=out:st=${Math.max(0, seconds - 0.4)}:d=0.4`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-c:a", "aac",
      "-b:a", "128k",
      outFile
    ];
    const child = spawn(process.env.FFMPEG_BIN || "ffmpeg", args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let err = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      err += chunk;
    });
    child.on("error", (error) => reject(new Error(`ffmpeg 无法启动：${error.message}`)));
    child.on("close", (code) => {
      if (code === 0 && existsSync(outFile)) resolvePromise();
      else reject(new Error(`裁剪失败（code=${code}）：${tail(err, 6)}`));
    });
  });
}

/**
 * 把成片发布到 public/videos，返回对外 URL。
 *
 * 不直接引用 uploads 下的 out/ 目录：那一份会被下一次 om render 覆盖（vN 递增但
 * 旧版本仍在），平台要按版本保留，所以每个版本复制一份带版本号的文件。
 */
export function publishVideo(file: string, token: string, version: number): string {
  const videosDir = join(process.cwd(), "public", "videos");
  mkdirSync(videosDir, { recursive: true });
  const target = join(videosDir, `huashu-${token}-v${version}.mp4`);
  copyFileSync(file, target);
  return `/videos/huashu-${token}-v${version}.mp4`;
}

/**
 * 首次出片的 DSH 指令。
 *
 * 几条硬约束不是「建议」而是验收项：
 * - ≤20s：产品要求（prompt 里写死 20s，渲染后用 ffprobe 再验一次）
 * - 1080×1920 竖版
 * - 不提问：DSH 是无头会话，问问题等于卡死
 * - 必须 om check 0 error
 * - 不联网找素材：素材只认 materials/（产品网站已由 om grab 抓下来）
 */
export function buildFilmPrompt(input: {
  productName: string;
  siteUrl: string | null;
  dir: string;
  imageCount: number;
  materialSummary: string;
}): string {
  const lines = [
    "你是 huashu-motion 的导演。请直接完成一支商业级产品动效片，不要向我提问，不要等我确认。",
    "",
    `1. 先完整阅读 ${join(huashuRoot(), "skills", "huashu-motion", "SKILL.md")} 与同目录 references/director.md、references/rhythm.md、references/library/README.md，严格按里面的创作方法执行。`,
    `2. 项目目录：${input.dir}（已用 om new 初始化；素材在 ${join(input.dir, "materials")}）。`,
    `3. 产品名称：${input.productName || "（未填写，按素材自行概括）"}`,
    input.siteUrl ? `4. 产品网站：${input.siteUrl}（已由 om grab 抓下真实截图/logo/配色/字体）` : "4. 产品网站：无（本片只依据参考图与产品名称创作）",
    input.imageCount > 0 ? `5. 参考图：${input.imageCount} 张，已放在 materials/，必须真实使用，不要用占位图。` : "5. 参考图：无。",
    input.materialSummary ? `6. 已抓到的素材清单（供你判断用什么）：\n${input.materialSummary}` : "",
    "",
    "硬约束（验收项，违反即失败）：",
    "- 成片时长必须 ≤ 20 秒（按 20s 设计节奏，不要做 30s）。",
    "- 画布 1080×1920 竖版。",
    "- 第 0 帧就是海报帧：主体已在画面里，不能是空帧/黑帧。",
    "- 只允许使用 materials/ 里的真实素材；不要联网找图，不要画占位框。",
    "- 帧率 30fps；动画只用 transform（x/y/scale/rotation），禁止 left/top/width 布局动画。",
    "- 完成前必须运行 om check 且 0 error；必要时 om still 抽帧自查文字是否被裁切/遮挡。",
    "- 不要运行 om studio、不要 om render（渲染由平台统一执行，避免并发抢 Chrome）。",
    "",
    "交付：项目根目录只留一个 index.html；treatment.md 写清方向选择与节奏。完成后用一句话说明你做了什么方向的片子。"
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/**
 * Studio 评论的修改指令。
 *
 * 刻意要求「先看再看」：om look 会给那一帧和点选区域的放大图，
 * DSH 必须先看这两张图再改，避免按文字猜。
 */
export function buildEditPrompt(input: {
  dir: string;
  comment: MotionComment;
  lookOutput: string;
}): string {
  return [
    "你在修改一支已经完成的 huashu-motion 片子，只改用户点出来的那一处，不要重做整片。",
    "",
    `项目目录：${input.dir}`,
    `评论 id：${input.comment.id}`,
    input.comment.t != null ? `时间点：${input.comment.t.toFixed(2)}s` : "",
    input.comment.target ? `点中的元素：${input.comment.target}` : "",
    `用户原话：${input.comment.text}`,
    "",
    "帧图已由 om look 生成（先打开看，不要跳过）：",
    input.lookOutput,
    "",
    "要求：",
    "- 先看 frame.png（那一帧整体）和 zoom.png（点中区域特写），确认用户指的是什么。",
    "- 只改 index.html 里对应的那一处；不要顺手改别的场景、不要换整体风格。",
    "- 改完保持 1080×1920、总时长 ≤20s、只用 transform 动画。",
    "- 改完运行 om check，0 error 才算完成；不要运行 om render。",
    "- 最后用一句话说明改了什么。"
  ]
    .filter(Boolean)
    .join("\n");
}

/** 素材清单摘要：给 DSH 一个「有什么可用」的短列表，避免它去翻整个目录。 */
export function summarizeMaterials(dir: string, limit = 24): string {
  const materials = join(dir, "materials");
  if (!existsSync(materials)) return "";
  try {
    return readdirSync(materials)
      .slice(0, limit)
      .map((name) => `  - materials/${name}`)
      .join("\n");
  } catch {
    return "";
  }
}
