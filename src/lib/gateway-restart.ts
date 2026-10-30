/**
 * OpenClaw 网关自动重启。
 *
 * 场景：会话发消息时如果网关进程挂了（被手动关掉、崩溃、机器休眠后没拉起来），
 * 之前只会给用户一句「网关未运行」，得人肉去开终端重启 —— 会话直接卡死。
 * 这里在检测到「端口没人监听」时自动按阶梯拉起网关，然后让调用方重试一次。
 *
 * 为什么不用 `openclaw gateway restart` 一把梭：
 * 那个子命令走系统服务（Windows 上是 schtasks），本机服务注册信息已过期
 * （`openclaw gateway status` 实测报「Service command does not include the gateway subcommand」），
 * 而且 schtasks 在部分运行环境里被安全策略禁用。所以做成阶梯：
 *   1. gateway restart（服务方式，最快、最"正规"）
 *   2. gateway start（服务没在跑时）
 *   3. gateway run（脱离服务，直接起一个前台进程 —— 前两步都失败时的兜底）
 * 每一步之后都等端口真正 listen，才认为成功。
 *
 * 不做的事：不去杀端口上的进程。万一端口被别的程序占着，杀掉是破坏性操作，
 * 交给用户判断更合适（诊断层已经把 port_conflict 单独分类）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

/** 网关默认端口（与 openclaw.json 的 gateway.port 一致）。 */
const DEFAULT_PORT = 18789;
/** OpenClaw 安装根目录；可用 OPENCLAW_HOME 覆盖。 */
const DEFAULT_CLI_ROOT = "D:/OpenClaw";
/** 单条 CLI 命令的超时。restart 要停+起服务，给足时间。 */
const CLI_TIMEOUT_MS = 45_000;
/** 同一时间只允许一次重启尝试，两次尝试之间至少隔这么久（防抖，避免把用户刷成重启风暴）。 */
const COOLDOWN_MS = 60_000;
/** 服务方式（restart/start）之后等端口的时间。 */
const PORT_WAIT_SERVICE_MS = 30_000;
/**
 * `gateway run` 冷启动的等待时间。
 *
 * 实测：spawn 一个前台网关要 60~120 秒才真正 listen（启动阶段要跑 bootstrap、
 * 迁移、插件加载），早期给 45 秒会在它马上就好之前判定失败 —— 而进程其实已经起来了。
 */
const PORT_WAIT_RUN_MS = 150_000;
/** TCP 探测超时：回环通常 <5ms。 */
const TCP_TIMEOUT_MS = 400;

export type GatewayRestartOutcome = {
  /** 最终网关是否可用 */
  ok: boolean;
  /** 本次是否真的执行了重启 */
  restarted: boolean;
  /** 用了哪一步（restart / start / run） */
  method?: "restart" | "start" | "run";
  /** 面向用户/日志的中文说明 */
  message: string;
  /** 跳过原因（cooldown / single-flight），调用方据此决定要不要提示 */
  skipped?: "cooldown" | "in_flight";
  durationMs?: number;
};

function cliRoot(): string {
  return (process.env.OPENCLAW_HOME || DEFAULT_CLI_ROOT).trim().replace(/\\/g, "/");
}

/** `openclaw` 的 Node 入口。Windows 上 bin/openclaw 是 .cmd，直接跑会开控制台窗口。 */
function cliEntry(): string {
  return join(cliRoot(), "node_modules", "openclaw", "openclaw.mjs");
}

function endpoint(): { host: string; port: number } {
  const raw = (process.env.OPENCLAW_BASE_URL || "").trim();
  if (raw) {
    try {
      const url = new URL(raw);
      return {
        host: url.hostname || "127.0.0.1",
        port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) || DEFAULT_PORT
      };
    } catch {
      /* 配置异常按默认走 */
    }
  }
  return { host: "127.0.0.1", port: DEFAULT_PORT };
}

/** 裸 TCP 探测：只确认端口上有人听着（不涉及协议，最便宜）。 */
export function probeGatewayPort(timeoutMs = TCP_TIMEOUT_MS): Promise<boolean> {
  const { host, port } = endpoint();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/** 轮询等端口 listen。 */
async function waitForPort(deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await probeGatewayPort()) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return probeGatewayPort();
}

/**
 * 跑一条 openclaw CLI 命令并等它结束。
 *
 * 注意：必须传 `stdio: ["ignore","pipe","pipe"]` —— 本机 `spawnSync`/`spawn` 用默认
 * stdio 会报 EBUSY（历史踩坑）。参数一律传数组，别拼 shell 字符串。
 */
