/**
 * SVG → JPG 光栅化（一键仿写主图 zip 下载用）。
 *
 * 项目未引入任何图片处理库（无 sharp / librsvg / canvas），而仿写主图是矢量 SVG。
 * 下载要求为 JPG，且要保留圆角样式——用本机 headless Chrome 把 SVG 截成高质量 JPG。
 * 复用 scripts/xhs-note.mjs 的 CDP 启动通道（Node 22 原生 WebSocket + Page.captureScreenshot）。
 *
 * 用法：
 *   node scripts/svg-to-jpg.mjs <svgUrlOrFile> <outJpgPath> [scale=2]
 * 例：
 *   node scripts/svg-to-jpg.mjs http://127.0.0.1:3000/uploads/covers/xxx.svg D:/t/1.jpg 2
 *
 * 输出：单行 JSON { ok:true } 或 { ok:false, detail }
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main() {
  const src = process.argv[2];
  const outPath = process.argv[3];
  const scale = Math.max(1, Math.min(4, Number(process.argv[4] || 2) || 2));
  if (!src || !outPath) {
    out({ ok: false, detail: "用法: svg-to-jpg.mjs <svgUrl|file> <outJpg> [scale]" });
    return;
  }

  // 本地文件转成 file:// 让 Chrome 能读（dev server 没起时也能用）
  const target = src.startsWith("http://") || src.startsWith("https://") || src.startsWith("file://")
    ? src
    : "file:///" + path.resolve(src).replace(/\\/g, "/");

  const port = 10300 + (process.pid % 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "svg-jpg-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--window-size=1080,1440",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
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
    try { chrome.kill(); } catch { /* */ }
    out({ ok: false, detail: "Chrome 调试端口未就绪" });
    return;
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

  try {
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1080,
      height: 1440,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: target });
    // 等 SVG 渲染 + 字体就绪
    await sleep(900);

    const shot = await send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 90,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1080, height: 1440, scale: scale },
    });
    const b64 = shot.data;
    fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
    out({ ok: true, bytes: fs.statSync(outPath).size });
  } catch (e) {
    out({ ok: false, detail: String(e?.message || e) });
  } finally {
    try { ws.close(); } catch { /* */ }
    try { chrome.kill(); } catch { /* */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
  }
}

main().catch((e) => out({ ok: false, detail: String(e?.message || e) }));
