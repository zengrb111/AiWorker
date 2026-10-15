/**
 * OpenClaw Gateway 诊断脚本 —— 反推「之前能用、现在彻底不能用」的成因。
 *
 * 关键约束：**零项目依赖**。它刻意不 import `src/lib/openclaw.ts`，
 * 因为那份文件用了 `import.meta.url` / `createRequire` / `require("next/dist/compiled/ws")`，
 * 在 `node --experimental-transform-types` + 自定义 resolver 下极易 import 失败，
 * 那会让「诊断工具本身跑不起来」变成新的问题。这里只用 Node 内置模块，
 * 保证任何时候都能跑。
 *
 * 检查项（按可疑度排序）：
 *   1. 端口 18789 是否监听 + 占用进程是谁      → 区分「没启动」与「被占用」
 *   2. openclaw CLI 是否可用                  → 判断网关能否被启动
 *   3. 设备凭据文件是否就绪                   → 区分「凭据缺失」与「鉴权失败」
 *   4. 裸 WebSocket 握手尝试 + 原始错误码     → 复现界面上那条空 message
 *   5. 残留 python/node 进程数                → 关联「调试几次后失效」的资源耗尽假设
 *   6. 汇总结论与处置建议
 *
 * 跑法（项目根，PowerShell）：
 *   $env:NODE_OPTIONS=""; node --experimental-strip-types scripts/diagnose-openclaw.mts
 *
 * 退出码：0=网关正常  1=发现问题（已给出结论）  2=环境异常（脚本自身跑不动）
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/* 输出工具                                                             */
/* ------------------------------------------------------------------ */

const C = {
  reset: "[0m",
  dim: "[2m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  cyan: "[36m",
  bold: "[1m",
};

const findings: string[] = [];
const hints: string[] = [];

function section(title: string): void {
  console.log(`\n${C.bold}${C.cyan}── ${title} ${"─".repeat(Math.max(0, 46 - title.length))}${C.reset}`);
}

function ok(label: string, detail = ""): void {
  console.log(`  ${C.green}✓${C.reset} ${label}${detail ? ` ${C.dim}${detail}${C.reset}` : ""}`);
}

function warn(label: string, detail = ""): void {
  console.log(`  ${C.yellow}!${C.reset} ${label}${detail ? ` ${C.dim}${detail}${C.reset}` : ""}`);
}

function bad(label: string, detail = ""): void {
  console.log(`  ${C.red}✗${C.reset} ${label}${detail ? ` ${C.dim}${detail}${C.reset}` : ""}`);
  findings.push(label + (detail ? ` — ${detail}` : ""));
}

function tip(text: string): void {
  console.log(`    ${C.dim}→ ${text}${C.reset}`);
  hints.push(text);
}

/* ------------------------------------------------------------------ */
/* 环境读取                                                             */
/* ------------------------------------------------------------------ */

/** 极简 .env.local 解析：只取需要的键，不引第三方依赖。 */
function readEnvLocal(): Record<string, string> {
  const file = join(process.cwd(), ".env.local");
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  try {
    const text = readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[m[1]] = value;
    }
  } catch {
    // 读不到就当作没有配置，交给后续检查报错
  }
  return out;
}

