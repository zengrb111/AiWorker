/**
 * SVG → JPG 光栅化（一键仿写主图 zip 下载用）。
 *
 * 项目未引入任何图片处理库（无 sharp / librsvg / canvas），而仿写主图是矢量 SVG。
 * 下载要求为 JPG，且要保留圆角样式——用本机 headless Chrome 把 SVG 截成高质量 JPG。
 * 复用 scripts/xhs-note.mjs 的 CDP 启动通道（Node 22 原生 WebSocket + Page.captureScreenshot）。
 *
 * 用法：
 *   单张：node scripts/svg-to-jpg.mjs <svgUrlOrFile> <outJpgPath> [scale=2]
 *   批量：node scripts/svg-to-jpg.mjs --batch <jobsJsonPath>
 *         jobsJson = [{ "src": "...svg", "out": "...jpg", "scale": 2 }, ...]
 *         —— 只启动一次 Chrome，复用同一页面逐张导航截图（8 张约从 29s 降到 6-8s）。
 *
 * 输出：单行 JSON
 *   单张 { ok:true, bytes } 或 { ok:false, detail }
 *   批量 { ok:true, results:[{ok,bytes}|{ok:false,detail}] } 或 { ok:false, detail }
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

/**
 * 找 Chrome 可执行文件：环境变量优先，其次按平台给出常见安装路径。
 * 之前写死 Windows 路径，部署到 Linux 后整条「下载主图 zip」直接失败（2026-10-30）。
 */
function resolveChrome() {
  const candidates = [
    process.env.CHROME_PATH || "",
    process.env.OM_CHROME || "",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return candidates[0];
}

const CHROME = resolveChrome();
const IS_LINUX_ROOT =
  process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** 本地文件转成 file:// 让 Chrome 能读（dev server 没起时也能用）。 */
function toUrl(src) {
  if (/^(https?|file):\/\//i.test(src)) return src;
  return "file:///" + path.resolve(src).replace(/\\/g, "/");
}

/** 启动一次 Chrome 并连上 CDP，返回可复用的 send()。 */
async function launchChrome() {
  const port = 10300 + (process.pid % 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "svg-jpg-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      // Linux 下以 root 运行时 Chrome 必须关沙箱，否则直接退出、调试端口永远不监听
      ...(IS_LINUX_ROOT ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--window-size=1080,1440",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  const cleanup = () => {
    try { chrome.kill(); } catch { /* */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
  };

  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) {
    cleanup();
    throw new Error("Chrome 调试端口未就绪");
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1080,
    height: 1440,
    deviceScaleFactor: 1,
    mobile: false,
  });

  return { send, cleanup };
}

/** 渲染一张：导航 → 等字体/绘制 → 截图写盘。 */
async function renderOne(send, job, firstInSession) {
  const src = String(job.src || "");
  const outPath = String(job.out || "");
  const scale = Math.max(1, Math.min(4, Number(job.scale || 2) || 2));
  if (!src || !outPath) throw new Error("任务缺少 src/out");

  await send("Page.navigate", { url: toUrl(src) });
  // 首张多等一点（Chrome 冷启动 + 字体加载），后续每张只需要等绘制
  await sleep(firstInSession ? 800 : 350);

  const shot = await send("Page.captureScreenshot", {
    format: "jpeg",
    quality: 90,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: 1080, height: 1440, scale },
  });
  fs.writeFileSync(outPath, Buffer.from(shot.data, "base64"));
  return fs.statSync(outPath).size;
}

async function main() {
  const isBatch = process.argv[2] === "--batch";

  let jobs;
  if (isBatch) {
    const jobsPath = process.argv[3];
    if (!jobsPath) {
      out({ ok: false, detail: "用法: svg-to-jpg.mjs --batch <jobsJsonPath>" });
      return;
    }
    try {
      jobs = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
    } catch (e) {
      out({ ok: false, detail: "任务文件读取失败: " + String(e?.message || e) });
      return;
    }
    if (!Array.isArray(jobs) || jobs.length === 0) {
      out({ ok: true, results: [] });
      return;
    }
  } else {
    const src = process.argv[2];
    const outPath = process.argv[3];
    if (!src || !outPath) {
      out({ ok: false, detail: "用法: svg-to-jpg.mjs <svgUrl|file> <outJpg> [scale]" });
      return;
    }
    jobs = [{ src, out: outPath, scale: Number(process.argv[4] || 2) || 2 }];
  }

  let session;
  try {
    session = await launchChrome();
  } catch (e) {
    out({ ok: false, detail: String(e?.message || e) });
    return;
  }

  const { send, cleanup } = session;
  try {
    if (!isBatch) {
      const bytes = await renderOne(send, jobs[0], true);
      out({ ok: true, bytes });
      return;
    }
    // 批量：同一会话逐张渲染，单张失败不影响其它
    const results = [];
    for (let i = 0; i < jobs.length; i++) {
      try {
        const bytes = await renderOne(send, jobs[i], i === 0);
        results.push({ ok: true, bytes });
      } catch (e) {
        results.push({ ok: false, detail: String(e?.message || e) });
      }
    }
    out({ ok: true, results });
  } catch (e) {
    out({ ok: false, detail: String(e?.message || e) });
  } finally {
    cleanup();
  }
}

main().catch((e) => out({ ok: false, detail: String(e?.message || e) }));
