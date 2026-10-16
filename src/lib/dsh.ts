/**
 * DSH（DeepSeek Harness）规划客户端。
 *
 * 唯一职责：把一段 prompt 交给 DSH，取回一段纯文本。仅此而已 —— 不渲染、不写文件、
 * 不做编排。分镜 JSON 的解析/校验/兜底在 src/lib/video/storyboard.ts，
 * 渲染在 remotion/ 工程。
 *
 * 通过一次性 Python 子进程调用官方 SDK：Node 侧没有等价实现，且子进程能把
 * SDK 的依赖与全局状态隔离在本项目之外。协议见 scripts/dsh-storyboard/main.py。
 */

import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDshPython } from "./python";
import { readPositiveNumberEnv, readStringEnv } from "./env";

/** 分镜是纯文本任务，180s 足够；与渲染的 900s 是两码事，不要混用。 */
const DEFAULT_TIMEOUT_MS = 180_000;

/** Python 冷启动（含 SDK 插件加载）预算，计入总超时之外。 */
const STARTUP_GRACE_MS = 30_000;

export type DshStatus = { ok: true; python: string; model: string } | { ok: false; reason: string };

/** DSH 可用性缓存：探测一次即可，缺 key 属于部署配置问题，不会自己变好。 */
let availability: DshStatus | null = null;

/**
 * DSH_HOME 目录。允许在 .env.local 里写相对路径（如 `.dsh-home`），
 * 这里统一按项目根解析 —— 子进程的 cwd 可能与 Next 进程不同，
 * 直接 mkdir 一个相对路径会散落到别处。
 */
function dshHomeDir(): string {
  const configured = readStringEnv("DSH_HOME");
  return configured ? resolve(process.cwd(), configured) : join(process.cwd(), ".dsh-home");
}

function bridgeDir(): string {
  return join(process.cwd(), "scripts", "dsh-storyboard");
}

/**
 * 受限 profile 覆盖层的绝对路径。
 *
 * 真实机制（已对 deepseek-harness-sdk 0.1.5rc1 核对）：SDK 只支持
 * `profile` + `patches`，等价于命令行 `dsh --profile sdk --patch <path>`。
 * 官方 sdk profile 自带 tool-bash / tool-pwsh / tool-fs / tool-web / subagent
 * 等一整套工具，必须靠这个覆盖层逐个 disabled。
 */
function profilePatchPath(): string {
  return join(bridgeDir(), "profile", "cordis.patch.yml");
}

function readEnv(name: string): string {
  return readStringEnv(name);
}

/**
 * DSH 是否可用（缺 key / 找不到合格 Python 时给出可读原因）。
 * 结果会缓存，避免每次出片都重复探测。
 */
export async function getDshStatus(): Promise<DshStatus> {
  if (availability) return availability;

  if (!readEnv("DEEPSEEK_API_KEY")) {
    availability = {
      ok: false,
      reason:
        "未配置 DEEPSEEK_API_KEY，分镜规划将使用确定性兜底分镜。请在 .env.local 中设置后重启。",
    };
    return availability;
  }

  try {
    const python = await resolveDshPython();
    availability = { ok: true, python, model: readEnv("DSH_MODEL") || "(SDK 默认)" };
    return availability;
  } catch (err) {
    availability = { ok: false, reason: (err as Error).message };
    return availability;
  }
}

/** 复位可用性缓存（改了环境变量后可调用，主要给测试用）。 */
export function resetDshStatusCache(): void {
  availability = null;
}

/**
 * 把受限 profile 布置到 $DSH_HOME/profiles/storyboard/cordis.patch.yml。
 *
 * 必须在每次调用前做：DSH 的 HOME 目录可能被用户清掉，也可能被升级改写，
 * 幂等覆盖比判断文件是否存在更可靠。
 */
function ensureProfile(dshHome: string): void {
  const target = join(dshHome, "profiles", "storyboard");
  mkdirSync(target, { recursive: true });
  copyFileSync(join(bridgeDir(), "profile", "cordis.patch.yml"), join(target, "cordis.patch.yml"));
}

/** 子进程 stderr 的尾部，出错时带给调用方便于定位。 */
function tail(text: string, lines = 20): string {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}

/** 短随机后缀，让每次 DSH 调用的 session id 唯一（DSH session 有状态，重复 id 会报错）。 */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * 规整 session id 为 ASCII 标识符。
 *
 * DSH 的 session id 只接受 [A-Za-z0-9_-]，而调用方常把业务标识拼进来 ——
 * 早期 prepare 直接用 `prepare-${topic}`，topic 是用户输入的中文热点名，
 * 于是 session_id 里带上了中文，DSH 拒绝受理，降级路径直接失效。
 * 这里统一替换非 ASCII 字符，而不是要求每个调用方自己约束。
 */
function sanitizeSessionId(raw: string): string {
  const safe = raw
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  // 全是需被替换字符时（如纯中文）会清空，给个保底前缀保证非空
  return safe || "dsh";
}

