/**
 * 用 CDP 打开本地工作台，进内容库 → 点开指定标题的内容 → 检查「去 Studio 修改」按钮是否渲染。
 * 用法: node scripts/cdp-check-studio.mjs <cookie> <titleKeyword> <outPng>
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const COOKIE = process.argv[2] || "";
const KEYWORD = process.argv[3] || "Studio入口测试";
const OUT = process.argv[4] || "D:/OPCProjects/AiWorker/.tmp-studio-check.png";
const PORT = Number(process.env.SHOOT_PORT || 9351);
const PROFILE = process.env.SHOOT_PROFILE || "C:/Users/zengr/AppData/Local/Temp/cdp-studio-profile";

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
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false
    });
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }]
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
    await sleep(6000);

    // 1) 进内容库
    const clickedNav = await evaluate(`(() => {
      const btns = [...document.querySelectorAll('button, a')];
      const b = btns.find(x => (x.textContent || '').includes('内容库'));
      if (!b) return 'nav-not-found:' + btns.slice(0,10).map(x=>x.textContent.trim()).join('|');
      b.click(); return 'ok';
    })()`);
    console.log("导航:", clickedNav);
    await sleep(4000);

    // 2) 找目标卡片并点开
    const clickedCard = await evaluate(`(() => {
      const kw = ${JSON.stringify(KEYWORD)};
      const cards = [...document.querySelectorAll('.content-card')];
      const titles = cards.map(c => (c.querySelector('h3')?.textContent || '').trim());
      const hit = cards.find(c => (c.querySelector('h3')?.textContent || '').includes(kw));
      if (!hit) return 'card-not-found; 前 8 条=' + titles.slice(0, 8).join(' / ');
      hit.click(); return 'ok:' + (hit.querySelector('h3')?.textContent || '');
    })()`);
    console.log("卡片:", clickedCard);
    await sleep(3000);

    // 3) 检查详情页 studio 按钮
    const report = await evaluate(`(() => {
      const btn = document.querySelector('.detail-video-studio');
      const video = document.querySelector('.detail-video-player');
      const block = document.querySelector('.detail-video-block');
      const rect = (el) => el ? (r => ({x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}))(el.getBoundingClientRect()) : null;
      const title = document.querySelector('.detail-title, .detail-head h2, h2');
      const allBtns = [...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean);
      return JSON.stringify({
        hasStudioBtn: !!btn,
        studioBtnText: btn ? btn.textContent.trim() : null,
        videoSrc: video ? video.getAttribute('src') : null,
        blockRect: rect(block),
        videoRect: rect(video),
        btnRect: rect(btn),
        detailTitle: title ? title.textContent.trim().slice(0,40) : null,
        buttons: allBtns.slice(0, 20)
      }, null, 1);
    })()`);
    console.log("详情页检查:\n" + report);

    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
    console.log("截图: " + OUT);
  } catch (e) {
    console.error("失败:", e.message);
  } finally {
    try {
      ws && ws.close();
    } catch {
      /* ignore */
    }
    child.kill();
    process.exit(0);
  }
})();