const env = { ...readEnvLocal(), ...process.env };
const baseUrl = env.OPENCLAW_BASE_URL?.trim() || "(未配置 OPENCLAW_BASE_URL)";
let host = "localhost";
let port = 18789;
try {
  const u = new URL(baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`);
  host = u.hostname;
  port = Number(u.port || 80);
} catch {
  // 保持默认值
}

/* ------------------------------------------------------------------ */
/* 1. 端口 + 占用进程                                                    */
/* ------------------------------------------------------------------ */

/** 裸 TCP 探测，返回是否有人监听。 */
function probePort(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(300);
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

/** 找出监听该端口的进程（Windows 用 netstat，POSIX 用 lsof）。 */
function findPortOwner(): string {
  if (process.platform === "win32") {
    const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) return "";
    const line = r.stdout
      .split(/\r?\n/)
      .find((l) => l.includes(`:${port}`) && /LISTENING/i.test(l));
    if (!line) return "";
    const pid = line.trim().split(/\s+/).pop() ?? "";
    const name = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" })
      .stdout?.trim()
      .split(/\s+/)[0];
    return name ? `${pid}（${name}）` : pid;
  }
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  const line = r.stdout?.split(/\r?\n/)[1];
  return line ? line.trim().replace(/\s+/g, " ").slice(0, 80) : "";
}

/* ------------------------------------------------------------------ */
/* 2. openclaw CLI                                                       */
/* ------------------------------------------------------------------ */

/** 在常见位置找 openclaw 可执行入口。 */
function findCli(): string {
  const isWin = process.platform === "win32";
  const whichCmd = isWin ? "where" : "which";
  const r = spawnSync(whichCmd, ["openclaw"], { encoding: "utf8" });
  const found = (r.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (found) return found;

  const home = homedir();
  const candidates = isWin
    ? [
        join(home, "AppData", "Roaming", "npm", "openclaw.cmd"),
        join(home, "AppData", "Roaming", "npm", "openclaw.ps1"),
        "D:\\OpenClaw\\openclaw.cmd",
        join(process.cwd(), "OpenClaw", "openclaw.cmd"),
      ]
    : ["/usr/local/bin/openclaw", "/usr/bin/openclaw", join(home, ".local", "bin", "openclaw")];

  for (const c of candidates) if (existsSync(c)) return c;
  return "";
}

/* ------------------------------------------------------------------ */
/* 3. 设备凭据                                                           */
/* ------------------------------------------------------------------ */

function checkCredentials(): { sqlite: boolean; identity: boolean; token: boolean } {
  const home = homedir();
  const sqlite = existsSync(join(home, ".openclaw", "state", "openclaw.sqlite"));
  const device = existsSync(join(home, ".openclaw", "identity", "device.json"));
  const auth = existsSync(join(home, ".openclaw", "identity", "device-auth.json"));
  let token = false;
  if (auth) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(home, ".openclaw", "identity", "device-auth.json"), "utf8")
      ) as { tokens?: { operator?: { token?: string } } };
      token = Boolean(parsed.tokens?.operator?.token);
    } catch {
      token = false;
    }
  }
  return { sqlite, identity: device && auth, token };
}

function fileSize(p: string): string {
  try {
    const kb = statSync(p).size / 1024;
    return kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${kb.toFixed(1)}KB`;
  } catch {
    return "?";
  }
}

/* ------------------------------------------------------------------ */
/* 4. 裸 WebSocket 握手                                                  */
/* ------------------------------------------------------------------ */

/**
 * 用 Node 内置 http 发一个 WebSocket Upgrade 请求，打印服务端真实响应。
 *
 * 不用 ws 库 —— 正是为了看清楚「服务端到底说了什么」，
 * 包括 401（鉴权失败）与直接挂断（不是 OpenClaw 网关）这两种关键差异。
 */
function rawUpgradeProbe(): Promise<string> {
  return new Promise((resolve) => {
    const key = Buffer.from(Math.random().toString(36) + Date.now()).toString("base64").slice(0, 24);
    const req = http.request({
      host,
      port,
      path: "/",
      method: "GET",
      timeout: 2000,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        // ws 库默认会协商这两个扩展；缺了它们时部分服务端会在应用层
        // 直接拒绝 Upgrade（返回 400），从而给出误导性的「握手失败」。
        "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
        Origin: baseUrl,
      },
    });

    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve("UPGRADE_OK（服务端接受了 WebSocket 升级，服务确实是网关）");
    });
    req.on("response", (res) => {
      resolve(`HTTP_${res.statusCode}（服务端拒绝了 Upgrade：${res.statusMessage || "未知"}）`);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve("TIMEOUT（服务端 2 秒内无响应）");
    });
    req.on("error", (e: Error & { code?: string }) => {
      resolve(`${e.code || "ERROR"}${e.message ? `（${e.message}）` : ""}`);
    });
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* 5. 残留进程                                                           */
/* ------------------------------------------------------------------ */

