/**
 * UI 验证：「一键生成视频」弹窗内联在会话里 + 状态跨模块持久（v2）。
 *
 * 预期行为：
 * 1. 点「一键生成视频」→ 面板内联出现在对话输入区上方；
 * 2. 填需求 → 切到 内容库/定时任务 → 面板从 DOM 消失（不再是悬浮窗）；
 * 3. 切回 对话 → 面板回来，填写内容原样保留（状态常驻在 platform-client 钩子里）；
 * 4. 关闭再重开 → 表单回到默认干净状态（新一轮生成从零开始）。
 *
 * 用法：node scripts/ui-test-genvideo-persist.mjs
 */
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9333;
const APP = "http://127.0.0.1:3000/";
const USER_ID = "cmrbfwt5p000c7yq5vntrbqzx"; // 大彬
const SHOT_DIR = join(process.cwd(), ".workbuddy", "tmp");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEFAULT_REQUIREMENT = "生成ai回忆录宣传片";

// ---- 登录 cookie ----
const envText = readFileSync(join(process.cwd(), ".env.local"), "utf8");
const secret = envText.match(/^AUTH_SESSION_SECRET="?([^"\r\n]*)"?\s*$/m)?.[1]?.trim();
if (!secret) throw new Error("AUTH_SESSION_SECRET 未找到");
const payload = `${USER_ID}.${Date.now()}`;
const COOKIE = `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;

// ---- 启动 headless Chrome ----
const profileDir = mkdtempSync(join(tmpdir(), "cdp-genvideo-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  "--window-size=1560,960",
  "--no-first-run",
  "--disable-gpu",
  "about:blank"
], { stdio: ["ignore", "pipe", "pipe"] });
process.on("exit", () => { try { chrome.kill(); } catch {} });

async function waitFor(fn, timeoutMs = 15000, step = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch {}
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("waitFor 超时");
}

await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
  return res.ok ? await res.json() : null;
});
console.log("[ok] chrome up");

const resNew = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
const target = await resNew.json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression, awaitPromise = false) {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error("页面脚本异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
async function shot(name) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOT_DIR, name), Buffer.from(r.data, "base64"));
  console.log("[shot]", name);
}

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Network.enable");
await cdp("Network.setCookie", { name: "cx_session", value: COOKIE, url: APP });
await cdp("Page.navigate", { url: APP });
await new Promise((r) => setTimeout(r, 4000));

await evaluate(`new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (document.querySelector(".sidebar nav")) return resolve(true);
    if (Date.now() - t0 > 15000) return reject(new Error("应用未挂载"));
    setTimeout(poll, 300);
  })();
})`, true);
console.log("[ok] app mounted");

async function clickNav(label) {
  const clicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll(".sidebar nav button")].find(b => (b.querySelector(".nav-label")?.textContent || "").trim() === ${JSON.stringify(label)});
    if (!btn) return false;
    btn.click(); return true;
  })()`);
  if (!clicked) throw new Error(`找不到导航「${label}」`);
  await new Promise((r) => setTimeout(r, 900));
}
await clickNav("对话");

const hasComposer = await evaluate(`!!document.querySelector(".chat-input-topbar")`);
if (!hasComposer) {
  const created = await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => /新(建)?(对)?话|新建会话/.test(b.textContent || ""));
    if (!btn) return false;
    btn.click(); return true;
  })()`);
  if (!created) throw new Error("没有会话也没找到新建按钮");
  await new Promise((r) => setTimeout(r, 1500));
}

const panelSel = ".chat-input-topbar .viral-remake-panel, .chat-input-wrap .viral-remake-panel, .chat-composer .viral-remake-panel";
async function openPanel() {
  const opened = await evaluate(`(() => {
    const btn = [...document.querySelectorAll(".chat-input-topbar button")].find(b => (b.textContent || "").trim() === "一键生成视频");
    if (!btn) return false;
    btn.click(); return true;
  })()`);
  if (!opened) throw new Error("找不到「一键生成视频」快捷按钮");
  await waitFor(async () => evaluate(`!!document.querySelector(".viral-remake-panel")`));
}
async function panelState() {
  return evaluate(`(() => {
    const panel = document.querySelector(".viral-remake-panel");
    if (!panel) return { present: false };
    const ta = panel.querySelector("textarea");
    const inline = !!panel.closest(".chat-input-topbar, .chat-input-wrap, .chat-composer") || !panel.closest(".huashu-panel-dock");
    return { present: true, inline, value: ta ? ta.value : null, running: panel.textContent.includes("正在创作") };
  })()`);
}

// 1) 打开面板（此刻可能是上次会话留下的状态 → 由重开断言覆盖，这里先强制重开两次保证干净）
await openPanel();
await evaluate(`(() => {
  const btn = [...document.querySelectorAll(".viral-remake-actions button")].find(b => (b.textContent || "").trim() === "关闭");
  if (btn && !btn.disabled) btn.click();
})()`);
await new Promise((r) => setTimeout(r, 400));
await openPanel();

let st = await panelState();
if (!st.present || !st.inline) throw new Error("面板没有内联出现在会话里: " + JSON.stringify(st));
if (st.value !== DEFAULT_REQUIREMENT) throw new Error("重开后不是干净默认值: " + JSON.stringify(st.value));
console.log("[ok] 面板内联在会话里，重开是干净默认状态");

// 2) 填需求
const typed = "测试持久化-创作需求XYZ-20261024v2";
await evaluate(`(() => {
  const ta = document.querySelector(".viral-remake-panel textarea");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, ${JSON.stringify(typed)});
  ta.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await new Promise((r) => setTimeout(r, 300));
await shot("genvideo-v2-1-inline-chat.png");

// 3) 切到内容库 → 面板应从 DOM 消失（不再悬浮）
await clickNav("内容库");
st = await panelState();
if (st.present) throw new Error("切到内容库后面板仍在 DOM（期望内联隐藏）");
const noDock = await evaluate(`!document.querySelector(".huashu-panel-dock")`);
if (!noDock) throw new Error("不应再有悬浮窗壳");
console.log("[ok] 切到内容库：面板随会话隐藏，无悬浮壳");

// 4) 切回对话 → 面板回来、内容保留
await clickNav("对话");
st = await panelState();
if (!st.present) throw new Error("切回对话后面板没回来！");
if (st.value !== typed) throw new Error("创作需求丢了: " + JSON.stringify(st.value));
console.log("[ok] 切回对话：面板回来，需求内容保留", st.running ? "(生成中)" : "");
await shot("genvideo-v2-2-back-chat.png");

// 5) 再切定时任务→回来，仍保留
await clickNav("定时任务");
await clickNav("对话");
st = await panelState();
if (!st.present || st.value !== typed) throw new Error("二次往返后状态丢失");
console.log("[ok] 二次往返：状态仍保留");

console.log("\n=== 全部断言通过：内联面板 + 状态跨模块持久 OK ===");
ws.close();
chrome.kill();
process.exit(0);
