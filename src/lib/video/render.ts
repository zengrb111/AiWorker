/**
 * Remotion 渲染层。
 *
 * 职责：把「素材 + 分镜」变成一条 1080x1920 的 mp4。具体包括
 * ① 把素材复制进 Remotion 的 public 目录（staticFile 只能读 public 下的文件）
 * ② 落 props.json（必须是 UTF-8 无 BOM，否则 Remotion 的 JSON.parse 直接失败）
 * ③ 起 Remotion CLI 渲染
 * ④ 渲染结束清理临时素材 —— 失败时保留，便于排查
 *
 * 两个必须记住的坑（都已在下方代码注释里标出）：
 * - `--props` 必须写成 `--props=<绝对路径>` 等号形式；空格分隔在 Windows 会被拆错。
 * - 渲染子进程必须清空 NODE_OPTIONS：CodeBuddy 的 safe-delete shim 通过它注入，
 *   会让 Remotion 内部批量删除临时目录崩溃。
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { readIntEnv, readPositiveNumberEnv, readStringEnv } from "../env";
import type { ClipStoryboard, Storyboard } from "./storyboard";

/** 三个竖版合成，与 remotion/src/Root.tsx 的注册 id 一一对应。 */
export type VerticalCompositionId = "VerticalStoryboard" | "VerticalMontage" | "VerticalRemake";

/** Remotion 工程入口。 */
const ENTRY_POINT = join("remotion", "src", "index.tsx");

/** Remotion 的 public 目录（staticFile 的根）。 */
const REMOTION_PUBLIC_DIR = join(process.cwd(), "remotion", "public");

/** 每次渲染的素材与 props 落在这里，结束后清理。 */
const GENERATED_ROOT = join(REMOTION_PUBLIC_DIR, "generated");

/** 成片输出目录（Next 的 public/videos，落库与内容库依赖这个路径约定）。 */
const VIDEO_OUT_DIR = join(process.cwd(), "public", "videos");

/**
 * 渲染默认超时 900s。渲染是重任务，不能和 DSH 分镜（180s）共用常量。
 * 一条 30 秒竖版成片在本机大约 2~5 分钟。
 */
const DEFAULT_RENDER_TIMEOUT_MS = 900_000;

/* -------------------------------------------------------------------------- */
/* 并发闸门                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 信号量式并发闸门。
 *
 * 渲染是 CPU + 内存密集型（每条起一个无头 Chromium），四条链路加上后台批量出片
 * 可能同时触发。不设闸门会互相抢资源，表现为「全都变慢且可能 OOM」，比排队更难查。
 */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolveWait) => this.waiting.push(resolveWait));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }

  get inFlight(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiting.length;
  }
}

function renderConcurrency(): number {
  return readIntEnv("REMOTION_MAX_CONCURRENCY", 2);
}

/** 全进程共用一个闸门。 */
const gate = new Semaphore(renderConcurrency());

/* -------------------------------------------------------------------------- */
/* 素材与 props                                                                */
/* -------------------------------------------------------------------------- */

export type MaterialKind = "image" | "video";

export type Material = {
  /** 本机绝对路径。 */
  absolutePath: string;
  kind: MaterialKind;
};

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);

/** 依扩展名判定素材类型；无法识别时按图片处理（图片分支更宽容）。 */
export function classifyMaterial(absolutePath: string): MaterialKind {
  const ext = extname(absolutePath).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  return "image";
}

/** 归一化调用方给的素材列表：过滤不存在项、判定类型、去重。 */
export function normalizeMaterials(paths: string[]): Material[] {
  const seen = new Set<string>();
  const out: Material[] = [];
  for (const raw of paths) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const abs = resolve(raw.trim());
    if (seen.has(abs)) continue;
    if (!existsSync(abs)) continue;
    seen.add(abs);
    out.push({ absolutePath: abs, kind: classifyMaterial(abs) });
  }
  return out;
}

/**
 * 把素材复制进 Remotion 的 public 目录，返回相对 public 的路径。
 *
 * 必须复制而不是直接引用：Remotion 渲染时只能通过 staticFile() 读 public 下的文件，
 * 而原始素材可能散落在 uploads/、临时目录或用户本机别处。
 */