function countProcesses(pattern: RegExp): number {
  if (process.platform !== "win32") return 0;
  const r = spawnSync("tasklist", ["/NH", "/FI", "IMAGENAME eq python.exe"], { encoding: "utf8" });
  if (!r.stdout) return 0;
  const lines = r.stdout.split(/\r?\n/).filter((l) => /python\.exe/i.test(l));
  return pattern.test("python") ? lines.length : 0;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  console.log(`${C.bold}OpenClaw Gateway 诊断${C.reset}  ${C.dim}${new Date().toLocaleString()}${C.reset}`);
  console.log(`${C.dim}目标：${baseUrl}  →  ${host}:${port}${C.reset}`);

  /* 1. 端口 */
  section("1. 端口状态");
  const portOpen = await probePort();
  if (portOpen) {
    ok("端口有人监听", `${host}:${port}`);
    const owner = findPortOwner();
    if (owner) {
      const isLikelyClaw = /node|openclaw/i.test(owner);
      if (isLikelyClaw) {
        ok("监听进程看起来就是网关", owner);
      } else {
        warn("监听进程不像是 OpenClaw", owner);
        findings.push(`端口 ${port} 被 ${owner} 占用，可能不是网关`);
        tip("该端口被别的程序占着，网关可能因此启动失败或连到了错误的服务。用 netstat -ano | findstr 18789 确认。");
      }
    }
  } else {
    bad("端口无人监听", `${host}:${port}`);
    findings.push("网关进程未运行或已退出");
  }

  /* 2. CLI */
  section("2. openclaw CLI");
  const cli = findCli();
  if (cli) {
    ok("找到 openclaw CLI", cli);
  } else {
    bad("PATH 与常见位置都没找到 openclaw CLI");
    tip("没有 CLI 就无法手动启动网关。若你确认网关本该运行，请确认它是用别的方式（服务/容器）启动的。");
  }

  /* 3. 凭据 */
  section("3. 设备凭据");
  const cred = checkCredentials();
  if (cred.sqlite) {
    ok("找到新版 SQLite 凭据", fileSize(join(homedir(), ".openclaw", "state", "openclaw.sqlite")));
  }
  if (cred.identity) {
    ok("找到旧版 identity 凭据", `device-auth.json ${fileSize(join(homedir(), ".openclaw", "identity", "device-auth.json"))}`);
  }
  if (!cred.sqlite && !cred.identity) {
    bad("两种凭据来源都不存在");
    tip(
      "网关无法完成设备鉴权。若换了机器或清理过 ~/.openclaw，需要在本机重新执行一次 openclaw 的设备注册。"
    );
  } else if (!cred.token && cred.identity) {
    warn("device-auth.json 里没有 operator token");
    tip("凭据文件存在但缺少 operator token，网关会拒绝鉴权。建议重新注册设备。");
  }
  if (cred.sqlite && cred.identity) {
    warn("新旧凭据同时存在");
    tip(
      "OpenClaw 新版（2026.10 起）检测到旧 identity 文件会拒绝启动。若网关起不来，试着把 identity 目录移走。"
    );
  }

  /* 4. 握手 */
  section("4. WebSocket 握手探测");
  if (!portOpen) {
    warn("端口不通，跳过握手", "（先解决端口问题）");
  } else {
    const result = await rawUpgradeProbe();
    if (result.startsWith("UPGRADE_OK")) {
      ok("WebSocket 升级成功", result);
    } else if (/HTTP_401|HTTP_403/.test(result)) {
      warn("服务端拒绝 Upgrade", result);
      findings.push(`网关在运行但拒绝连接（${result}）`);
      tip("端口通但鉴权被拒：设备私钥/token 与网关不匹配，或该端口不是网关而是别的服务。");
    } else {
      // 裸探测被拒 ≠ 网关有问题。真实客户端用的是 next/dist/compiled/ws，
      // 它会额外发送 Sec-WebSocket-Extensions 等协商头，而这里只有原生
      // http.request，缺头的请求被服务端应用层拒绝（400）是常见现象。
      // 因此这里只作为「端口上是什么服务」的参考，不作为网关可用性结论。
      warn("裸 Upgrade 探测被拒（仅供参考，不代表真实客户端）", result);
      tip(
        "这一步只说明「端口上有服务、但它没接受这个最简 Upgrade 请求」，" +
          "不等于网关不可用。真实客户端（next/dist/compiled/ws）会带扩展协商头，行为可能不同。\n" +
          "       权威结论请用项目自己的健康检查（它走真实握手路径）：\n" +
          "         curl http://localhost:3000/api/openclaw/health\n" +
          "       或直接点页面上的「今日全网热点」看是否恢复。"
      );
    }
  }

  /* 5. 残留进程 */
  section("5. 残留进程（关联「调试几次后失效」）");
  const pythonCount = countProcesses(/python/);
  if (pythonCount === 0) {
    ok("没有残留的 python 进程");
  } else {
    warn(`发现 ${pythonCount} 个 python.exe 进程`);
    if (pythonCount > 3) {
      findings.push(`残留 ${pythonCount} 个 python 进程，可能挤占资源`);
      tip(
        "DSH 每次调用会 spawn 一个 Python，而 child.kill('SIGKILL') 在 Windows 上不杀进程树，" +
          "反复出片可能累积。确认无关后可结束它们：taskkill /F /IM python.exe"
      );
    }
  }

  /* 6. 结论 */
  section("结论");
  if (findings.length === 0) {
    console.log(`  ${C.green}${C.bold}网关状态正常${C.reset}`);
    if (portOpen) tip("若界面仍报错，那是客户端握手/鉴权的问题，可查看后端日志里的 kind= 分类。");
    return 0;
  }

  console.log(`  ${C.red}${C.bold}发现 ${findings.length} 个问题${C.reset}`);
  findings.forEach((f, i) => console.log(`  ${C.red}${i + 1}.${C.reset} ${f}`));
  if (hints.length) {
    console.log(`\n  ${C.bold}处置建议${C.reset}`);
    [...new Set(hints)].forEach((h) => console.log(`  ${C.dim}→${C.reset} ${h}`));
  }
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n${C.red}诊断脚本自身异常：${C.reset}`, err instanceof Error ? err.stack : err);
    console.error("这说明环境有问题，而非网关问题。请确认用的是项目指定的 Node 版本。");
    process.exit(2);
  });