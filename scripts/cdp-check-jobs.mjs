/**
 * 截图验证「定时任务」面板。
 * 用法: node scripts/cdp-check-jobs.mjs <cookie> <outPng>
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const COOKIE = process.argv[2] || "";
const OUT = process.argv[3] || "D:/OPCProjects/AiWorker/.tmp-jobs-check.png";
const PORT = Number(process.env.SHOOT_PORT || 9353);
const PROFILE = process.env.SHOOT_PROFILE || "C:/Users/zengr/AppData/Local/Temp/cdp-jobs-profile";

const child = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--hide-scrollbars",
    "--no-proxy-server",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "about:blank"
  ],
  { stdio: "ignore" }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let ws;
  try {
    let target = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
        target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (target) break;
      } catch {
        /* 等待启动 */
      }
    }
    if (!target) throw new Error("无法连接调试端口");

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });

    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, (m) => (m.error ? reject(new Error(method + ": " + m.error.message)) : resolve(m.result)));
        ws.send(JSON.stringify({ id: mid, method, params }));
        setTimeout(() => {
          if (pending.has(mid)) {
            pending.delete(mid);
            reject(new Error(method + " 超时"));
          }
        }, 60000);
      });

    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return r.result?.value;
    };

    await send("Page.enable");
    await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1400,
      deviceScaleFactor: 1,
      mobile: false
    });
    if (COOKIE) {
      await send("Network.setCookie", {
        name: "cx_session",
        value: COOKIE,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true
      });
    }

    await send("Page.navigate", { url: "http://127.0.0.1:3000/" });
    await sleep(7000);

    const nav = await evaluate(`(() => {
      const scope = document.querySelector('aside, nav, .sidebar, .nav, .app-sidebar') || document.body;
      const btns = [...scope.querySelectorAll('button, a')];
      const b = btns.find(x => (x.textContent || '').includes('定时任务'));
      if (!b) return 'nav-not-found:' + btns.slice(0,20).map(x=>x.textContent.trim()).filter(Boolean).join('|');
      b.click(); return 'ok:' + (b.className || '');
    })()`);
    console.log("导航:", nav);
    await sleep(13000);

    const report = await evaluate(`(() => {
      const jobs = [...document.querySelectorAll('.sj-job')].map(el => ({
        name: (el.querySelector('h3')?.textContent || '').trim(),
        badge: (el.querySelector('.sj-badge')?.textContent || '').trim(),
        meta: [...el.querySelectorAll('.sj-job-meta span')].map(s => s.textContent.replace(/\\s+/g,' ').trim()),
        runs: [...el.querySelectorAll('.sj-run')].map(s => s.textContent.replace(/\\s+/g,' ').trim())
      }));
      const err = document.querySelector('.sj-channel-warn');
      return JSON.stringify({
        jobCount: jobs.length,
        warn: err ? err.textContent.replace(/\\s+/g,' ').trim().slice(0,160) : null,
        empty: document.querySelector('.sj-empty') ? document.querySelector('.sj-empty').textContent.trim().slice(0,80) : null,
        jobs
      });
    })()`);
    console.log("面板:", report);

    const metrics = await send("Page.getLayoutMetrics");
    const height = Math.min(2200, Math.ceil(metrics.cssContentSize.height));
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1440, height, scale: 1 }
    });
    fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
    console.log("截图:", OUT, height + "px");
  } catch (e) {
    console.error("失败:", e.message);
  } finally {
    try {
      ws?.close();
    } catch {}
    child.kill();
    process.exit(0);
  }
})();
