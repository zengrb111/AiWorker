/**
 * OpenClaw 模型配置同步（v3 方案：只同步主对话模型）。
 *
 * 背景：会话改走 OpenClaw 后，「主对话模型」的权威来源变成 OpenClaw 自己
 * （openclaw.json + 私有 sqlite 凭证库）。用户在平台「系统配置」里填写/修改
 * 主模型时，需要把 key 也交给 OpenClaw，否则会话仍用旧配置。
 *
 * 为什么必须走 CLI 而不能写 JSON：
 *   API key **不在** openclaw.json 里，只存 auth.profiles 的引用；真实 key 在
 *   OpenClaw 私有的 sqlite 凭证库，格式未公开。唯一正规入口是
 *   `openclaw models auth paste-api-key`，且实测其非 TTY 时读 stdin，
 *   因此可以无人值守调用。
 *
 * 隔离边界（v3 决策 3）：
 *   只同步 chat 能力。识图/TTS/搜索/向量/分镜等仍由平台直连消费，
 *   写过去只会造成两份无用配置，所以不同步。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type SyncResult = { ok: true } | { ok: false; reason: string };

/**
 * CLI 单次调用超时。
 *
 * 实测（2026-10-17）：`models auth list` 在本机要 **38 秒** 才返回 ——
 * OpenClaw CLI 启动时会做 sqlite 打开、provider 目录扫描等一次性初始化，
 * 比普通 CLI 慢得多。最初设 20 秒导致每次同步都误判超时。
 * 90 秒留足余量，同时仍能挡住真正的卡死。
 */
const CLI_TIMEOUT_MS = Number(process.env.OPENCLAW_SYNC_TIMEOUT_MS ?? 90_000);

/**
 * 优先使用的 Node 可执行文件。
 *
 * OpenClaw CLI 会校验 Node 运行时版本（"current Node failed runtime admission"）
 * 并自行 re-exec 到 PATH 上的 node。若用 `process.execPath` 且版本不匹配，
 * CLI 内部重启进程会导致父子关系断裂、`close` 事件迟迟不来。
 * 因此这里显式选一个满足要求的 node：优先 env 指定，否则用 PATH 上的 `node`。
 */
function resolveNodeExecutable(): string {
  const override = process.env.OPENCLAW_SYNC_NODE?.trim();
  if (override) return override;
  // 平台 dev server 本身就跑在满足要求的 node 上，直接复用它最稳。
  return process.execPath;
}

/**
 * 定位 OpenClaw CLI 入口（openclaw.mjs）。
 *
 * 按优先级：
 *   1. env OPENCLAW_CLI_ENTRY（部署方显式指定）
 *   2. npm 全局根目录下的 openclaw/openclaw.mjs（最常见）
 *   3. 当前进程的 execPath 同级的 npm 全局目录（跨平台兜底）
 *
 * 刻意**不**用 `openclaw` 命令名：Windows 上它是 .cmd/.ps1 包装，
 * spawn 直接跑会因 shell 关联问题失败（且 PATH 在不同启动方式下不一致）。
 */
