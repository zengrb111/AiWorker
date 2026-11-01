/**
 * UI 验证：内容详情页视频跟随后台改片自动更新。
 *
 * 步骤：以大彬登录 → 进内容库 → 打开 huashu 视频条目详情 →
 * 脚本侧把该条目 videoUrl 改成 v99（模拟 Studio 改片 worker 回写）→
 * 断言 12s 轮询 + 快照同步让详情页 <video> 换新 src → 恢复数据 → 断言换回。
 *
 * 用法：node scripts/ui-test-detail-video-sync.mjs
 */
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9334;
const APP = "http://127.0.0.1:3000/";
const USER_ID = "cmu939ge0000b265q7aniwqav"; // 内容归属用户
const SHOT_DIR = join(process.cwd(), ".workbuddy", "tmp");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ITEM_TITLE_PREFIX = "生成ai回忆录宣传片";

function touch(cmd) {
  return execFileSync("node", ["scripts/tmp-content-video-touch.mjs", cmd], { encoding: "utf8" }).trim();
}

const envText = await import("node:fs").then((fs) => fs.readFileSync(join(process.cwd(), ".env.local"), "utf8"));
const secret = envText.match(/^AUTH_SESSION_SECRET="?([^"\r\n]*)"?\s*$/m)?.[1]?.trim();
const payload = `${USER_ID}.${Date.now()}`;
const COOKIE = `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;

const profileDir = mkdtempSync(join(tmpdir(), "cdp-detail-"));
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
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
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

// 进内容库
const clickNav = (label) => evaluate(`(() => {
  const btn = [...document.querySelectorAll(".sidebar nav button")].find(b => (b.querySelector(".nav-label")?.textContent || "").trim() === ${JSON.stringify(label)});
  if (!btn) return false;
  btn.click(); return true;
})()`);
if (!await clickNav("内容库")) throw new Error("找不到内容库导航");
await new Promise((r) => setTimeout(r, 1500));

// 打开目标条目详情（按标题找卡片）
const opened = await evaluate(`(() => {
  const cards = [...document.querySelectorAll(".content-card, [class*=content-card]")];
  const card = cards.find(c => (c.textContent || "").includes(${JSON.stringify(ITEM_TITLE_PREFIX)}));
  if (!card) return false;
  card.click(); return true;
})()`);
if (!opened) throw new Error("没找到目标视频卡片");
await waitFor(async () => evaluate(`!!document.querySelector(".content-detail video")`));
const before = await evaluate(`document.querySelector(".content-detail video")?.getAttribute("src")`);
console.log("[ok] 详情页打开，当前 src =", before);

// 模拟改片回写 v99
console.log("[touch]", touch("fake"));
const fakeUrl = before.replace(/-v\d+\.mp4/, "-v99.mp4");
let updated = false;
const t0 = Date.now();
while (Date.now() - t0 < 40000) {
  await new Promise((r) => setTimeout(r, 2000));
  const src = await evaluate(`document.querySelector(".content-detail video")?.getAttribute("src")`);
  if (src === fakeUrl) { updated = true; break; }
}
if (!updated) throw new Error("40 秒内详情页视频没有换成 v99");
console.log("[ok] 详情页视频已自动换成 v99（轮询+快照同步生效）");
await shot("detail-video-sync-1-fake-v99.png");

// 恢复数据，确认能换回
console.log("[touch]", touch("restore"));
let restored = false;
const t1 = Date.now();
while (Date.now() - t1 < 40000) {
  await new Promise((r) => setTimeout(r, 2000));
  const src = await evaluate(`document.querySelector(".content-detail video")?.getAttribute("src")`);
  if (src === before) { restored = true; break; }
}
if (!restored) throw new Error("恢复后详情页没有换回原视频");
console.log("[ok] 数据已恢复，详情页同步换回原视频");
await shot("detail-video-sync-2-restored.png");

console.log("\n=== 全部断言通过：详情页视频跟随后台回写自动更新 ===");
ws.close();
chrome.kill();
process.exit(0);
