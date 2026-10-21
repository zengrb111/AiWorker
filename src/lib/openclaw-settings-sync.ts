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
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
 * 设置某个 agent 的**专属**模型（`agents.entries.<agentId>.model`）。
 *
 * 为什么必须单独同步这一层：
 *
 * OpenClaw 解析 agent 用的模型时，**agent 级配置优先于 defaults**。
 * 本机实测（2026-10-20）：
 *   agents.defaults.model.primary = "openai/deepseek-flash"   ← 平台同步写的
 *   agents.entries.main.model     = "deepseek/deepseek-v4-pro@deepseek:manual"  ← 真正生效
 * 结果是用户在平台「系统配置」里把 chat 全部指向 deepseek-flash，
 * 会话却仍在跑 v4-pro —— 因为 `openclaw models set` 只写 defaults，
 * 它没有 --agent 参数，`openclaw agents` 子命令也没有 set-model。
 *
 * 走 `openclaw config set <path> <value>` 写点号路径，可以精确落到 entry 上
 * （已 dry-run 验证：`Dry run successful: 1 update(s) validated`）。
 */
export async function setOpenClawAgentModel(
  agentId: string,
  model: string
): Promise<SyncResult> {
  const agent = (agentId ?? "").trim();
  const value = (model ?? "").trim();
  if (!agent) return { ok: false, reason: "agent id 为空，未设置" };
  if (!value) return { ok: false, reason: "模型 id 为空，未设置" };

  const outcome = await runOpenClawCli([
    "config",
    "set",
    `agents.entries.${agent}.model`,
    value,
  ]);
  if (!outcome.ok) {
    console.error(`[openclaw-sync] 设置 agent ${agent} 的模型失败：${outcome.reason}`);
    return outcome;
  }
  console.log(`[openclaw-sync] 已设置 OpenClaw agent[${agent}] 模型：${value}`);
  return { ok: true };
}

/** 平台会话默认使用的 OpenClaw agent id（每用户 agent 形如 agent:u-<id>:<会话>）。 */
function resolveAgentId(): string {
  return (process.env.OPENCLAW_AGENT_ID?.trim() || "main");
}

/**
 * 列出「每用户 agent」的 id（`u-<userId>`）。
 *
 * 平台给每个登录用户装了一个独立 agent（独立 workspace/记忆/会话库），
 * 用户 agent 的模型是**显式写死**的（不继承 defaults），所以同步主对话模型时
 * 必须把用户 agent 一起改，否则新用户/新会话还在跑旧模型。
 */
function listUserAgentIds(): string[] {
  const configPath =
    process.env.OPENCLAW_CONFIG?.trim() || path.join(homedir(), ".openclaw", "openclaw.json");
  try {
    // 历史配置里出现过 BOM，解析前先剥掉。
    const raw = readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    const cfg = JSON.parse(raw) as {
      agents?: { entries?: Record<string, unknown> };
    };
    const entries = cfg.agents?.entries ?? {};
    return Object.keys(entries).filter((id) => id.startsWith("u-"));
  } catch {
    return [];
  }
}

let userAgentModelSyncRunning = false;

/**
 * 把模型同步到全部用户 agent（`agents.entries.u-*.model`）。
 *
 * 走一次 `config set --batch-file`，避免 10 个用户跑 10 次 CLI。
 * **不阻塞调用方**：本机 CLI 单次冷启动 + 插件清理可能要几分钟，
 * 绝不能让它拖住「系统配置」的保存请求；失败只记日志，下一轮保存会重试。
 */
function syncModelToUserAgents(pinned: string): void {
  if (userAgentModelSyncRunning) return;
  const ids = listUserAgentIds();
  if (!ids.length) return;
  userAgentModelSyncRunning = true;
  const file = path.join(tmpdir(), `openclaw-user-agent-model-${Date.now()}.json`);
  // 配置校验要求 agent 级模型是「可解析的引用」，必须带 @<profileId>
  // （否则报 Unable to resolve authored model reference），缺省按 <provider>:default 补。
  const userAgentModel = pinned.includes("@")
    ? pinned
    : `${pinned}@${pinned.split("/")[0]}:default`;
  try {
    writeFileSync(
      file,
      JSON.stringify(
        ids.map((id) => ({ path: `agents.entries["${id}"].model`, value: userAgentModel }))
      ),
      "utf8"
    );
  } catch (error) {
    userAgentModelSyncRunning = false;
    console.error("[openclaw-sync] 生成用户 agent 模型批量配置失败：", error);
    return;
  }
  void runOpenClawCli(["config", "set", "--batch-file", file])
    .then((outcome) => {
      if (!outcome.ok) {
        console.error(`[openclaw-sync] 同步用户 agent 模型失败：${outcome.reason}`);
      } else {
        console.log(`[openclaw-sync] 已同步 ${ids.length} 个用户 agent 的模型：${pinned}`);
      }
    })
    .catch((error) => {
      console.error("[openclaw-sync] 同步用户 agent 模型异常：", error);
    })
    .finally(() => {
      userAgentModelSyncRunning = false;
      try {
        rmSync(file, { force: true });
      } catch {
        /* 临时文件清理失败可忽略 */
      }
    });
}

/**
 * 把平台「chat 能力」的模型分配同步给 OpenClaw —— **defaults 与 agent 级一起改**。
 *
 * 关键点（2026-10-20 实测踩坑）：
 *  1. 必须传**全限定 id**（`provider/model`）。只传裸 model id 时，OpenClaw
 *     会回落到默认 provider（实测 `deepseek-flash` → `openai/deepseek-flash`），
 *     而 openai provider 根本没配 —— 鉴权直接失败。
 *  2. 必须同时改 `agents.entries.<agent>.model`。只改 defaults 不够，
 *     agent 级配置优先级更高，会继续用旧模型。
 *  3. agent 级值带 `@<profileId>` 绑定 auth profile，与 key 同步用的
 *     profileId 保持一致（同一个 key，不能一个带 profile 一个不带）。
 */
export async function syncOpenClawChatModel(input: {
  provider: string;
  model: string;
  profileId?: string;
  agentId?: string;
}): Promise<SyncResult> {
  const providerId = toOpenClawProviderId(input.provider);
  if (!providerId) {
    return {
      ok: false,
      reason: `暂不支持同步 provider「${input.provider}」到 OpenClaw`,
    };
  }
  const model = (input.model ?? "").trim();
  if (!model) return { ok: false, reason: "模型 id 为空，未设置" };

  const qualified = model.includes("/") ? model : `${providerId}/${model}`;
  const profileId = (input.profileId ?? "").trim();
  const pinned = profileId ? `${qualified}@${profileId}` : qualified;
  const agentId = (input.agentId ?? "").trim() || resolveAgentId();

  const defaultsOutcome = await setOpenClawDefaultModel(qualified);
  if (!defaultsOutcome.ok) return defaultsOutcome;

  const agentOutcome = await setOpenClawAgentModel(agentId, pinned);
  if (!agentOutcome.ok) return agentOutcome;

  // 用户各自有独立 agent，模型是显式写死的 → 一起改，不阻塞本次保存。
  syncModelToUserAgents(pinned);
  return agentOutcome;
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