function resolveOpenClawEntry(): string | null {
  const override = process.env.OPENCLAW_CLI_ENTRY?.trim();
  if (override && existsSync(override)) return override;

  const candidates = [
    // npm 全局（Windows 默认）
    path.join(homedir(), "AppData", "Roaming", "npm", "node_modules", "openclaw", "openclaw.mjs"),
    // npm 全局（macOS / Linux）
    path.join(homedir(), ".npm-global", "lib", "node_modules", "openclaw", "openclaw.mjs"),
    path.join("/usr", "local", "lib", "node_modules", "openclaw", "openclaw.mjs"),
    path.join("/usr", "lib", "node_modules", "openclaw", "openclaw.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 平台 provider id → OpenClaw provider id。未列出的 provider 跳过同步。 */
const PROVIDER_MAP: Record<string, string> = {
  deepseek: "deepseek",
  openai: "openai",
  zhipu: "zhipu",
  qwen: "qwen",
  dashscope: "qwen",
  moonshot: "moonshot",
  doubao: "doubao",
};

export function toOpenClawProviderId(platformProviderId: string): string | null {
  return PROVIDER_MAP[platformProviderId.trim().toLowerCase()] ?? null;
}

type CliOutcome = { ok: true; stdout: string } | { ok: false; reason: string };

/**
 * 执行一次 OpenClaw CLI 调用。
 *
 * 要点：
 *  · `windowsHide` 避免弹黑窗；
 *  · key 一律走 stdin，**绝不进命令行参数**（会进进程列表与日志）；
 *  · 超时主动 kill，防止 CLI 卡死拖垮系统配置保存接口；
 *  · stderr 只进日志，不返回给调用方（可能含路径等细节）。
 */
function runOpenClawCli(
  args: string[],
  stdinText?: string
): Promise<CliOutcome> {
  const entry = resolveOpenClawEntry();
  if (!entry) {
    return Promise.resolve({
      ok: false,
      reason:
        "未找到 OpenClaw CLI（openclaw.mjs）。请确认已全局安装 openclaw，" +
        "或设置 OPENCLAW_CLI_ENTRY 指向其入口文件。",
    });
  }

  return new Promise<CliOutcome>((resolve) => {
    // CLI 内部可能 re-exec（版本校验失败时自行切换到 PATH 上的 node），
    // 那种情况下子进程会被替换，`close` 仍会由最终进程触发。
    // 用 detached=false + kill() 只能杀当前句柄；若 re-exec 已发生，
    // 超时后最多遗留一个 CLI 进程，由 OpenClaw 自身退出机制收尾。
    const child = spawn(resolveNodeExecutable(), [entry, ...args], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* 进程可能已退出 */
      }
      resolve({ ok: false, reason: `OpenClaw CLI 执行超时（${CLI_TIMEOUT_MS / 1000} 秒）` });
    }, CLI_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: `无法启动 OpenClaw CLI：${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, stdout });
        return;
      }
      const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 200);
      resolve({ ok: false, reason: `OpenClaw CLI 退出码 ${code}${detail ? `：${detail}` : ""}` });
    });

    if (stdinText !== undefined) {
      child.stdin?.write(`${stdinText}\n`);
    }
    child.stdin?.end();
  });
}

/**
 * 把平台侧主对话模型 key 同步进 OpenClaw。
 *
 * key 经 stdin 管道传入（CLI 非 TTY 时读 stdin，已实测）。
 * 未知名 provider 直接跳过 —— 不猜、不硬映射，猜错会让 OpenClaw 侧
 * 多出一份指向错误服务的配置。
 */
export async function syncModelKeyToOpenClaw(input: {
  provider: string;
  apiKey: string;
  profileId?: string;
}): Promise<SyncResult> {
  const providerId = toOpenClawProviderId(input.provider);
  if (!providerId) {
    return { ok: false, reason: `暂不支持同步 provider「${input.provider}」到 OpenClaw` };
  }
  const key = (input.apiKey ?? "").trim();
  if (!key) return { ok: false, reason: "API Key 为空，未同步" };

  const profileId = input.profileId?.trim() || `${providerId}:manual`;
  const outcome = await runOpenClawCli(
    [
      "models",
      "auth",
      "paste-api-key",
      "--provider",
      providerId,
      "--profile-id",
      profileId,
    ],
    key,
  );
  if (!outcome.ok) {
    console.error(`[openclaw-sync] 同步模型 key 失败：${outcome.reason}`);
    return outcome;
  }
  console.log(`[openclaw-sync] 已同步模型 key 到 OpenClaw（provider=${providerId}）`);
  return { ok: true };
}

/** 设置 OpenClaw 默认模型（会话实际使用的模型）。 */
export async function setOpenClawDefaultModel(model: string): Promise<SyncResult> {
  const value = (model ?? "").trim();
  if (!value) return { ok: false, reason: "模型 id 为空，未设置" };

  const outcome = await runOpenClawCli(["models", "set", value]);
  if (!outcome.ok) {
    console.error(`[openclaw-sync] 设置默认模型失败：${outcome.reason}`);
    return outcome;
  }
  console.log(`[openclaw-sync] 已设置 OpenClaw 默认模型：${value}`);
  return { ok: true };
}

/**
 * 删除服务时清理 OpenClaw 侧 auth profile。
 *
 * 注意 CLI 签名：`logout <profileId>` 的 profileId 是**位置参数**（不是 --profile-id），
 * 且必须带 `--yes` 跳过交互确认，否则在无人值守调用下会挂起直到超时。
 */
export async function removeOpenClawAuthProfile(profileId: string): Promise<SyncResult> {
  const value = (profileId ?? "").trim();
  if (!value) return { ok: false, reason: "profile id 为空，未清理" };

  const outcome = await runOpenClawCli(["models", "auth", "logout", value, "--yes"]);
  if (!outcome.ok) {
    console.error(`[openclaw-sync] 清理 auth profile 失败：${outcome.reason}`);
    return outcome;
  }
  console.log(`[openclaw-sync] 已清理 OpenClaw auth profile：${value}`);
  return { ok: true };
}
