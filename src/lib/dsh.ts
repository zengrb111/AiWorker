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
import { resolveCapabilityConfig, type ResolvedModelConfig } from "./model-credentials";

/**
 * 分镜规划的模型配置归属用户：能力 = storyboard。
 * DSH 是 spawn 出来的子进程（无法注入 HTTP 头），所以用「独立 DSH_HOME + env 注入密钥」
 * 的方式做隔离：不同用户的 profile / cache / workspace 互不串号。
 */
const DSH_CAPABILITY = "storyboard" as const;

/** 分镜是纯文本任务，180s 足够；与渲染的 900s 是两码事，不要混用。 */
const DEFAULT_TIMEOUT_MS = 180_000;

/** 渲染（含 Remotion + ffmpeg 后期）是重任务，900s 起步；与分镜的 180s 是两码事。 */
const RENDER_TIMEOUT_MS = 900_000;

/** DSH 受限 profile 的种类：storyboard=分镜规划（禁 bash/fs），render=出片（放开 bash/fs）。 */
type DshProfileName = "storyboard" | "render";

/** Python 冷启动（含 SDK 插件加载）预算，计入总超时之外。 */
const STARTUP_GRACE_MS = 30_000;

/**
 * 本项目核对过的 DSH SDK 版本。
 *
 * **这是一个「已知可用」的基线，不是「要求安装」的约束** ——
 * 上游随时会发新版（截至 2026-10-17 上游已到 0.2.1-rc.2，而 PyPI 上的
 * Python SDK 仍停在 0.1.5rc1），所以 requirements.txt 用的是 `>=0.1.0`。
 *
 * 那为什么不干脆总是跟最新版走？因为我们的受限 profile 是**按插件 id逐个
 * disabled** 的（scripts/dsh-storyboard/profile/cordis.patch.yml）。
 * 上游 0.2.x 改了默认 SDK profile 的身份与插件集合，id 一旦对不上，
 * patch 会**静默不生效** —— 一个跑在服务端、能读写文件系统的 Agent
 * 悄悄拿回 bash 权限，比出片失败严重得多，而且不会报任何错。
 *
 * 所以策略是：**允许版本漂移，但漂移必须被主动看见**。
 * 版本一旦与本基线不同，就生成一条人话提醒写进方案诊断与前端提示，
 * 让人去复核 patch，而不是等出片或出安全问题后才发现。
 */
const DSH_KNOWN_GOOD_SDK = "0.1.5rc1";

export type DshStatus =
  | {
      ok: true;
      python: string;
      model: string;
      /** deepseek-harness-sdk 版本；探测失败时为 undefined。 */
      sdkVersion?: string;
      /** deepseek-harness-runtime-bin 版本；探测失败时为 undefined。 */
      runtimeVersion?: string;
    }
  | { ok: false; reason: string };

/** DSH 可用性缓存：**按用户**缓存，避免每个用户重复探测，也避免 A 用户的结论污染 B 用户。 */
const availability = new Map<string, DshStatus>();

/**
 * 读两个 DSH 包的安装版本。
 *
 * 刻意用 `importlib.metadata` 而不是 `deepseek_harness.__version__`：
 * 后者在某些版本里并不存在，import 成功但取属性会抛 AttributeError，
 * 而我们只想在排障时多一行版本号，不该因此让 DSH 探测失败。
 */
const VERSION_PROBE = [
  "import importlib.metadata as m, json",
  "def v(n):",
  "    try:",
  "        return m.version(n)",
  "    except Exception:",
  "        return None",
  'print(json.dumps({"sdk": v("deepseek-harness-sdk"), "runtime": v("deepseek-harness-runtime-bin")}))',
].join("\n");

/**
 * 版本探测的结果缓存。
 *
 * 这是**机器级**属性（同一个解释器装了什么版本），与用户无关，
 * 所以不进上面的按用户缓存 —— 否则 N 个用户就要 spawn N 次 Python。
 */
let versionProbe: Promise<{ sdkVersion?: string; runtimeVersion?: string }> | null = null;