export type DshRunOptions = {
  prompt: string;
  /**
   * session id 前缀，便于在 DSH 侧按任务排查。
   * 实际会追加随机后缀 —— DSH 的 session 是有状态的，重复 id 会报
   * "session already exists"，而分镜的两轮尝试本就不该共享上下文
   * （重试的 prompt 已把校验错误完整回喂，自带足够信息）。
   */
  sessionId?: string | null;
  /** 覆盖默认超时（毫秒）。 */
  timeoutMs?: number;
  /** 隔离工作目录；不给则用系统临时目录下的固定子目录。 */
  workspaceDir?: string;
};

/**
 * 跑一次 DSH，返回最终文本。
 *
 * 任何失败（不可用 / 超时 / 崩溃 / 输出非法）都抛异常，调用方
 * （storyboard.planStoryboard）会转成兜底分镜，不会让出片失败。
 */
export async function runDshText(options: DshRunOptions): Promise<string> {
  const status = await getDshStatus();
  if (!status.ok) throw new Error(status.reason);

  const dshHome = dshHomeDir();
  const workspaceDir = options.workspaceDir || join(dshHome, "workspace", "storyboard");
  const timeoutMs = options.timeoutMs ?? readPositiveNumberEnv("DSH_STORYBOARD_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  mkdirSync(dshHome, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  ensureProfile(dshHome);

  const request = {
    prompt: options.prompt,
    // 每次调用都用独立 session：DSH 的 session 是有状态的，重复 id 会报
    // "session already exists"。分镜的两轮尝试本就不该共享上下文 ——
    // 重试的 prompt 已把校验错误完整回喂，自带足够信息。
    // id 统一经 sanitize：调用方拼进来的可能是中文等非 ASCII 字符。
    session_id: options.sessionId
      ? `${sanitizeSessionId(options.sessionId)}-${randomSuffix()}`
      : null,
    cwd: workspaceDir,
    dsh_home: dshHome,
    // 受限 profile：SDK 只接受 --profile + --patch 两种覆盖方式，
    // patch 是幂等的，不依赖 $DSH_HOME 里的残留状态
    patch: profilePatchPath(),
    model: readEnv("DSH_MODEL") || null,
    timeout_ms: timeoutMs,
  };

  // stdin 直接管道传参，不落临时文件：避免并发调用互相覆盖，也不用清理
  const stdout = await runBridge(status.python, request, timeoutMs + STARTUP_GRACE_MS, dshHome);

  let parsed: { ok?: boolean; final_response?: string; error?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `DSH 桥接脚本返回的不是合法 JSON。原始输出（尾部）：\n${tail(stdout)}`,
    );
  }
  if (!parsed.ok) {
    throw new Error(`DSH 调用失败：${parsed.error || "未知原因"}`);
  }
  const text = (parsed.final_response ?? "").trim();
  if (!text) throw new Error("DSH 返回了空内容");
  return text;
}

function runBridge(
  python: string,
  request: unknown,
  timeoutMs: number,
  dshHome: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(python, [join(bridgeDir(), "main.py")], {
      cwd: process.cwd(),
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: readEnv("DEEPSEEK_API_KEY"),
        DEEPSEEK_BASE_URL: readEnv("DEEPSEEK_BASE_URL") || undefined,
        DSH_HOME: dshHome,
        NO_COLOR: "1",
        // CodeBuddy 的 safe-delete shim 会通过 NODE_OPTIONS 注入，
        // Python 不需要它，显式清掉避免被子进程继承后干扰 SDK
        NODE_OPTIONS: "",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });

    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`DSH 超时（${Math.round(timeoutMs / 1000)}s）。stderr 尾部：\n${tail(err)}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 DSH 桥接脚本（${python}）：${e.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && out.trim() === "") {
        reject(new Error(`DSH 桥接脚本异常退出（code=${code}）。stderr 尾部：\n${tail(err)}`));
        return;
      }
      resolve(out);
    });

    child.stdin.end(JSON.stringify(request));
  });
}

/**
 * 首次安装自检：确认 SDK 能 import、profile 到位。
 * 供 scripts/dsh-storyboard 自检与问题排查使用，不参与出片主流程。
 */
export async function selfCheck(): Promise<{ ok: boolean; detail: string }> {
  const status = await getDshStatus();
  if (!status.ok) return { ok: false, detail: status.reason };

  const dshHome = dshHomeDir();
  mkdirSync(dshHome, { recursive: true });
  ensureProfile(dshHome);

  const marker = join(dshHome, "profile-installed.json");
  writeFileSync(
    marker,
    JSON.stringify({ python: status.python, model: status.model, dshHome }, null, 2),
    "utf8",
  );

  return {
    ok: true,
    detail: [
      `Python：${status.python}`,
      `DSH_HOME：${dshHome}`,
      `profile：${join(dshHome, "profiles", "storyboard", "cordis.patch.yml")}`,
      `模型：${status.model}`,
    ].join("\n"),
  };
}