function runCli(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const entry = cliEntry();
    if (!existsSync(entry)) {
      resolve({ code: -1, output: `找不到 openclaw CLI（${entry}）` });
      return;
    }
    let output = "";
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: cliRoot(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: "", NO_COLOR: "1" }
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
    }, CLI_TIMEOUT_MS);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 6000) output = output.slice(-6000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

/** 脱离父进程起一个 `gateway run`（前两步都失败时的兜底）。 */
function spawnGatewayForeground(): void {
  const entry = cliEntry();
  if (!existsSync(entry)) return;
  try {
    const child = spawn(process.execPath, [entry, "gateway", "run"], {
      cwd: cliRoot(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: "", NO_COLOR: "1" }
    });
    child.unref();
  } catch {
    /* 交给调用方按端口结果判定失败 */
  }
}

let inFlight: Promise<GatewayRestartOutcome> | null = null;
let lastAttemptAt = 0;

/**
 * 确认网关可用；不可用就按阶梯拉起。
 *
 * @param force true = 即使端口已在监听也强制重启（手动运维用）；默认 false。
 */
export function ensureGatewayRunning(options: { force?: boolean } = {}): Promise<GatewayRestartOutcome> {
  const { force = false } = options;
  // 并发调用合并成一次（用户连点两次发送、或多个会话同时失败）
  if (inFlight) return inFlight;
  const task = doEnsure({ force }).finally(() => {
    inFlight = null;
  });
  inFlight = task;
  return task;
}

async function doEnsure({ force }: { force: boolean }): Promise<GatewayRestartOutcome> {
  const startedAt = Date.now();
  if (!force && (await probeGatewayPort())) {
    return { ok: true, restarted: false, message: "网关正常，无需重启", durationMs: 0 };
  }
  // 防抖：刚试过就别连着再来（网关重启本身要几十秒，连着试只会互相打断）
  if (!force && Date.now() - lastAttemptAt < COOLDOWN_MS) {
    return {
      ok: false,
      restarted: false,
      skipped: "cooldown",
      message: `刚刚（${Math.round((Date.now() - lastAttemptAt) / 1000)} 秒前）已经尝试过重启网关，稍等片刻再试`
    };
  }
  lastAttemptAt = Date.now();

  // 第一步：服务方式 restart（最快，健康时 ~30 秒就能回来）
  const restartRun = await runCli(["gateway", "restart"]);
  if (await waitForPort(PORT_WAIT_SERVICE_MS)) {
    lastAttemptAt = 0;
    return {
      ok: true,
      restarted: true,
      method: "restart",
      message: "网关已通过 gateway restart 拉起",
      durationMs: Date.now() - startedAt
    };
  }
  console.warn(`[gateway-restart] gateway restart 未成功（exit=${restartRun.code}）：${restartRun.output.trim().slice(-300)}`);

  // 第二步：`start` 只在 restart 命令本身成功（exit 0）才试。
  // 两者都是同一个系统服务机制，restart 直接失败时再试 start 基本是重复踩坑，
  // 白白多等一分半；实测本机就是这种情形。
  if (restartRun.code === 0) {
    const startRun = await runCli(["gateway", "start"]);
    if (await waitForPort(PORT_WAIT_SERVICE_MS)) {
      lastAttemptAt = 0;
      return {
        ok: true,
        restarted: true,
        method: "start",
        message: "网关已通过 gateway start 拉起",
        durationMs: Date.now() - startedAt
      };
    }
    console.warn(`[gateway-restart] gateway start 未成功（exit=${startRun.code}）：${startRun.output.trim().slice(-300)}`);
  }

  // 最后兜底：脱离服务直接起前台网关进程，再等端口
  spawnGatewayForeground();
  if (await waitForPort(PORT_WAIT_RUN_MS)) {
    lastAttemptAt = 0;
    return {
      ok: true,
      restarted: true,
      method: "run",
      message: "网关已通过 gateway run 直接拉起（未走系统服务）",
      durationMs: Date.now() - startedAt
    };
  }

  return {
    ok: false,
    restarted: true,
    message:
      "尝试重启网关失败：restart / start / run 三步都没能让端口监听。" +
      `请手动在终端运行 \`${cliRoot()}/openclaw.cmd gateway run\`，或检查端口是否被占用。`,
    durationMs: Date.now() - startedAt
  };
}
