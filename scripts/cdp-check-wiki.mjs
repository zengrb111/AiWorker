/**
 * 截图验证 Wiki 知识库：列表 → 详情 → 一键生成视频跳到会话。
 * 用法: node scripts/cdp-check-wiki.mjs <cookie> <outPrefix>
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const COOKIE = process.argv[2] || "";
const PREFIX = process.argv[3] || "D:/OPCProjects/AiWorker/.tmp-wiki";
const PORT = Number(process.env.SHOOT_PORT || 9357);
const PROFILE = "C:/Users/zengr/AppData/Local/Temp/cdp-wiki-profile";

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
        }, 120000);
      });

    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return r.result?.value;
    };

    const shoot = async (name) => {
      const metrics = await send("Page.getLayoutMetrics");
      const height = Math.min(3000, Math.ceil(metrics.cssContentSize.height));
      const shot = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 1440, height, scale: 1 }
      });
      fs.writeFileSync(`${PREFIX}-${name}.png`, Buffer.from(shot.data, "base64"));
      console.log(`截图 ${name}: ${height}px`);
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
      const scope = document.querySelector('aside, nav, .sidebar, .nav') || document.body;
      const b = [...scope.querySelectorAll('button, a')].find(x => (x.textContent || '').includes('知识库'));
      if (!b) return 'nav-not-found';
      b.click(); return 'ok';
    })()`);
    console.log("导航:", nav);
    await sleep(4000);
    await shoot("list");

    const cards = await evaluate(`(() => {
      return [...document.querySelectorAll('.kb-card')].map(c => ({
        name: (c.querySelector('.kb-card-name')?.textContent || '').trim(),
        cls: c.className,
        pill: (c.querySelector('.kb-pill')?.textContent || '').trim()
      }));
    })()`);
    console.log("卡片:", JSON.stringify(cards));

    // 进 Wiki 库详情
    const opened = await evaluate(`(() => {
      const card = [...document.querySelectorAll('.kb-card')].find(c => c.className.includes('wiki'));
      if (!card) return 'no-wiki-card';
      card.click(); return 'ok:' + (card.querySelector('.kb-card-name')?.textContent || '');
    })()`);
    console.log("打开:", opened);
    await sleep(5000);
    await shoot("detail");

    const detailReport = await evaluate(`(() => ({
      points: [...document.querySelectorAll('.kb-point')].map(p => ({
        title: (p.querySelector('h5')?.textContent || '').trim(),
        dur: (p.querySelector('.kb-point-dur')?.textContent || '').trim(),
        hasVideoBtn: !!p.querySelector('.kb-btn.wiki')
      })),
      docs: [...document.querySelectorAll('.kb-doc-row .kb-doc-name')].map(d => d.textContent.trim()),
      error: document.querySelector('.kb-alert.error')?.textContent?.trim() || null
    }))()`);
    console.log("详情:", JSON.stringify(detailReport));

    // 点第一个「一键生成视频」
    const clicked = await evaluate(`(() => {
      const btn = document.querySelector('.kb-point .kb-btn.wiki');
      if (!btn) return 'no-btn';
      btn.click(); return 'ok';
    })()`);
    console.log("点一键生成视频:", clicked);
    await sleep(40000);
    await shoot("chat");

    const chatReport = await evaluate(`(() => {
      const ta = document.querySelector('.video-panel textarea, .huashu-panel textarea, textarea');
      return {
        onChat: !!document.querySelector('.chat-input-wrap, .chat-input-topbar'),
        textareaPreview: ta ? ta.value.slice(0, 220) : null
      };
    })()`);
    console.log("会话:", JSON.stringify(chatReport));
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