async function probeVersions(python: string): Promise<{ sdkVersion?: string; runtimeVersion?: string }> {
  if (!versionProbe) {
    versionProbe = (async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      try {
        const { stdout } = await run(python, ["-c", VERSION_PROBE], {
          timeout: 20_000,
          windowsHide: true,
        });
        const parsed = JSON.parse(String(stdout).trim()) as { sdk?: string | null; runtime?: string | null };
        return {
          ...(parsed.sdk ? { sdkVersion: parsed.sdk } : {}),
          ...(parsed.runtime ? { runtimeVersion: parsed.runtime } : {}),
        };
      } catch {
        // 探测失败**绝不影响可用性判断**：它只是给人看的版本号。
        return {};
      }
    })();
  }
  return versionProbe;
}

/**
 * 版本是否值得提醒。
 *
 * 只在两种情况下出声，版本一致时保持安静 —— 一个天天弹「SDK 版本正常」的
 * 提示条，久了就没人看了，那才是真正的失效。
 *
 * 刻意做成「给版本号就算」的纯函数：判断逻辑不藏在探测里，
 * 才能被单独验证（否则永远走不到分支，等于没写）。
 */
function describeVersion(versions: {
  sdkVersion?: string;
  runtimeVersion?: string;
}): string | undefined {
  const { sdkVersion, runtimeVersion } = versions;
  const notes: string[] = [];

  // ① SDK 与运行时二进制不同版本 —— 这正是之前 DSH Web 前端报
  //    「Failed to load plugins」的根因（host 代码与自带前端包版本错配）。
  //    放到出片链路上同样致命：插件清单对不上，受限 profile 直接失效。
  if (sdkVersion && runtimeVersion && sdkVersion !== runtimeVersion) {
    notes.push(
      `DeepSeek SDK（${sdkVersion}）与运行时二进制（${runtimeVersion}）版本不一致，插件清单可能对不上，` +
        `受限 profile 有可能静默失效。`,
    );
  }

  // ② 与本项目核对过的基线不同
  if (sdkVersion && sdkVersion !== DSH_KNOWN_GOOD_SDK) {
    notes.push(
      `DeepSeek 分镜 SDK 为 ${sdkVersion}，与本项目核对过的 ${DSH_KNOWN_GOOD_SDK} 不同；` +
        `上游改动过默认 profile 的插件集合，请复核 scripts/dsh-storyboard/profile/cordis.patch.yml 是否仍然对得上。`,
    );
  }

  return notes.length ? notes.join(" ") : undefined;
}

/**
 * 把版本自检结果整理成可直接摊进 diagnostics 的两个字段。
 *
 * 单独抽出来是因为出片链路有**多条**入口会填诊断（generate / montage / remake，
 * 加上各自的 resume），复制粘贴字段名迟早会漏一处 —— 漏一处就意味着那条链路
 * 永远不会提示版本漂移，正是这个函数要防的事。
 *
 * DSH 不可用时返回空对象：那时该看的是 dshReason，不是版本。
 */
export function describeDshVersion(
  status: DshStatus
): { dshVersion?: string; dshVersionNote?: string } {
  if (!status.ok) return {};
  const versions = { sdkVersion: status.sdkVersion, runtimeVersion: status.runtimeVersion };
  const parts = [
    status.sdkVersion ? `SDK ${status.sdkVersion}` : null,
    status.runtimeVersion ? `运行时 ${status.runtimeVersion}` : null,
  ].filter(Boolean);
  const note = describeVersion(versions);
  return {
    ...(parts.length ? { dshVersion: parts.join(" · ") } : {}),
    ...(note ? { dshVersionNote: note } : {}),
  };
}

/**
 * DSH_HOME 目录。允许在 .env.local 里写相对路径（如 `.dsh-home`），
 * 这里统一按项目根解析 —— 子进程的 cwd 可能与 Next 进程不同，
 * 直接 mkdir 一个相对路径会散落到别处。
 *
 * 按 userId 派生二级目录：DSH 会在 HOME 下写 profile / cache / session，
 * 共用同一个目录会让多用户的分镜上下文与缓存串号。
 */