export function materializeAssets(
  materials: Material[],
  workDirAbs: string,
): { relativePath: string; absolutePath: string }[] {
  mkdirSync(workDirAbs, { recursive: true });
  return materials.map((material, i) => {
    const name = `${String(i + 1).padStart(2, "0")}${extname(material.absolutePath).toLowerCase() || ".bin"}`;
    const dest = join(workDirAbs, name);
    copyFileSync(material.absolutePath, dest);
    // 用 posix 分隔符：staticFile() 在 URL 语境下不接受反斜杠
    const relativePath = `generated/${workDirAbs.split(/[\\/]/).pop()}/${name}`;
    return { relativePath, absolutePath: dest };
  });
}

/**
 * 写 props.json。
 *
 * 必须无 BOM：Remotion 侧是 `JSON.parse(fs.readFileSync(...))`，Node 的 readFileSync
 * 不会自动去掉 UTF-8 BOM，于是带 BOM 的文件会报
 * "Unexpected token '\uFEFF'" 且提示信息极具误导性（说成"不是合法 JSON"）。
 * 这里用 fs.writeFileSync + "utf8"，它不写 BOM。
 */
export function writeProps(workDirAbs: string, payload: { storyboard: Storyboard | ClipStoryboard }): string {
  mkdirSync(workDirAbs, { recursive: true });
  const propsPath = join(workDirAbs, "storyboard.json");
  writeFileSync(propsPath, JSON.stringify(payload, null, 2), "utf8");
  return propsPath;
}

/** 把分镜里的素材路径重写为本次复制后的相对路径。 */
export function bindStoryboardPaths<T extends Storyboard | ClipStoryboard>(
  storyboard: T,
  bound: { relativePath: string }[],
): T {
  if ("scenes" in storyboard) {
    const sb = storyboard as Storyboard;
    // 兜底分镜里 images 只有一个空串（无素材时），过滤掉避免渲染时加载空 src
    const pool = bound.map((b) => b.relativePath);
    let cursor = 0;
    return {
      ...sb,
      scenes: sb.scenes.map((scene) => {
        const images = scene.images
          .map((img) => {
            if (!img) return null;
            // 模型可能给了不在清单里的路径（幻觉），统一替换成本次真实素材
            const known = pool.includes(img) ? img : pool[cursor % pool.length];
            cursor++;
            return known;
          })
          .filter((x): x is string => Boolean(x));
        return { ...scene, images: images.length ? images : [pool[0]].filter(Boolean) };
      }),
    } as T;
  }
  const sb = storyboard as ClipStoryboard;
  const pool = bound.map((b) => b.relativePath);
  return {
    ...sb,
    clips: sb.clips.map((clip, i) => ({
      ...clip,
      src: pool.includes(clip.src) ? clip.src : pool[i % pool.length],
    })),
  } as T;
}

/* -------------------------------------------------------------------------- */
/* 渲染                                                                        */
/* -------------------------------------------------------------------------- */

export type RenderOptions = {
  compositionId: VerticalCompositionId;
  /** 已校验并绑定好素材路径的分镜。 */
  storyboard: Storyboard | ClipStoryboard;
  /** 本次渲染的唯一标识，决定临时目录名。 */
  token: string;
  /** 原始素材（绝对路径）。 */
  materials: Material[];
  /** 成片输出绝对路径；不给则按约定写到 public/videos/render-<token>.mp4。 */
  outputPath?: string;
  onProgress?: (text: string) => void;
  timeoutMs?: number;
};

export type RenderResult = {
  ok: boolean;
  outputPath: string;
  /** 失败原因 / 耗时等，供 UI 与日志定位。 */
  detail: string;
  elapsedMs: number;
  /** 渲染用的临时目录；失败时保留。 */
  workDir: string;
};

function resolveRemotionCli(): string {
  return join(process.cwd(), "node_modules", "@remotion", "cli", "remotion-cli.js");
}

/**
 * 复用本机已装的 Chrome/Edge，避免 `npx remotion browser ensure` 的数百 MB 下载。
 * 未配置时交回 Remotion 自己的默认行为。
 *
 * 返回普通 Record 而非 NodeJS.ProcessEnv：项目在 next-env 里把 NODE_ENV 声明成必填，
 * 局部字典类型不必跟着背这个约束。
 */
