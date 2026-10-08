import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { XhsNote } from "@/lib/xhs-parse";

/**
 * 通过本地已登录浏览器通道（headless Chrome + CDP）读取小红书笔记原文。
 *
 * 为什么需要它：小红书笔记页对服务端直连返回登录页，且**必须带有效的 xsec_token**：
 * - 网页版链接（xsec_source=pc_*）的 token 可用；
 * - App 分享链接（xsec_source=app_share）被小红书限制为「仅支持在 App 内查看」，
 *   桌面端返回 300031、移动端直接提示「App内打开」，程序化拿不到内容。
 *
 * 实现：调用 scripts/xhs-note.mjs（单篇读取器），它用 XHS_COOKIE（或 .xhs-cookie.txt）
 * 注入登录态、打开笔记页、读 window.__INITIAL_STATE__，最后输出一行 JSON。
 */

export type XhsNoteReadResult =
  | { ok: true; note: XhsNote }
  | { ok: false; reason: string; detail: string; message: string };

const CHROME_MISSING_MSG =
  "未找到本机 Chrome（读取小红书需要真实浏览器通道）。若 Chrome 不在默认路径，请设置环境变量 CHROME_PATH。";

/** 把脚本返回的 reason 翻译成给用户看的、可执行的提示。 */
function explain(reason: string, detail: string): string {
  if (reason === "app-share-link" || /app_share|xhs_sec_server|App内打开|仅支持在小红书/i.test(detail)) {
    return [
      "这条链接是「小红书 App 分享链接」（xsec_source=app_share），小红书限制它只能在 App 内打开，程序无法读取原文。",
      "请在电脑浏览器打开这条笔记（可用 App 里的「复制链接」再到浏览器粘贴，或搜索笔记标题打开），",
      "把**地址栏里的完整网址**（形如 https://www.xiaohongshu.com/explore/xxx?xsec_token=...&xsec_source=pc_...）粘贴过来重新仿写。",
      "或者直接把笔记的标题和正文文字粘贴进来，我也能直接拆解仿写。"
    ].join("");
  }
  if (reason === "login") {
    return "小红书登录态已失效：请到「平台授权管理 → 小红书」重新授权（粘贴最新的 Cookie），再试一次。";
  }
  if (reason === "cookie-missing") {
    return "还没有小红书登录凭据：请到「平台授权管理 → 小红书」完成授权（或先同步一次小红书数据），再试一次。";
  }
  if (reason === "bad-url") {
    return "链接格式不对：请粘贴小红书笔记链接（形如 https://www.xiaohongshu.com/explore/…）。";
  }
  if (reason === "no-note") {
    return "打开后没读到笔记数据：可能是笔记已删除 / 被限流，或链接缺少 xsec_token。可换一条链接，或直接把正文粘贴进来。";
  }
  if (reason === "timeout") {
    return "读取超时：小红书页面加载太慢或被风控拦截，请稍后重试。";
  }
  return `读取失败：${detail}`;
}

export async function fetchXhsNoteViaBrowser(
  url: string,
  opts: { cookie?: string | null; timeoutMs?: number } = {}
): Promise<XhsNoteReadResult> {
  const root = process.cwd();
  const script = path.join(root, "scripts", "xhs-note.mjs");
  if (!fs.existsSync(script)) {
    return { ok: false, reason: "error", detail: "缺少 scripts/xhs-note.mjs", message: "服务端缺少小红书读取脚本。" };
  }
  const timeoutMs = opts.timeoutMs ?? 90_000;

  const child = spawn(process.execPath, [script, url], {
    cwd: root,
    env: {
      ...process.env,
      ...(opts.cookie ? { XHS_COOKIE: opts.cookie } : {})
    }
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  const finished = new Promise<void>((resolve) => {
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });

  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }, timeoutMs);
  await finished;
  clearTimeout(timer);

  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const lastLine = lines.reverse().find((l) => l.startsWith("{"));
  if (!lastLine) {
    const detail = stderr.trim().slice(0, 300) || "脚本无输出";
    return {
      ok: false,
      reason: /chrome/i.test(detail) && /ENOENT|not found/i.test(detail) ? "no-chrome" : "error",
      detail,
      message: /ENOENT|not found/i.test(detail) && /chrome/i.test(detail) ? CHROME_MISSING_MSG : explain("error", detail)
    };
  }

  let parsed: {
    ok?: boolean;
    reason?: string;
    detail?: string;
    note?: XhsNote;
  } = {};
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    return { ok: false, reason: "error", detail: lastLine.slice(0, 300), message: explain("error", lastLine) };
  }

  if (parsed.ok && parsed.note) {
    const note = parsed.note;
    if (!note.title && !note.desc) {
      return { ok: false, reason: "no-note", detail: "读到笔记对象但内容为空", message: explain("no-note", "") };
    }
    return { ok: true, note };
  }

  const reason = parsed.reason || "error";
  const detail = parsed.detail || "";
  return { ok: false, reason, detail, message: explain(reason, detail) };
}