function dshHomeDir(userId?: string): string {
  const configured = readStringEnv("DSH_HOME");
  const root = configured ? resolve(process.cwd(), configured) : join(process.cwd(), ".dsh-home");
  const safeUser = (userId ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "-");
  return safeUser ? join(root, safeUser) : root;
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
 *
 * ⚠ 文件名注意：分镜 profile 的历史文件名是 **`cordis.patch.yml`**（不带 storyboard 后缀），
 * 出片 profile 是 `cordis-render.patch.yml`。**不要**把 storyboard 也拼成
 * `cordis-storyboard.patch.yml` —— 文件不存在，ensureProfile 会 ENOENT，
 * 于是 DSH 分镜静默回退到兜底分镜（2026-10-19 踩过）。
 */
function profilePatchPath(name: DshProfileName = "storyboard"): string {
  const file = name === "storyboard" ? "cordis.patch.yml" : `cordis-${name}.patch.yml`;
  return join(bridgeDir(), "profile", file);
}

function readEnv(name: string): string {
  return readStringEnv(name);
}

/** 取该用户为「分镜规划」配置的模型服务；未配置返回 null。 */
async function resolveStoryboardCredential(
  userId?: string
): Promise<ResolvedModelConfig | null> {
  if (!userId) return null;
  return resolveCapabilityConfig(userId, DSH_CAPABILITY).catch(() => null);
}

/**
 * DSH 是否可用（缺配置 / 找不到合格 Python 时给出可读原因）。
 * 结果按用户缓存，避免每次出片都重复探测。
 */
export async function getDshStatus(userId?: string): Promise<DshStatus> {
  const cacheKey = userId ?? "";
  const cached = availability.get(cacheKey);
  if (cached) return cached;

  /*
   * 不可用结果**不缓存**：缺配置、python 缺失这类「状态会变」的失败，
   * 一旦用户在「系统配置」里补完 key 或装好环境，下一次请求就该立刻可用。
   * 否则缓存的 ok:false 会让「配完还得重启服务」的怪现象反复出现。
   * 只缓存 ok:true（已验证过的环境，避免每次出片都重复探测 python/SDK 版本）。
   */
  const credential = await resolveStoryboardCredential(userId);
  if (!credential?.apiKey) {
    return {
      ok: false,
      reason: userId
        ? "尚未配置「分镜规划」模型服务，分镜将使用确定性兜底分镜。请在「系统配置」中指定并填写 API Key。"
        : "缺少登录用户，无法确定分镜规划使用的模型服务。",
    };
  }

  try {
    const python = await resolveDshPython();
    // 版本自检：读一下装了什么版本，与已知可用基线比对。
// 探测失败不影响可用性 —— 它只是给人看的一行字。
    const versions = await probeVersions(python);
    const status: DshStatus = {
      ok: true,
      python,
      model: credential.model || readEnv("DSH_MODEL") || "(SDK 默认)",
      ...versions,
    };
    availability.set(cacheKey, status);
    return status;
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** 复位可用性缓存（改了配置后可调用，主要给测试用）。 */
export function resetDshStatusCache(): void {
  availability.clear();
  versionProbe = null;
}

/**
 * 把受限 profile 布置到 $DSH_HOME/profiles/<name>/cordis.patch.yml。
 *
 * 必须在每次调用前做：DSH 的 HOME 目录可能被用户清掉，也可能被升级改写，
 * 幂等覆盖比判断文件是否存在更可靠。
 */
function ensureProfile(dshHome: string, name: DshProfileName = "storyboard"): void {
  const target = join(dshHome, "profiles", name);
  mkdirSync(target, { recursive: true });
  copyFileSync(profilePatchPath(name), join(target, "cordis.patch.yml"));
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
  /** 归属用户：决定用哪份密钥与哪个 DSH_HOME。 */
  userId?: string;
  /**
   * session id 前缀，便于在 DSH 侧按任务排查。
   * 实际会追加随机后缀 —— DSH 的 session 是有状态的，重复 id 会报
   * "session already exists"，而分镜的两轮尝试本就不该共享上下文
   * （重试的 prompt 已把校验错误完整回喂，自带足够信息）。
   */
  sessionId?: string | null;
  /** 覆盖默认超时（毫秒）。 */
  timeoutMs?: number;
  /** 隔离工作目录；不给则用该用户 DSH_HOME 下的固定子目录。 */
  workspaceDir?: string;
};

/**
 * 跑一次 DSH，返回最终文本。
 *
 * 任何失败（不可用 / 超时 / 崩溃 / 输出非法）都抛异常，调用方
 * （storyboard.planStoryboard）会转成兜底分镜，不会让出片失败。
 */
export async function runDshText(options: DshRunOptions): Promise<string> {
  const status = await getDshStatus(options.userId);
  if (!status.ok) throw new Error(status.reason);

  const credential = await resolveStoryboardCredential(options.userId);
  if (!credential?.apiKey) {
    throw new Error("尚未配置「分镜规划」模型服务，请在「系统配置」中指定并填写 API Key。");
  }

  const dshHome = dshHomeDir(options.userId);
  const workspaceDir = options.workspaceDir || join(dshHome, "workspace", "storyboard");
  const timeoutMs = options.timeoutMs ?? readPositiveNumberEnv("DSH_STORYBOARD_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  mkdirSync(dshHome, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  ensureProfile(dshHome, "storyboard");

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
    model: credential.model || readEnv("DSH_MODEL") || null,
    timeout_ms: timeoutMs,
  };

  // stdin 直接管道传参，不落临时文件：避免并发调用互相覆盖，也不用清理
  const stdout = await runBridge(status.python, request, timeoutMs + STARTUP_GRACE_MS, dshHome, credential);

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
  credential: ResolvedModelConfig
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // DSH 运行时（deepseek-harness-sdk-runtime）会读取 HTTPS_PROXY/HTTP_PROXY
    // 并据此走代理。本机 DeepSeek API 可直接连通（无需代理），但若环境里残留了
    // 指向 127.0.0.1:7890（Clash）等「已关闭」代理的变量，运行时会因 TRANSPORT
    // 失败而拿不到任何内容 —— 表现为「DSH 未返回内容（finish_reason='completed'）」。
    // 平台其余模型调用走 Node fetch（undici 默认忽略代理、直连可用），这里让 DSH
    // 也直连，保持行为一致。仅清掉代理变量，其余环境原样继承。
    const childEnv: Record<string, string | undefined> = { ...process.env };
    for (const k of [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "https_proxy",
      "http_proxy",
      "ALL_PROXY",
      "all_proxy",
    ]) {
      delete childEnv[k];
    }
    const child = spawn(python, [join(bridgeDir(), "main.py")], {
      cwd: process.cwd(),
      windowsHide: true,
      shell: false,
      env: {
        ...childEnv,
        // 密钥来自该用户自己的「分镜规划」配置；baseUrl 缺省才回落到部署级 env。
        DEEPSEEK_API_KEY: credential.apiKey,
        DEEPSEEK_BASE_URL: credential.baseUrl || readEnv("DEEPSEEK_BASE_URL") || undefined,
        DSH_HOME: dshHome,
        NO_COLOR: "1",
        // CodeBuddy 的 safe-delete shim 会通过 NODE_OPTIONS 注入，
        // Python 不需要它，显式清掉避免被子进程继承后干扰 SDK
        NODE_OPTIONS: "",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        NODE_ENV: process.env.NODE_ENV ?? "production",
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
 * 跑一次 DSH 出片（渲染 + 后期）。
 *
 * 与 `runDshText` 的区别：用的是 **render profile**（`cordis-render.patch.yml`），
 * 它**放开 tool-bash / tool-fs**，让 DSH 能在沙箱里调用 Remotion CLI 与 ffmpeg，
 * 把成片直接写回本项目的 public/videos 目录。prompt 会命令 DSH 原样执行
 * `render-video.mjs`，脚本内部完成「Remotion 渲染 + 后期一条龙」并写结果 JSON。
 *
 * 任何失败（不可用 / 超时 / 崩溃 / 输出非法）都抛异常，调用方（pipeline）会
 * 自动回退到本地「renderVertical + video-stitch」那条已验证的路径，不会让出片失败。
 *
 * 渲染是重任务，超时默认 900s + 启动宽限；cwd 指向项目根，tool-bash 的沙箱按 cwd
 * 约束可写范围，必须让它能写到 public/videos 与 remotion/public/generated。
 */
/**
 * DSH 串行闸：同一时刻只允许一个出片/改片调用。
 *
 * 实测两个桥接并发时（定时出片 + Studio 改片），两边的会话文件都不再增长、
 * 进程活着但模型调用不返回，最后双双超时。串行化牺牲一点并行度，换确定性。
 */
let dshRenderQueue: Promise<unknown> = Promise.resolve();

function withDshRenderSlot<T>(task: () => Promise<T>): Promise<T> {
  const run = dshRenderQueue.then(task, task);
  dshRenderQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function runDshRender(
  prompt: string,
  options: { userId?: string; sessionId?: string | null; timeoutMs?: number; workspaceDir?: string } = {},
): Promise<string> {
  return withDshRenderSlot(() => runDshRenderUnlocked(prompt, options));
}

async function runDshRenderUnlocked(
  prompt: string,
  options: { userId?: string; sessionId?: string | null; timeoutMs?: number; workspaceDir?: string } = {},
): Promise<string> {
  const status = await getDshStatus(options.userId);
  if (!status.ok) throw new Error(status.reason);

  const credential = await resolveStoryboardCredential(options.userId);
  if (!credential?.apiKey) {
    throw new Error("尚未配置「分镜规划」模型服务，请在「系统配置」中指定并填写 API Key。");
  }

  const dshHome = dshHomeDir(options.userId);
  // 渲染需要在项目根目录下写 public/videos 与 remotion/public/generated，
  // 所以 cwd 指向项目根（tool-bash 的沙箱按 cwd 约束可写范围）。
  const workspaceDir = options.workspaceDir || process.cwd();
  const timeoutMs = options.timeoutMs ?? readPositiveNumberEnv("DSH_RENDER_TIMEOUT_MS", RENDER_TIMEOUT_MS);

  mkdirSync(dshHome, { recursive: true });
  ensureProfile(dshHome, "render");

  const request = {
    prompt: prompt.trim(),
    session_id: options.sessionId
      ? `${sanitizeSessionId(options.sessionId)}-${randomSuffix()}`
      : null,
    cwd: workspaceDir,
    dsh_home: dshHome,
    // 出片 profile：放开 bash / fs，让 DSH 能跑 Remotion + ffmpeg
    patch: profilePatchPath("render"),
    model: credential.model || readEnv("DSH_MODEL") || null,
    timeout_ms: timeoutMs,
    // 把 node / ffmpeg / ffprobe 注入 agent 子进程的 env：
    // tool-bash 跑 `node render-video.mjs` 时直接能用，不必依赖 PATH 里的解释器顺序。
    env: {
      NODE_BIN: process.execPath,
      FFMPEG_BIN: readStringEnv("FFMPEG_BIN") || "ffmpeg",
      FFPROBE_BIN: readStringEnv("FFPROBE_BIN") || "ffprobe",
      REMOTION_BROWSER_EXECUTABLE: readStringEnv("REMOTION_BROWSER_EXECUTABLE") || "",
      PATH: process.env.PATH || "",
      // 🔴 关键：DSH 的 approval 插件默认 policy 是 'ask'（见 sdk profile 的
      // `DSH_PERMISSION_MODE ?? 'workspace-write' ? 'never' : 'ask'`）。'ask' 在无头
      // 会话里没人点确认，命令会被挂住/拒绝。用户已拍板「放开沙箱」，
      // 这里显式设为 danger-full-access → approval=never，shell 命令才会真正执行。
      DSH_PERMISSION_MODE: "danger-full-access",
    },
  };

  if (!request.prompt) throw new Error("出片 prompt 为空");

  const stdout = await runBridge(status.python, request, timeoutMs + STARTUP_GRACE_MS, dshHome, credential);

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
  return (parsed.final_response ?? "").trim();
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

  const version = describeDshVersion(status);
  return {
    ok: true,
    detail: [
      `Python：${status.python}`,
      `DSH_HOME：${dshHome}`,
      `profile：${join(dshHome, "profiles", "storyboard", "cordis.patch.yml")}`,
      `模型：${status.model}`,
      // 版本自检输出：一致时说「与基线一致」，不一致时把提醒原文带出来。
      `SDK：${status.sdkVersion ?? "未读到"}${status.runtimeVersion ? `（运行时 ${status.runtimeVersion}）` : ""}`,
      `已知可用版本：${DSH_KNOWN_GOOD_SDK}`,
      version.dshVersionNote ?? "版本自检：与已知可用版本一致。",
    ].join("\n"),
  };
}