function browserEnv(): Record<string, string> {
  const exe = readStringEnv("REMOTION_BROWSER_EXECUTABLE");
  return exe ? { REMOTION_BROWSER_EXECUTABLE: exe } : {};
}

/** 渲染一条视频。永不抛错，失败信息在 detail 里。 */
export async function renderVertical(options: RenderOptions): Promise<RenderResult> {
  const started = Date.now();
  const workDirName = `render-${options.token}`;
  const workDirAbs = join(GENERATED_ROOT, workDirName);
  const outputPath = options.outputPath || join(VIDEO_OUT_DIR, `${workDirName}.mp4`);
  const timeoutMs = options.timeoutMs ?? readPositiveNumberEnv("REMOTION_RENDER_TIMEOUT_MS", DEFAULT_RENDER_TIMEOUT_MS);

  const finish = (ok: boolean, detail: string): RenderResult => {
    // 成功才清理；失败保留现场，否则出问题只能靠猜
    if (ok) rmSync(workDirAbs, { recursive: true, force: true });
    return { ok, outputPath, detail, elapsedMs: Date.now() - started, workDir: workDirAbs };
  };

  try {
    if (!existsSync(join(process.cwd(), ENTRY_POINT))) {
      return finish(false, `找不到 Remotion 入口：${ENTRY_POINT}`);
    }
    const cli = resolveRemotionCli();
    if (!existsSync(cli)) {
      return finish(false, "找不到 @remotion/cli，请先执行 npm install");
    }

    const materials = options.materials.length ? options.materials : normalizeMaterials([]);
    if (materials.length === 0) {
      return finish(false, "没有可用素材，无法渲染");
    }

    mkdirSync(VIDEO_OUT_DIR, { recursive: true });
    const bound = materializeAssets(materials, workDirAbs);
    const storyboard = bindStoryboardPaths(options.storyboard, bound);
    const propsPath = writeProps(workDirAbs, { storyboard });

    await gate.acquire();
    options.onProgress?.(
      gate.queued > 0
        ? `渲染排队中（前面还有 ${gate.queued} 条）...`
        : "正在渲染竖版成片...",
    );

    let result: { code: number; stdout: string; stderr: string; timedOut: boolean };
    try {
      result = await runCli([cli, "render", ENTRY_POINT, options.compositionId, outputPath, `--props=${propsPath}`], timeoutMs, browserEnv());
    } finally {
      gate.release();
    }

    if (result.timedOut) {
      return finish(false, `渲染超时（${Math.round(timeoutMs / 1000)}s）。临时素材保留在 ${workDirAbs}`);
    }
    if (result.code !== 0 || !existsSync(outputPath)) {
      return finish(false, `渲染失败（退出码 ${result.code}）。素材保留在 ${workDirAbs}\n${tail(result.stderr)}`);
    }
    return finish(true, `渲染完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    return finish(false, `渲染异常：${(err as Error).message}`);
  }
}

/** 取 stderr 尾部，Remotion 的报错都在末尾。 */
function tail(text: string, lines = 15): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-lines)
    .join("\n");
}

function runCli(
  argv: string[],
  timeoutMs: number,
  extraEnv: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveRun, rejectRun) => {
    // 用 node 直接跑 CLI 的 js 入口，不经过 npx.cmd：
    // npx.cmd 在 Windows 上会重写引号，把 --props=<含反斜杠的绝对路径> 拆成两段参数。
    const child = spawn(process.execPath, argv, {
      cwd: process.cwd(),
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        ...extraEnv,
        NODE_OPTIONS: "",
        NO_COLOR: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolveRun({ code: -1, stdout, stderr: `${stderr}\n渲染超时`, timedOut: true });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code: code ?? -1, stdout, stderr, timedOut: false });
    });
  });
}

/** 只渲当前引擎状态，供 /api 健康检查与前端提示使用。 */
export function renderEngineInfo(): { concurrency: number; inFlight: number; queued: number } {
  return { concurrency: renderConcurrency(), inFlight: gate.inFlight, queued: gate.queued };
}
