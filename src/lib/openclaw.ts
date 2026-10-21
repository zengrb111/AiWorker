import { createRequire } from "module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { sign, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import QRCode from "qrcode";
import { ensureUserAgent, userAgentId } from "./openclaw-user-agent";

/**
 * 调用网关跑一轮 agent 对话的请求体。
 *
 * sessionKey 是**用户隔离的唯一凭据**：OpenClaw 侧按它区分不同用户的
 * 会话上下文与记忆，传错会把两个用户的消息混进同一个会话。
 */
export type OpenClawTaskRequest = {
  message: string;
  context?: string;
  prompt?: string;
  conversationId?: string;
  userId?: string;
  /**
   * 指定会话（可选）。后台任务（如短视频渲染）应传入独立会话，
   * 避免与用户实时对话抢同一个 agent:u-<id>:* 会话而排到队尾超时。
   * 不传则按 userId 派生默认会话，行为与改造前一致。
   */
  sessionKey?: string;
  /** 等待 agent 最终回复的超时（毫秒）。不传用 OPENCLAW_CHAT_TIMEOUT_MS（默认 120 秒）。 */
  timeoutMs?: number;
  /**
   * 空返回时是否自动重跑一次（默认 true）。**有副作用的任务必须传 false**：
   * 重跑 = 整个任务再执行一遍（重复入库/重复发布）。
   */
  retryOnEmpty?: boolean;
};

export type OpenClawTaskResult = {
  taskId?: string;
  content: string;
  title?: string;
  coverImageUrl?: string;
  inlineImages?: string[];
  raw: unknown;
};

export type OpenClawQr = {
  ticketId: string;
  qrCodeUrl?: string;
  qrCodeText?: string;
};

export type OpenClawBindingStatus = {
  status: "pending" | "bound" | "unbound";
  ticketId?: string;
  wechatNickname?: string;
  wechatOpenId?: string;
  wechatNo?: string;
  /**
   * 网关是否**新签发**了凭据。
   *
   * false 表示微信服务端没有发新凭据 —— 典型是 binded_redirect（该微信号
   * 之前已绑过本网关，而微信服务端没有解绑接口）。这种情况下通道凭据
   * 必须靠本机已有记录恢复，否则网关不会启动微信通道（表现为「绑定成功
   * 但微信发消息没回复」）。调用方据此决定是否走恢复路径。
   */
  credentialsIssued?: boolean;
};

type GatewaySocket = {
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
};

type GatewayResponse = {
  type?: string;
  id?: string;
  ok?: boolean;
  payload?: unknown;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

type WeixinLoginModule = {
  startWeixinLoginWithQr(opts: {
    force?: boolean;
    verbose?: boolean;
    accountId?: string;
    apiBaseUrl: string;
    botType?: string;
  }): Promise<{
    qrcodeUrl?: string;
    message: string;
    sessionKey: string;
  }>;
  waitForWeixinLogin(opts: {
    timeoutMs?: number;
    verbose?: boolean;
    sessionKey: string;
    apiBaseUrl: string;
    botType?: string;
  }): Promise<{
    connected: boolean;
    alreadyConnected?: boolean;
    /** 扫码成功后由微信服务器签发的 bot token，需落盘才能启用通道。 */
    botToken?: string;
    accountId?: string;
    /** 部分环境会返回该账号专属的 api base url。 */
    baseUrl?: string;
    userId?: string;
    message: string;
  }>;
};

const nodeRequire = createRequire(import.meta.url);
const WebSocket = nodeRequire("next/dist/compiled/ws") as new (
  url: string,
  options?: { origin?: string }
) => GatewaySocket;

function requireBaseUrl(): string {
  const baseUrl = process.env.OPENCLAW_BASE_URL;
  if (!baseUrl) {
    throw new Error("OPENCLAW_BASE_URL is not configured.");
  }
  return baseUrl.replace(/\/$/, "");
}

function gatewayUrl(): string {
  const configured = process.env.OPENCLAW_GATEWAY_WS_URL;
  if (configured) {
    return configured;
  }
  const url = new URL(requireBaseUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function gatewayOrigin(): string {
  return process.env.OPENCLAW_GATEWAY_ORIGIN || requireBaseUrl();
}

const WEIXIN_PLUGIN_PACKAGE_SEGMENT = path.join(
  "node_modules",
  "@tencent-weixin",
  "openclaw-weixin"
);
const WEIXIN_PROJECTS_DIR = path.join(homedir(), ".openclaw", "npm", "projects");
/** 兜底：全新的动态解析失败时，仍回退到历史 base 目录（可能已过旧）。 */
const LEGACY_WEIXIN_LOGIN_MODULE = path.join(
  WEIXIN_PROJECTS_DIR,
  "tencent-weixin-openclaw-weixin-7783ac86ba",
  WEIXIN_PLUGIN_PACKAGE_SEGMENT,
  "dist",
  "src",
  "auth",
  "login-qr.js"
);

function parseVersionRank(version: string): number[] {
  return version
    .split(/[.\-+]/)
    .map((segment) => Number.parseInt(segment, 10))
    .map((value) => (Number.isFinite(value) ? value : 0));
}

function compareVersionRank(a: string, b: string): number {
  const left = parseVersionRank(a);
  const right = parseVersionRank(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 解析当前激活的微信插件登录模块路径。
 *
 * OpenClaw 2026.10 起改为「代际目录」安装插件：
 *   ~/.openclaw/npm/projects/<name>__openclaw-generation__<hash>/…
 * 旧的 base 目录（<name>/）会停留在升级前的旧版本。插件升级后若继续加载
 * 写死的 base 路径，会拿到过旧插件（例如 2.4.6 仍 import 已被核心移除的
 * `openclaw/plugin-sdk/infra-runtime`）而报错。
 *
 * 因此这里扫描全部候选目录，取版本最高者（版本相同则优先代际目录）。
 */
function resolveWeixinLoginModulePath(): string | null {
  let dirNames: string[];
  try {
    dirNames = readdirSync(WEIXIN_PROJECTS_DIR);
  } catch {
    return null;
  }

  const candidates = dirNames.filter((name) =>
    name.startsWith("tencent-weixin-openclaw-weixin")
  );

  let best: {
    modulePath: string;
    version: string;
    isGeneration: boolean;
  } | null = null;

  for (const name of candidates) {
    const pluginDir = path.join(WEIXIN_PROJECTS_DIR, name, WEIXIN_PLUGIN_PACKAGE_SEGMENT);
    const modulePath = path.join(pluginDir, "dist", "src", "auth", "login-qr.js");
    if (!existsSync(modulePath)) continue;

    let version = "0.0.0";
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(pluginDir, "package.json"), "utf8")
      ) as { version?: string };
      if (typeof pkg.version === "string") version = pkg.version;
    } catch {
      // 读不到版本号时按最低优先级处理，但不丢弃该候选。
    }

    const isGeneration = name.includes("__openclaw-generation__");
    const versionCmp = best ? compareVersionRank(version, best.version) : 1;
    if (
      !best ||
      versionCmp > 0 ||
      (versionCmp === 0 && isGeneration && !best.isGeneration)
    ) {
      best = { modulePath, version, isGeneration };
    }
  }

  return best ? best.modulePath : null;
}

function weixinLoginModulePath(): string {
  const override = process.env.OPENCLAW_WEIXIN_LOGIN_MODULE;
  if (override) return override;
  return resolveWeixinLoginModulePath() ?? LEGACY_WEIXIN_LOGIN_MODULE;
}

async function importWeixinLoginModule(): Promise<WeixinLoginModule> {
  const pluginPath = weixinLoginModulePath();
  const runtimeImport = new Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<unknown>;
  return (await runtimeImport(pathToFileURL(pluginPath).href)) as WeixinLoginModule;
}

/**
 * 模块级缓存：微信登录插件是 ESM，首次动态 import 需要解析并编译整个依赖树，
 * 冷启动（dev server 刚启动 / 该路由首次被访问）耗时可达十几秒。缓存住 import
 * 结果，避免每次生成二维码都重新走一遍。
 */
let weixinLoginModulePromise: Promise<WeixinLoginModule> | null = null;

function loadWeixinLoginModule(): Promise<WeixinLoginModule> {
  if (!weixinLoginModulePromise) {
    weixinLoginModulePromise = importWeixinLoginModule().catch((error) => {
      // 加载失败不要留下坏缓存，下次调用重新尝试。
      weixinLoginModulePromise = null;
      throw error;
    });
  }
  return weixinLoginModulePromise;
}

/**
 * 预热微信登录插件。供服务端在渲染登录页时 fire-and-forget 调用，
 * 让用户点「注册」时插件已就绪，避免长时间等待触发前端超时。
 */
export async function warmupWeixinLoginModule(): Promise<void> {
  try {
    await loadWeixinLoginModule();
  } catch {
    // 预热失败无所谓：真正生成二维码时会重试并抛出具体错误。
  }
}

/** 给一个 Promise 加超时保护，超时抛中文错误，避免请求无限挂起。 */
async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const WEIXIN_PLUGIN_LOAD_TIMEOUT_MS = Number(
  process.env.OPENCLAW_WEIXIN_PLUGIN_LOAD_TIMEOUT_MS ?? 30000
);
const WEIXIN_QR_TIMEOUT_MS = Number(
  process.env.OPENCLAW_WEIXIN_QR_TIMEOUT_MS ?? 40000
);

/** 把插件返回的底层英文错误翻译成用户能看懂的中文提示。 */
function weixinLoginErrorMessage(raw?: string): string {
  const detail = (raw ?? "").replace(/^Failed to start login:\s*/i, "").trim();
  if (!detail) {
    return "微信插件未返回二维码，请稍后重试。";
  }
  if (/abort|timeout|timed out|ETIMEDOUT|UND_ERR/i.test(detail)) {
    return "请求微信服务器超时（网络较慢或被拦截），请重试。";
  }
  return `微信二维码生成失败：${detail}`;
}

// ---------------------------------------------------------------------------
// 微信通道凭据落盘
//
// 扫码登录成功后必须落盘三件事，否则网关不会启动微信通道，微信端会一直显示
// 「暂无法连接 OpenClaw」：
//   1. 账号凭据 ~/.openclaw/openclaw-weixin/accounts/<id>.json（token / baseUrl / userId）
//   2. 账号索引 ~/.openclaw/openclaw-weixin/accounts.json
//   3. 配置时间戳 ~/.openclaw/openclaw.json → channels.openclaw-weixin.channelConfigUpdatedAt
//      （网关靠这个时间戳变化热加载通道配置）
// 官方 `openclaw channels login` 与网关 web.login 流程都会做这几步。
// ---------------------------------------------------------------------------

/** 插件账号模块导出的持久化 / 清理函数。 */
type WeixinAccountsModule = {
  saveWeixinAccount(
    accountId: string,
    update: { token?: string; baseUrl?: string; userId?: string }
  ): void;
  registerWeixinAccountId(accountId: string): void;
  clearStaleAccountsForUserId(
    accountId: string,
    userId: string,
    onClearContextTokens?: (accountId: string) => void
  ): void;
  /** 已扫码登录过的账号 id 索引。 */
  listIndexedWeixinAccountIds(): string[];
  loadWeixinAccount(accountId: string): {
    token?: string;
    baseUrl?: string;
    userId?: string;
  } | null;
  /** 删除账号凭据、sync buf、context tokens 与授权名单。 */
  clearWeixinAccount(accountId: string): void;
  unregisterWeixinAccountId(accountId: string): void;
};

/** 账号模块与登录模块同在 dist/src/auth/ 下。 */
function weixinAccountsModulePath(): string {
  const configured = process.env.OPENCLAW_WEIXIN_ACCOUNTS_MODULE;
  if (configured) return configured;
  return path.join(path.dirname(weixinLoginModulePath()), "accounts.js");
}

let weixinAccountsModulePromise: Promise<WeixinAccountsModule> | null = null;

function loadWeixinAccountsModule(): Promise<WeixinAccountsModule> {
  if (!weixinAccountsModulePromise) {
    weixinAccountsModulePromise = (async () => {
      const runtimeImport = new Function("specifier", "return import(specifier)") as (
        specifier: string
      ) => Promise<unknown>;
      return (await runtimeImport(
        pathToFileURL(weixinAccountsModulePath()).href
      )) as WeixinAccountsModule;
    })().catch((error) => {
      weixinAccountsModulePromise = null;
      throw error;
    });
  }
  return weixinAccountsModulePromise;
}

const VALID_ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_ACCOUNT_ID_CHARS_RE = /[^a-z0-9_-]+/g;

/**
 * 复刻 OpenClaw 的 normalizeAccountId：把原始 bot id（如 "8d67e4e6a7df@im.bot"）
 * 规范成文件系统安全的 key（"8d67e4e6a7df-im-bot"）。
 */
function normalizeWeixinAccountId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "default";
  if (VALID_ACCOUNT_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  const canonical = trimmed
    .toLowerCase()
    .replace(INVALID_ACCOUNT_ID_CHARS_RE, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return canonical || "default";
}

/**
 * 把 DB 里存的微信标识解析成 OpenClaw 的账号 id。
 * 历史数据里 `wechatOpenId` 可能存 bot id（xxx@im.bot），也可能存 userId（xxx@im.wechat）。
 */
function resolveBoundWeixinAccountId(
  accountRef: string,
  accounts: WeixinAccountsModule
): string {
  const direct = normalizeWeixinAccountId(accountRef);
  const indexed = accounts.listIndexedWeixinAccountIds();
  if (indexed.includes(direct)) return direct;

  // 存的是 userId 的情况：按凭据里的 userId 反查真正的账号 id。
  for (const id of indexed) {
    const data = accounts.loadWeixinAccount(id);
    if (data?.userId && data.userId === accountRef.trim()) return id;
  }
  return direct;
}

function openClawConfigPath(): string {
  const configured = process.env.OPENCLAW_CONFIG?.trim();
  if (configured) return configured;
  return path.join(homedir(), ".openclaw", "openclaw.json");
}

/**
 * 更新 channels.openclaw-weixin.channelConfigUpdatedAt，触发网关重新从磁盘
 * 加载通道配置。等价于插件内部的 triggerWeixinChannelReload()，这里直接操作
 * 配置文件，避免依赖插件包内捆绑的 openclaw 版本。
 */
async function bumpWeixinChannelConfig(): Promise<void> {
  try {
    const configPath = openClawConfigPath();
    // 历史配置里出现过 BOM，解析前先剥掉。
    const raw = readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const existing = (channels["openclaw-weixin"] ?? {}) as Record<string, unknown>;
    cfg.channels = {
      ...channels,
      "openclaw-weixin": {
        ...existing,
        channelConfigUpdatedAt: new Date().toISOString()
      }
    };
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  } catch (error) {
    // 配置写入失败不应让绑定流程失败：凭据已落盘，通道配置下次登录还会重试。
    console.warn(
      `[openclaw] 更新微信通道配置失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * 把扫码登录结果持久化成 OpenClaw 可用的微信通道配置。
 * 漏掉任何一步，通道都不会被网关启动。
 */
async function persistWeixinBinding(result: {
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
}): Promise<void> {
  if (!result.accountId || !result.botToken) return;

  const accounts = await loadWeixinAccountsModule();
  const accountId = normalizeWeixinAccountId(result.accountId);

  accounts.saveWeixinAccount(accountId, {
    token: result.botToken,
    baseUrl: result.baseUrl,
    userId: result.userId
  });
  accounts.registerWeixinAccountId(accountId);
  if (result.userId) {
    accounts.clearStaleAccountsForUserId(accountId, result.userId);
  }
  await bumpWeixinChannelConfig();
}

/** 读账号凭据，插件内部抛错时按「没有」处理，不让恢复流程整体崩掉。 */
function safeLoadWeixinAccount(
  accounts: WeixinAccountsModule,
  accountId: string
): { token?: string; baseUrl?: string; userId?: string } | null {
  try {
    return accounts.loadWeixinAccount(accountId);
  } catch {
    return null;
  }
}

/**
 * binded_redirect 场景下，用本机已保存的凭据把微信通道重新拉起来。
 *
 * 背景：微信服务端**没有解绑接口**，同一微信号再次扫码只会返回
 * binded_redirect —— 网关不签发新凭据，waitForWeixinLogin 拿不到
 * botToken / accountId。原先 persistWeixinBinding 在这种情况下直接 return，
 * 于是：平台侧以为绑定成功，网关侧通道却从没启动过，用户从微信发消息
 * 永远没回复（静默失败）。
 *
 * 这里从本机已落盘的账号凭据里找出该用户的账号，重新写一遍并更新时间戳，
 * 让网关重新从磁盘加载通道 —— 效果与正常绑定流程的第三步一致。
 *
 * 找不到可用凭据时返回 null，由调用方**如实报错**，绝不谎报绑定成功。
 */
async function restoreWeixinChannelFromStoredAccount(
  identity: { wechatOpenId?: string; wechatNo?: string }
): Promise<{ accountId: string } | null> {
  const openId = identity.wechatOpenId?.trim();
  const no = identity.wechatNo?.trim();
  if (!openId && !no) return null;

  let accounts: WeixinAccountsModule;
  try {
    accounts = await loadWeixinAccountsModule();
  } catch {
    return null;
  }

  // 候选账号 id：先按 bot id 直解，再按凭据里的 userId 反查
  // （历史数据里 wechatOpenId 存的可能是 userId 而非 bot id）。
  const candidates: string[] = [];
  const pushCandidate = (id: string) => {
    if (id && !candidates.includes(id)) candidates.push(id);
  };
  if (openId) pushCandidate(normalizeWeixinAccountId(openId));

  let indexed: string[] = [];
  try {
    indexed = accounts.listIndexedWeixinAccountIds();
  } catch {
    indexed = [];
  }
  if (no) {
    for (const id of indexed) {
      const data = safeLoadWeixinAccount(accounts, id);
      if (data?.userId && data.userId === no) pushCandidate(id);
    }
  }

  for (const accountId of candidates) {
    const data = safeLoadWeixinAccount(accounts, accountId);
    if (!data?.token) continue;
    try {
      // 重新落盘 + 更新时间戳 = 触发网关重载通道配置。
      accounts.saveWeixinAccount(accountId, {
        token: data.token,
        baseUrl: data.baseUrl,
        userId: data.userId
      });
      accounts.registerWeixinAccountId(accountId);
      await bumpWeixinChannelConfig();
    } catch {
      continue;
    }
    return { accountId };
  }
  return null;
}

function weixinApiBaseUrl(): string {
  return process.env.OPENCLAW_WEIXIN_API_BASE_URL || "https://ilinkai.weixin.qq.com";
}

// ---------------------------------------------------------------------------
// 微信主动投递（确定性，绕开 agent 的 --announce 工具调用）
//
// 痛点：原先让 agent 在独立回合里调 `--announce --channel openclaw-weixin` 推送，
// agent 不保证真的调工具 → 用户收不到通知（实测三次均失败）。
// 改为由平台直接持机器人 token 调微信官方 `ilink/bot/sendmessage`，100% 可控送达。
// 凭据复用平台已有的微信账号模块（loadWeixinAccountsModule），不做任何新增落盘。
// ---------------------------------------------------------------------------

type WeixinApiModule = {
  sendMessage(params: {
    baseUrl: string;
    token: string;
    timeoutMs?: number;
    body: Record<string, unknown>;
  }): Promise<{ message_id?: string | number }>;
};

/** 插件 api.js 路径（与账号模块同源，均在 dist/src/api 下）。 */
function weixinApiModulePath(): string {
  const configured = process.env.OPENCLAW_WEIXIN_API_MODULE;
  if (configured) return configured;
  // weixinLoginModulePath() 返回 .../dist/src/auth/login-qr.js
  // api.js 在其同级目录 .../dist/src/api/api.js
  return path.join(path.dirname(weixinLoginModulePath()), "..", "api", "api.js");
}

let weixinApiModulePromise: Promise<WeixinApiModule> | null = null;

function loadWeixinApiModule(): Promise<WeixinApiModule> {
  if (!weixinApiModulePromise) {
    weixinApiModulePromise = (async () => {
      const runtimeImport = new Function("specifier", "return import(specifier)") as (
        specifier: string
      ) => Promise<unknown>;
      return (await runtimeImport(
        pathToFileURL(weixinApiModulePath()).href
      )) as WeixinApiModule;
    })().catch((error) => {
      weixinApiModulePromise = null;
      throw error;
    });
  }
  return weixinApiModulePromise;
}

/**
 * 把一段文本通过微信直接推送给指定收件人（确定性投递，不经过 agent）。
 *
 * @param accountRef 绑定记录里存的 bot 标识（wechatOpenId，形如 xxx@im.bot）
 * @param to         收件人 wechatNo（形如 xxx@im.wechat）
 * @param text       要发送的正文
 */
export async function deliverWechatMessage(
  accountRef: string,
  to: string,
  text: string
): Promise<{ messageId?: string | number }> {
  const trimmedTo = (to || "").trim();
  if (!trimmedTo.endsWith("@im.wechat")) {
    throw new Error(`非法微信收件人（必须以 @im.wechat 结尾）：${to}`);
  }
  const accounts = await loadWeixinAccountsModule();
  const accountId = resolveBoundWeixinAccountId(accountRef, accounts);
  const acct = accounts.loadWeixinAccount(accountId);
  if (!acct?.token) {
    throw new Error(`微信账号 ${accountId} 未配置 token，无法投递。`);
  }
  const api = await loadWeixinApiModule();
  const clientId = `platform-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: trimmedTo,
      client_id: clientId,
      message_type: 2, // MessageType.BOT
      message_state: 2, // MessageState.FINISH
      item_list: [{ type: 1, text_item: { text } }] // MessageItemType.TEXT
    }
  };
  const resp = await api.sendMessage({
    baseUrl: acct.baseUrl || weixinApiBaseUrl(),
    token: acct.token,
    timeoutMs: 15_000,
    body
  });
  return { messageId: resp?.message_id };
}

async function renderQrImageDataUrl(value: string): Promise<string> {
  if (value.startsWith("data:image/")) {
    return value;
  }
  return QRCode.toDataURL(value, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320
  });
}

function gatewayErrorMessage(error: GatewayResponse["error"]): string {
  if (!error) {
    return "Gateway request failed.";
  }
  const detail = error.details ? ` ${JSON.stringify(error.details)}` : "";
  return `${error.message ?? error.code ?? "Gateway request failed."}${detail}`;
}

// ---------------------------------------------------------------------------
// Device authentication (Ed25519 challenge-response)
//
// OpenClaw's gateway requires device-level authentication in addition to the
// shared operator token. After the WebSocket opens, the server sends a
// `connect.challenge` event containing a nonce. The client must sign
//   "v2|<deviceId>|<clientId>|<clientMode>|<role>|<scopes>|<signedAt>|<token>|<nonce>"
// with the device's Ed25519 private key and include the signature in the
// `device` field of the `connect` request.
// ---------------------------------------------------------------------------

type DeviceCredentials = {
  deviceId: string;
  privateKeyPem: string;
  publicKeyB64Url: string;
  operatorToken: string;
};

let cachedDeviceCreds: DeviceCredentials | null = null;

function pubKeyB64UrlFromPem(publicKeyPem: string): string {
  const pubObj = createPublicKey({
    key: publicKeyPem,
    format: "pem",
    type: "spki",
  });
  const pubDer = pubObj.export({ type: "spki", format: "der" });
  return pubDer.subarray(pubDer.length - 32).toString("base64url");
}

/**
 * OpenClaw >= 2026.10 keeps the device identity keypair in the shared-state
 * SQLite database (`device_identities`) and the paired-device operator token in
 * `device_pairing_paired.tokens_json`; it retires the legacy
 * `identity/device.json` + `identity/device-auth.json` files (and actually
 * refuses to start when those legacy files reappear). Prefer SQLite, and fall
 * back to the legacy files only for older OpenClaw versions.
 */
function readDeviceCredentialsFromStateSqlite(
  home: string
): DeviceCredentials | null {
  const candidates = [
    `${home}/.openclaw/state/openclaw.sqlite`,
    process.env.OPENCLAW_STATE_DIR
      ? `${process.env.OPENCLAW_STATE_DIR}/state/openclaw.sqlite`
      : "",
  ].filter(Boolean);

  for (const dbPath of candidates) {
    if (!existsSync(dbPath)) continue;
    let db:
      | {
          prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
          close: () => void;
        }
      | null = null;
    try {
      const { DatabaseSync } = nodeRequire("node:sqlite") as {
        DatabaseSync: new (
          path: string,
          opts?: { readOnly?: boolean }
        ) => {
          prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
          close: () => void;
        };
      };
      db = new DatabaseSync(dbPath, { readOnly: true });

      const identity = db
        .prepare(
          "SELECT device_id, public_key_pem, private_key_pem FROM device_identities WHERE identity_key = ?"
        )
        .get("primary") as
        | {
            device_id?: string;
            public_key_pem?: string;
            private_key_pem?: string;
          }
        | undefined;
      if (
        !identity?.device_id ||
        !identity.public_key_pem ||
        !identity.private_key_pem
      ) {
        continue;
      }

      const pairing = db
        .prepare(
          "SELECT tokens_json FROM device_pairing_paired WHERE device_id = ?"
        )
        .get(identity.device_id) as { tokens_json?: string } | undefined;
      let operatorToken = "";
      if (pairing?.tokens_json) {
        try {
          operatorToken = String(
            JSON.parse(pairing.tokens_json)?.operator?.token ?? ""
          );
        } catch {
          operatorToken = "";
        }
      }
      if (!operatorToken) continue;

      return {
        deviceId: identity.device_id,
        privateKeyPem: identity.private_key_pem,
        publicKeyB64Url: pubKeyB64UrlFromPem(identity.public_key_pem),
        operatorToken,
      };
    } catch {
      // Try the next candidate path; otherwise fall back to the legacy files.
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function loadDeviceCredentials(): DeviceCredentials {
  if (cachedDeviceCreds) return cachedDeviceCreds;
  const home = homedir();

  // Preferred source: OpenClaw shared-state SQLite (>= 2026.10).
  const fromSqlite = readDeviceCredentialsFromStateSqlite(home);
  if (fromSqlite) {
    cachedDeviceCreds = fromSqlite;
    return cachedDeviceCreds;
  }

  // Legacy fallback: identity/device.json + identity/device-auth.json.
  // 两条来源都缺失时，readFileSync 抛的是裸 ENOENT（路径还可能因字符串拼接
  // 而在 Windows 上出现分隔符问题），界面完全无法判断是哪一步缺了东西。
  // 这里统一转成带诊断标记的错误，让上层能分类成「凭据缺失」并给出修复指引。
  const devicePath = path.join(home, ".openclaw", "identity", "device.json");
  const authPath = path.join(home, ".openclaw", "identity", "device-auth.json");
  const missing = [devicePath, authPath].filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw gatewayError(
      classifyGatewayError(
        new Error(`设备凭据文件不存在：${missing.join("、")}`)
      )
    );
  }

  let dev: { deviceId: string; publicKeyPem: string; privateKeyPem: string };
  let devAuth: { tokens: { operator: { token: string } } };
  try {
    dev = JSON.parse(readFileSync(devicePath, "utf8")) as typeof dev;
    devAuth = JSON.parse(readFileSync(authPath, "utf8")) as typeof devAuth;
  } catch (error) {
    throw gatewayError(
      classifyGatewayError(
        new Error(
          `设备凭据文件无法解析（${devicePath} / ${authPath}）：${
            error instanceof Error ? error.message : String(error)
          }`
        )
      )
    );
  }

  const opToken = devAuth.tokens?.operator?.token;
  if (!opToken) {
    throw gatewayError(
      classifyGatewayError(
        new Error(`设备认证文件中未找到 operator token：${authPath}`)
      )
    );
  }

  cachedDeviceCreds = {
    deviceId: dev.deviceId,
    privateKeyPem: dev.privateKeyPem,
    publicKeyB64Url: pubKeyB64UrlFromPem(dev.publicKeyPem),
    operatorToken: opToken,
  };
  return cachedDeviceCreds;
}

function buildDeviceField(nonce: string) {
  const creds = loadDeviceCredentials();
  const signedAt = Date.now();
  const scopes = ["operator.admin"];
  const msg = [
    "v2",
    creds.deviceId,
    "cli",
    "cli",
    "operator",
    scopes.join(","),
    String(signedAt),
    creds.operatorToken,
    nonce,
  ].join("|");
  const signature = sign(
    null,
    Buffer.from(msg, "utf8"),
    { key: creds.privateKeyPem, format: "pem", type: "pkcs8" }
  ).toString("base64url");
  return {
    id: creds.deviceId,
    publicKey: creds.publicKeyB64Url,
    signature,
    signedAt,
    nonce,
  };
}

// ---------------------------------------------------------------------------
// Gateway connection
//
// Opens a WebSocket, waits for the `connect.challenge` event, signs it with
// the device private key, sends the `connect` request with device auth, and
// returns a connection object that can be used to call gateway methods and
// subscribe to events.
// ---------------------------------------------------------------------------

type GatewayConnection = {
  request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T>;
  onEvent(handler: (event: string, payload: unknown) => void): void;
  close(): void;
};

async function connectGateway(connectTimeoutMs = 15000): Promise<GatewayConnection> {
  return new Promise<GatewayConnection>((resolve, reject) => {
    const ws = new WebSocket(gatewayUrl(), { origin: gatewayOrigin() });
    const pending = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    const timers = new Set<NodeJS.Timeout>();
    const eventHandlers: Array<(event: string, payload: unknown) => void> = [];
    let nonceResolve: ((value: string) => void) | null = null;
    const noncePromise = new Promise<string>((resolveNonce) => {
      nonceResolve = resolveNonce;
    });
    let settled = false;

    function cleanup() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      pending.clear();
      eventHandlers.length = 0;
      try {
        ws.close();
      } catch {
        // Ignore close errors from an already closed socket.
      }
    }

    function sendRequest(
      method: string,
      params: Record<string, unknown>,
      timeoutMs: number
    ): Promise<unknown> {
      const id = crypto.randomUUID();
      ws.send(JSON.stringify({ type: "req", id, method, params }));
      return new Promise<unknown>((requestResolve, requestReject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          requestReject(new Error(`OpenClaw Gateway 调用超时：${method}`));
        }, timeoutMs);
        timers.add(timer);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            timers.delete(timer);
            requestResolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            timers.delete(timer);
            requestReject(error);
          },
        });
      });
    }

    ws.on("message", (data) => {
      let message: {
        type?: string;
        id?: string;
        ok?: boolean;
        payload?: unknown;
        error?: GatewayResponse["error"];
        event?: string;
      };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }

      // Capture the connect.challenge nonce.
      if (message.type === "event" && message.event === "connect.challenge") {
        const payload = message.payload as { nonce?: string } | undefined;
        if (nonceResolve) {
          nonceResolve(payload?.nonce || "");
          nonceResolve = null;
        }
        return;
      }

      // Route responses to pending requests.
      if (message.type === "res" && message.id) {
        const request = pending.get(message.id);
        if (request) {
          pending.delete(message.id);
          if (message.ok) {
            request.resolve(message.payload);
          } else {
            request.reject(new Error(gatewayErrorMessage(message.error)));
          }
        }
        return;
      }

      // Forward other events to registered handlers.
      if (message.type === "event" && message.event) {
        for (const handler of eventHandlers) {
          handler(message.event, message.payload);
        }
      }
    });

    ws.on("error", (error) => {
      if (nonceResolve) {
        nonceResolve("");
        nonceResolve = null;
      }
      // 把 error.code 一并写进 message。Node 的 ws 在部分错误形态下不填 message
      // （只保留 code），此前直接取 error.message 会得到空串，界面显示成
      // 「连接失败：」且 isGatewayTransientError 匹配不到任何关键词 →
      // 跳过了 150 秒重试等待。补上 code 后两个问题同时消失，
      // 且无需改动重试控制流。
      const raw = error instanceof Error ? error.message : String(error);
      const code = errorCodeOf(error);
      const reason = code ? `[${code}] ${raw || "(无错误描述)"}` : raw || "(无错误描述)";
      const diagnosis = classifyGatewayError(error);

      const failure = gatewayError({
        ...diagnosis,
        detail: `${reason}（目标 ${gatewayEndpointLabel()}）`,
      });
      if (process.env.NODE_ENV !== "production") {
        console.error(
          `[openclaw] 网关连接失败 kind=${diagnosis.kind} transient=${diagnosis.transient} ${reason}`,
        );
      }

      for (const [, request] of pending) {
        request.reject(failure);
      }
      pending.clear();
      if (!settled) {
        cleanup();
        reject(failure);
      }
    });

    ws.on("close", (code, reason) => {
      if (nonceResolve) {
        nonceResolve("");
        nonceResolve = null;
      }
      if (pending.size > 0) {
        const closeError = new Error(
          `OpenClaw Gateway 已关闭：${code} ${String(reason)}`.trim()
        );
        for (const [, request] of pending) {
          request.reject(closeError);
        }
        pending.clear();
      }
    });

    ws.on("open", async () => {
      try {
        // Wait for the connect.challenge event (5 s timeout).
        const timeoutId = setTimeout(() => {
          if (nonceResolve) {
            nonceResolve("");
            nonceResolve = null;
          }
        }, 5000);
        timers.add(timeoutId);

        const nonce = await noncePromise;
        clearTimeout(timeoutId);
        timers.delete(timeoutId);

        if (!nonce) {
          throw new Error(
            "OpenClaw Gateway 未发送 connect.challenge 质询。"
          );
        }

        const device = buildDeviceField(nonce);
        const creds = loadDeviceCredentials();

        await sendRequest(
          "connect",
          {
            minProtocol: 4,
            maxProtocol: 4,
            client: {
              id: "cli",
              version: "chuangxingyun-0.1.0",
              platform: "win32",
              mode: "cli",
            },
            role: "operator",
            scopes: ["operator.admin"],
            caps: ["tool-events"],
            auth: { token: creds.operatorToken },
            device,
            userAgent: "Chuangxingyun AI Worker",
            locale: "zh-CN",
          },
          connectTimeoutMs
        );

        settled = true;
        resolve({
          request<T = unknown>(
            method: string,
            params: Record<string, unknown>,
            timeoutMs = 45000
          ) {
            return sendRequest(method, params, timeoutMs) as Promise<T>;
          },
          onEvent(handler: (event: string, payload: unknown) => void) {
            eventHandlers.push(handler);
          },
          close: cleanup,
        });
      } catch (error) {
        if (!settled) {
          cleanup();
          reject(
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// One-shot gateway call (connect → method → close)
// ---------------------------------------------------------------------------

async function requestGateway<T>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 45000
): Promise<T> {
  const conn = await connectGateway();
  try {
    return await conn.request<T>(method, params, timeoutMs);
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// Agent 对话（chat.startup / chat.send + 事件流）
//
// 协议（2026-10-17 从 git 历史恢复，与改造前逐字一致）：
//   1. chat.startup { sessionKey }          → 初始化会话
//   2. chat.send { sessionKey, message }    → 立即返回 runId
//   3. 监听 `chat` 事件直到 state === "final" 且 runId 匹配，
//      正文取 payload.message.content[].text
// delta 事件持续累加：超时或 final 为空时也能退回已收到的部分内容，
// 不会让用户白等一轮。
// ---------------------------------------------------------------------------

type ChatContentItem = { type: string; text: string };

/**
 * 每个平台用户对应一个 OpenClaw agent id：`u-<userId>`。
 *
 * 记忆（MEMORY.md / memory/*.md）、会话记录、memory_search、sessions_* 工具
 * 在 OpenClaw 里都是**按 agent** 隔离的（agent = 独立 workspace + 独立会话库）。
 * 一个用户一个 agent，多租户隔离才落到网关原生边界上，而不是靠 prompt 软约束。
 *
 * 装配（建 workspace + 写 agents.entries）见 `openclaw-user-agent.ts`：
 * 注册时自动装配，聊天/调度链路发消息前再兜一层，避免出现
 * `Agent "u-<id>" no longer exists in configuration`。
 */
export { userAgentId };

/**
 * 派生隔离会话 key：`agent:u-<userId>:<会话>`。
 *
 * 不传 userId 时退到 `agent:main:main`（仅后台/无归属任务才会走到），
 * 那是所有用户共用的会话 —— 两个用户的消息会混进同一份上下文与记忆，
 * 因此凡是面向具体用户的调用都必须传 userId。
 *
 * 为什么带 conversationId：平台一个用户可以有多个会话，若会话 key 只到用户粒度，
 * 龙虾会把该用户所有会话的历史累积在一起，平台只能每轮重放当前会话历史去划边界，
 * 等于同一份历史发两遍、prompt 每轮膨胀。带上会话 id 后，历史按会话各自独立。
 */
function deriveUserSessionKey(userId?: string | null, conversationId?: string | null): string {
  const uid = userId && typeof userId === "string" ? userId.trim() : "";
  if (uid) {
    const agentId = userAgentId(uid);
    const cid = conversationId && typeof conversationId === "string" ? conversationId.trim() : "";
    if (cid) {
      const safeConv = cid.replace(/[^a-zA-Z0-9_-]/g, "-");
      return `agent:${agentId}:c${safeConv}`;
    }
    return `agent:${agentId}:main`;
  }
  return process.env.OPENCLAW_SESSION_KEY || "agent:main:main";
}

/**
 * 带重试的网关请求。
 *
 * 覆盖 4-5 分钟的慢启动窗口：端口已监听但 sidecar 未就绪时，
 * chat.startup 会以「调用超时」形式失败，必须重试到网关真正 ready。
 * 退避序列刻意拉长（15/30/45/60/60 秒）—— 网关重启期间端口会反复
 * ECONNREFUSED，短间隔重试只会浪费时间。
 */
async function gatewayRequestWithRetry<T>(
  conn: { request: <R>(method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<R> },
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<T> {
  const delays = [0, 15000, 30000, 45000, 60000, 60000];
  let lastErr: unknown;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      return await conn.request<T>(method, params, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (!isGatewayTransientError(e)) throw e;
    }
  }
  throw new Error(friendlyGatewayError(lastErr, { wasRetried: true }));
}

/**
 * 通过网关跑一轮 agent 对话。
 *
 * 连接策略：`connectGateway()` 失败且属瞬时错误（网关启动中/未运行）时，
 * 按 300 秒预算每 10 秒重试一次。实测网关重启要 4-5 分钟才 ready
 * （端口在 database-readiness 后还要等微信 sidecar 同步），固定试几次必然失败。
 */
async function requestGatewayChat(
  message: string,
  timeoutMs?: number,
  onDelta?: (deltaText: string) => void,
  sessionKeyOverride?: string
): Promise<{ runId: string; content: string; raw: unknown }> {
  const effectiveTimeout =
    timeoutMs ?? Number(process.env.OPENCLAW_CHAT_TIMEOUT_MS ?? 120000);

  let conn: Awaited<ReturnType<typeof connectGateway>> | null = null;
  const connectBudgetMs = Number(process.env.OPENCLAW_CONNECT_BUDGET_MS ?? 300000);
  const retryIntervalMs = 10000;
  const connectStart = Date.now();
  let connectErr: unknown;
  for (;;) {
    try {
      conn = await connectGateway();
      break;
    } catch (e) {
      connectErr = e;
      if (!isGatewayTransientError(e)) break;
      if (Date.now() - connectStart + retryIntervalMs >= connectBudgetMs) break;
      await new Promise((r) => setTimeout(r, retryIntervalMs));
    }
  }
  if (!conn) throw new Error(friendlyGatewayError(connectErr, { wasRetried: true }));

  try {
    const sessionKey = sessionKeyOverride ?? deriveUserSessionKey();

    // Initialise the chat session.
    await gatewayRequestWithRetry(conn, "chat.startup", { sessionKey }, 15000);

    // Send the user message — the response returns immediately with a runId.
    const sendResult = await gatewayRequestWithRetry<{ runId: string; status: string }>(
      conn,
      "chat.send",
      {
        sessionKey,
        message,
        deliver: false,
        idempotencyKey: `cx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
      30000
    );

    const runId = sendResult.runId;
    if (!runId) {
      throw new Error("OpenClaw chat.send 未返回 runId。");
    }

    // Wait for the assistant's final reply via the event stream.
    // Track accumulated deltas so timeouts / empty finals can still
    // return the partial streamed content instead of losing it.
    let deltaAccum = "";
    const content = await new Promise<string>((resolve, reject) => {
      const fail = (message: string, code?: string) => {
        const err = new Error(message) as Error & { partialContent?: string; code?: string };
        if (deltaAccum.trim()) err.partialContent = deltaAccum;
        if (code) err.code = code;
        reject(err);
      };
      const timer = setTimeout(() => {
        // 注意：本地等待超时**不会**中断网关侧的 run，任务仍在后台继续执行。
        // 最常见的成因是上一条消息的任务还没跑完（长任务 / 工具调用链），
        // 本条消息在网关侧排队，导致迟迟拿不到第一个 delta。
        fail(
          `等待 AI 回复超时（已等待 ${Math.round(effectiveTimeout / 1000)} 秒）。` +
            "任务可能仍在后台继续执行 —— 若上一条任务尚未结束，本条消息会排队等待，" +
            "可稍后在微信通道或本会话中查看结果。",
          "TIMEOUT"
        );
      }, effectiveTimeout);

      conn.onEvent((event, payload) => {
        if (event !== "chat") return;
        const p = payload as {
          state?: string;
          runId?: string;
          deltaText?: string;
          errorMessage?: string;
          errorKind?: string;
          message?: { content?: ChatContentItem[] };
        };
        if (p.state === "delta" && p.runId === runId && p.deltaText) {
          deltaAccum += p.deltaText;
          if (onDelta) onDelta(p.deltaText);
          return;
        }
        // 网关侧的 run 失败（模型凭据失效、上游 5xx、工具链断裂等）。
        // 必须立刻 reject —— 此前忽略这个状态，只能干等 120 秒本地超时，
        // 用户看到的是「发消息没反应」，而网关其实 2 秒前就报过错。
        // 协议见 openclaw dist/chat-send-handler：state:"error" 带
        // errorMessage + errorKind（completion.kind === "failed" 时广播）。
        if (p.state === "error" && p.runId === runId) {
          clearTimeout(timer);
          fail(p.errorMessage?.trim() || "OpenClaw 执行失败（未给出原因）。", "GATEWAY_ERROR");
          return;
        }
        // 用户/系统主动中止（如 /stop）。已有部分输出就交付，不当作错误。
        if (p.state === "aborted" && p.runId === runId) {
          clearTimeout(timer);
          resolve(deltaAccum);
          return;
        }
        if (p.state === "final" && p.runId === runId) {
          clearTimeout(timer);
          const text = (p.message?.content || [])
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("");
          // Final event arrived but carried no text (agent aborted the run,
          // tool-only turn, etc.) — fall back to what was streamed.
          resolve(text.trim() ? text : deltaAccum);
        }
      });
    });

    return { runId, content, raw: sendResult };
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// Gateway 故障诊断层
//
// 存在的理由：此前 `ws.on("error")` 只取 error.message，而 Node 的 ws 在部分
// 错误形态下不填 message（只保留 error.code），于是界面得到的是
// 「OpenClaw Gateway 连接失败：」这样的空串。更严重的是 isGatewayTransientError
// 只对 message 文本做正则匹配，空 message 被判为「非瞬时错误」，
// 直接跳过了 150 秒的重试等待 —— 网关只是启动慢，也会被立刻判死。
//
// 这里把故障归类成结构化结论，供三处复用：错误文案、重试判定、健康检查。
// 分类优先级刻意定为 code → message 关键词 → 自定义标记，因为空 message 场景下
// error.code 是唯一可靠的信息源。
// ---------------------------------------------------------------------------

export type GatewayFailureKind =
  /** 端口没人监听：网关没启动，或已退出。 */
  | "not_running"
  /** 端口被别的进程占用。 */
  | "port_conflict"
  /** 设备凭据文件缺失或读不出来。 */
  | "credentials_missing"
  /** 连上了但网关没下发 connect.challenge 质询。 */
  | "challenge_timeout"
  /** 网关明确拒绝：签名不匹配、token 失效、权限不足。 */
  | "auth_failed"
  /**
   * 网关连上了、也鉴权了，但它调模型时凭据失效（HTTP 401 / Couldn't sign in）。
   * 与 auth_failed 的区别：那是**连不上网关**，这是**网关自己调不动 AI**。
   * 修复动作也完全不同（前者查设备凭据，后者重新登录模型）。
   */
  | "model_auth_failed"
  /** 调用超时。 */
  | "timeout"
  | "unknown";

export type GatewayDiagnosis = {
  kind: GatewayFailureKind;
  /** 面向用户的中文提示，可直接展示。 */
  userMessage: string;
  /** 技术细节，进日志不面向用户。 */
  detail: string;
  /** 是否值得自动等待重试。 */
  transient: boolean;
  /** 修复指引；仅 transient=false 时给出。 */
  hint?: string;
};

/** 网关地址，用于错误提示里告诉用户该检查哪个端口。 */
function gatewayEndpointLabel(): string {
  try {
    return requireBaseUrl();
  } catch {
    return "(未配置 OPENCLAW_BASE_URL)";
  }
}

/** 取出 error.code —— ws 的错误码只挂在 code 上，message 可能是空的。 */
function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code.toUpperCase() : "";
}

/** 我们自己抛出的错误用这个前缀标记，便于分类时与网关返回的原文区分开。 */
const DIAG_MARKER = "[gateway-diagnosis]";

/** 抛出一个带诊断标记的错误，后续 classify 能无歧义地还原它的分类。 */
export function gatewayError(diagnosis: GatewayDiagnosis): Error {
  const error = new Error(`${DIAG_MARKER} ${diagnosis.userMessage}（${diagnosis.detail}）`);
  (error as Error & { gatewayDiagnosis?: GatewayDiagnosis }).gatewayDiagnosis = diagnosis;
  return error;
}

/** 判断错误是否由本模块的诊断层抛出，并取回其结论。 */
function readMarkedDiagnosis(err: unknown): GatewayDiagnosis | null {
  const carried = (err as { gatewayDiagnosis?: unknown } | null)?.gatewayDiagnosis;
  if (carried && typeof carried === "object" && "kind" in carried) {
    return carried as GatewayDiagnosis;
  }

  // 退化路径：marker 属性丢失（跨进程、序列化、被第三方包装）时，从 message 反解分类。
  // 这里不能只靠正则 —— message 结尾是全角括号「）」，且 detail 里可能含有半角括号，
  // 早期写成 /\(([a-z_]+)\)$/ 永远匹配不上，导致 kind 恒退化成 unknown、
  // transient 恒为 false，等于把诊断层整个作废。改为从诊断字段表反查。
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes(DIAG_MARKER)) return null;

  for (const kind of GATEWAY_FAILURE_KINDS) {
    if (msg.includes(`（${kind}）`) || msg.includes(`(${kind})`)) {
      return { kind, userMessage: msg, detail: msg, transient: TRANSIENT_KINDS.has(kind) };
    }
  }
  return null;
}

/** 全部分类，供 readMarkedDiagnosis 反查。 */
const GATEWAY_FAILURE_KINDS: GatewayFailureKind[] = [
  "not_running",
  "port_conflict",
  "credentials_missing",
  "challenge_timeout",
  "auth_failed",
  "timeout",
  "unknown",
];

/** 判定为「值得自动重试」的分类，与 classifyGatewayError 各分支保持一致。 */
const TRANSIENT_KINDS = new Set<GatewayFailureKind>([
  "not_running",
  "challenge_timeout",
  "timeout",
]);

/**
 * 把任意网关异常归类成结构化诊断。
 *
 * 空 message 场景下以 error.code 为唯一信息源，因此判定顺序是：
 * 已标记诊断 → error.code → message 关键词。
 */
export function classifyGatewayError(err: unknown): GatewayDiagnosis {
  const marked = readMarkedDiagnosis(err);
  if (marked) return marked;

  const code = errorCodeOf(err);
  const msg = err instanceof Error ? err.message : String(err);
  const endpoint = gatewayEndpointLabel();
  const detail = code ? `[${code}] ${msg || "(无错误描述)"}` : msg || "(无错误描述)";

  // 0) 网关侧业务错误（run 失败）：网关 2 秒内就通过 state:"error" 回报了，
  //    与「连不上网关」是两回事，必须放在最前面优先判定。
  //    最常见的成因是模型凭据失效（Couldn't sign in to the AI service）。
  if (code === "GATEWAY_ERROR") {
    if (/sign in|unauthor|401|auth|credential|api key/i.test(msg)) {
      return {
        kind: "model_auth_failed",
        userMessage: "OpenClaw 的模型凭据已失效，无法调用 AI 服务。",
        detail,
        transient: false,
        hint:
          "打开 OpenClaw 控制台（http://127.0.0.1:18789）→ Models 重新登录；" +
          "或在平台「系统配置 → 默认模型分配」里重新保存主对话模型，保存时会自动同步到 OpenClaw。",
      };
    }
    return {
      kind: "unknown",
      userMessage: msg || "OpenClaw 执行失败（未给出原因）。",
      detail,
      transient: false,
    };
  }

  // 1) 端口层面
  if (code === "ECONNREFUSED" || /ECONNREFUSED|socket hang up|ECONNRESET|ECONNABORTED/i.test(msg)) {
    return {
      kind: "not_running",
      userMessage: "AI 网关未在运行或已退出，连接被拒绝。",
      detail: `${detail}（目标 ${endpoint}）`,
      transient: true,
    };
  }
  if (code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(msg)) {
    return {
      kind: "port_conflict",
      userMessage: `网关端口被其他进程占用（${endpoint}）。`,
      detail,
      transient: false,
      hint: "用 netstat -ano | findstr 18789 查出占用 PID，结束该进程后再启动网关。",
    };
  }
  if (code === "ENOTFOUND" || code === "EHOSTUNREACH" || /ENOTFOUND|EHOSTUNREACH|getaddrinfo/i.test(msg)) {
    return {
      kind: "not_running",
      userMessage: `无法解析网关地址（${endpoint}）。`,
      detail,
      transient: false,
      hint: "检查 .env.local 里的 OPENCLAW_BASE_URL 是否指向正确的主机与端口。",
    };
  }

  // 2) 凭据层面
  if (/设备凭据|device\.json|device-auth\.json|openclaw\.sqlite|ENOENT|未找到 operator token/i.test(msg)) {
    return {
      kind: "credentials_missing",
      userMessage: "未找到 OpenClaw 的设备凭据，无法完成网关鉴权。",
      detail,
      transient: false,
      hint:
        "确认 ~/.openclaw/state/openclaw.sqlite（或旧版 identity/device.json + device-auth.json）存在；" +
        "若换了机器，需在本机重新执行一次 openclaw 的设备注册。",
    };
  }

  // 3) 握手 / 鉴权层面
  if (/未发送 connect\.challenge|connect\.challenge/i.test(msg)) {
    return {
      kind: "challenge_timeout",
      userMessage: "已连上端口，但网关没有下发握手质询，可能不是 OpenClaw 网关或版本不兼容。",
      detail,
      transient: true,
    };
  }
  // 鉴权失败。关键词刻意收紧：早期用了 /auth|token|device|scope|reject/ 这种宽集合，
  // 会把 "request rejected: timeout"、"ENODEV: no such device"、"out of scope"
  // 误判成鉴权失败并让用户去「重新注册设备」，同时因为排在 timeout 之前，
  // 带 timeout 语义的错误永远走不到 timeout 分支。这里只保留明确指向
  // 设备签名与 operator token 的词。
  if (
    /unauthorized|forbidden|invalid signature|signature mismatch|invalid token|operator token|device auth|device signature|not paired|pairing rejected/i.test(
      msg
    )
  ) {
    return {
      kind: "auth_failed",
      userMessage: "网关拒绝了设备鉴权。",
      detail,
      transient: false,
      hint: "设备私钥与 operator token 可能已失效或与网关不匹配，建议在本机重新注册设备。",
    };
  }

  // 4) 超时（放在鉴权之后、通用匹配之前，避免被更宽的分支吞掉）
  if (/timeout|timed out|超时|ETIMEDOUT/i.test(msg)) {
    return {
      kind: "timeout",
      userMessage: "调用网关超时。",
      detail,
      transient: true,
    };
  }

  // 5) 网关启动中
  if (/gateway starting|startup-sidecars/i.test(msg)) {
    return {
      kind: "not_running",
      userMessage: "AI 网关正在启动中（通常需要 1-3 分钟）。",
      detail,
      transient: true,
    };
  }

  return {
    kind: "unknown",
    userMessage: msg || "连接网关时发生未知错误。",
    detail,
    transient: false,
  };
}

/**
 * 只读检查设备凭据是否就绪。
 *
 * 刻意不写入 cachedDeviceCreds：健康检查会高频调用，若顺手填充缓存，
 * 网关侧凭据更新后进程内仍会拿旧值，排查时极具误导性。
 */
export function describeGatewayCredentials(): {
  sqliteFound: boolean;
  identityFound: boolean;
  operatorTokenPresent: boolean;
  paths: string[];
} {
  const home = homedir();
  const sqlitePath = path.join(home, ".openclaw", "state", "openclaw.sqlite");
  const devicePath = path.join(home, ".openclaw", "identity", "device.json");
  const authPath = path.join(home, ".openclaw", "identity", "device-auth.json");

  const sqliteFound = existsSync(sqlitePath);
  const deviceFound = existsSync(devicePath);
  const authFound = existsSync(authPath);

  let operatorTokenPresent = false;
  if (authFound) {
    try {
      const parsed = JSON.parse(readFileSync(authPath, "utf8")) as {
        tokens?: { operator?: { token?: string } };
      };
      operatorTokenPresent = Boolean(parsed.tokens?.operator?.token);
    } catch {
      // 读不出内容视为没有 token，由调用方给出「凭据缺失」结论
    }
  }

  return {
    sqliteFound,
    identityFound: deviceFound && authFound,
    operatorTokenPresent,
    paths: [sqlitePath, devicePath, authPath],
  };
}

/**
 * 试一次真实的网关握手，成功即返回 null，失败返回结构化诊断。
 *
 * 与业务调用分开：这里不做任何 method 请求，握手成功后立刻关闭，
 * 因此可以安全地被健康检查高频调用。超时时间远小于业务调用（默认 2s），
 * 避免体检接口拖慢页面。
 */
export async function probeGatewayHandshake(timeoutMs = 2000): Promise<GatewayDiagnosis | null> {
  let conn: GatewayConnection | null = null;
  try {
    conn = await connectGateway(timeoutMs);
    return null;
  } catch (err) {
    return classifyGatewayError(err);
  } finally {
    try {
      conn?.close();
    } catch {
      // 已关闭的连接忽略
    }
  }
}

/** 网关「启动中 / 未运行」类瞬时错误：可自动等待重试。 */
function isGatewayTransientError(err: unknown): boolean {
  return classifyGatewayError(err).transient;
}

/**
 * 把网关的技术性英文错误转成用户能看懂的中文提示。
 *
 * 现在统一走 classifyGatewayError：判定依据是 error.code 而非 message 文本，
 * 因此「空 message」场景下也能给出正确结论（此前会原样返回空串或技术细节）。
 *
 * @param opts.wasRetried 已按预算自动重试过 —— 此时话术应改成「等过了仍不行」，
 *                        而非「去启动网关」，否则会误导用户重复操作。
 */
export function friendlyGatewayError(
  err: unknown,
  opts: { wasRetried?: boolean } = {}
): string {
  const diagnosis = classifyGatewayError(err);
  const wasRetried = opts.wasRetried ?? false;

  switch (diagnosis.kind) {
    case "not_running":
      return wasRetried
        ? "AI 网关正在重启或暂时不可用（重启通常需要 1-3 分钟）。系统已自动等待重试仍未就绪，请 1 分钟后再发送一次。"
        : "AI 网关未在运行，请确认 OpenClaw 网关已启动。";

    case "port_conflict":
      return `AI 网关端口被其他进程占用。${diagnosis.hint ?? ""}`.trim();

    case "credentials_missing":
      return `缺少 OpenClaw 设备凭据，无法连接网关。${diagnosis.hint ?? ""}`.trim();

    case "challenge_timeout":
      return wasRetried
        ? "AI 网关已就绪但未完成握手，可能是版本不兼容，请检查网关版本。"
        : "AI 网关尚未完成握手，请稍后重试。";

    case "auth_failed":
      return `AI 网关拒绝了设备鉴权。${diagnosis.hint ?? ""}`.trim();

    case "model_auth_failed":
      return `${diagnosis.userMessage}${diagnosis.hint ? ` ${diagnosis.hint}` : ""}`.trim();

    case "timeout":
      return "调用 AI 网关超时，请稍后重试。";

    default: {
      // 未知分类兜底：仍要挡掉裸 JSON / 空串
      const raw = err instanceof Error ? err.message : String(err);
      if (!raw.trim()) return "连接 AI 网关失败（网关未返回有效错误信息）。";
      if (/^[[{]/.test(raw.trim())) {
        return "AI 网关返回了无法解析的错误，请查看服务端日志。";
      }
      return raw;
    }
  }
}

/** 网关定时任务的最小信息（用于按用户过滤后注入会话提示词，避免 AI 看全局列表）。 */
export type CronJobSummary = {
  id: string;
  name: string;
  enabled: boolean;
  /** 人类可读的调度描述，如 "0 30 17 * * *"（cron 表达式）。 */
  schedule: string;
  /** 归属会话 key；用户任务应为 agent:u-<id>:<会话>。 */
  sessionKey: string;
};

export const openClawClient = {
  async createWechatBindingQr(): Promise<OpenClawQr> {
    let weixin: WeixinLoginModule;
    try {
      weixin = await withTimeout(
        loadWeixinLoginModule(),
        WEIXIN_PLUGIN_LOAD_TIMEOUT_MS,
        `加载微信插件超时（${Math.round(WEIXIN_PLUGIN_LOAD_TIMEOUT_MS / 1000)} 秒），请重试。`
      );
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "加载微信插件失败。"
      );
    }

    const result = await withTimeout(
      weixin.startWeixinLoginWithQr({
        force: true,
        apiBaseUrl: weixinApiBaseUrl(),
        verbose: false
      }),
      WEIXIN_QR_TIMEOUT_MS,
      `向微信服务器申请二维码超时（${Math.round(WEIXIN_QR_TIMEOUT_MS / 1000)} 秒），请重试。`
    );

    if (!result.qrcodeUrl) {
      throw new Error(weixinLoginErrorMessage(result.message));
    }
    return {
      ticketId: result.sessionKey,
      qrCodeUrl: await renderQrImageDataUrl(result.qrcodeUrl),
      qrCodeText: result.qrcodeUrl
    };
  },

  async getWechatBindingStatus(ticketId: string): Promise<OpenClawBindingStatus> {
    const weixin = await loadWeixinLoginModule();
    const result = await withTimeout(
      weixin.waitForWeixinLogin({
        sessionKey: ticketId,
        apiBaseUrl: weixinApiBaseUrl(),
        timeoutMs: 480000,
        verbose: false
      }),
      500000,
      "等待微信扫码确认超时，请重新生成二维码。"
    );

    // 扫码成功后把凭据落盘并启用通道；漏掉这一步网关不会启动微信通道，
    // 微信端会一直显示「暂无法连接 OpenClaw」。
    const credentialsIssued = Boolean(result.botToken && result.accountId);
    if (result.connected && credentialsIssued) {
      await persistWeixinBinding(result);
    }

    const connected = result.connected || result.alreadyConnected === true;
    return {
      status: connected ? "bound" : "pending",
      ticketId,
      wechatNickname: connected ? "OpenClaw 微信通道" : undefined,
      wechatOpenId: result.accountId ?? result.userId,
      wechatNo: result.userId ?? result.accountId,
      credentialsIssued
    };
  },

  /**
   * 网关确认已连接、但没签发新凭据时（binded_redirect），用本机已保存的
   * 凭据把通道重新拉起来。找不到可用凭据返回 null，由调用方如实报错。
   */
  async restoreWeixinChannelFromStoredAccount(identity: {
    wechatOpenId?: string;
    wechatNo?: string;
  }): Promise<{ accountId: string } | null> {
    return restoreWeixinChannelFromStoredAccount(identity);
  },

  /**
   * 解除微信绑定：停掉网关上的该账号通道，并清理本地凭据与账号索引。
   *
   * 注意两点：
   * 1. 微信插件没有实现 `channels.logout`（它的 auth 里只有 login），所以不能走
   *    logout，必须用 `channels.stop` 停通道 + 删本地凭据。
   * 2. 服务端不提供解绑接口，所以「微信服务端仍记着这次绑定」属于预期行为 ——
   *    表现是同一个微信号再次扫码只会返回 binded_redirect（不签发新凭据），
   *    需要先在该微信侧的 ClawBot 设置里解除绑定再扫。
   */
  async unbindWechat(accountRef: string): Promise<void> {
    const accounts = await loadWeixinAccountsModule();
    const accountId = resolveBoundWeixinAccountId(accountRef, accounts);

    // 1) 停掉该账号的微信通道（本来就没在跑时忽略失败，不阻塞解绑）
    try {
      await requestGateway("channels.stop", {
        channel: "openclaw-weixin",
        accountId
      });
    } catch (error) {
      console.warn(
        `[openclaw] 停止微信通道失败（继续解绑）：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // 2) 删除本地凭据与账号索引，否则网关下次重载配置会把通道重新拉起来
    accounts.clearWeixinAccount(accountId);
    accounts.unregisterWeixinAccountId(accountId);

    // 3) 更新配置时间戳，让网关重新加载通道配置
    await bumpWeixinChannelConfig();
  },

  /**
   * 清理「没有任何活跃绑定引用」的微信通道（解绑后残留的孤儿通道）。
   *
   * 为什么需要：历史绑定记录的 wechatOpenId 可能为空，解绑时定位不到具体通道就跳过了清理；
   * 残留通道会持续对微信服务器做长轮询（其中 token 过期的还会反复重试），把网关的
   * Node 事件循环拖死 → 心跳超时 → 健康检查失败 → 网关反复重启（2026-10-13 实测故障）。
   *
   * 判据：OpenClaw 侧已注册、但不在任何「BOUND 绑定」引用集合里的通道。
   * 返回被清理掉的 accountId 列表。
   */
  async pruneOrphanWechatAccounts(): Promise<string[]> {
    const accounts = await loadWeixinAccountsModule();
    const indexed = accounts.listIndexedWeixinAccountIds();
    if (!indexed.length) return [];

    const { prisma } = await import("./prisma");
    const bindings = await prisma.wechatBinding.findMany({
      where: { status: "BOUND" },
      select: { wechatOpenId: true, wechatNo: true }
    });
    const active = new Set<string>();
    for (const b of bindings) {
      for (const ref of [b.wechatOpenId, b.wechatNo]) {
        const value = (ref || "").trim();
        if (value) active.add(resolveBoundWeixinAccountId(value, accounts));
      }
    }

    const orphans = indexed.filter((id) => !active.has(id));
    for (const id of orphans) {
      // 先停通道（本来就没在跑时忽略失败），再清本地凭据与索引
      try {
        await requestGateway("channels.stop", { channel: "openclaw-weixin", accountId: id });
      } catch (error) {
        console.warn(
          `[openclaw] 停止孤儿微信通道失败（继续清理）：${id} ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      accounts.clearWeixinAccount(id);
      accounts.unregisterWeixinAccountId(id);
    }
    // 有清理动作才需要让网关重载配置
    if (orphans.length) await bumpWeixinChannelConfig();
    return orphans;
  },


  /**
   * 网关的全部定时任务（**不做用户过滤**）。
   * 本平台多用户共用同一网关 cron 存储，调用方必须按 sessionKey
   * （agent:u-<id>:*）或名字前缀自行过滤后再使用，否则会把别人的任务泄给当前用户。
   */
  /**
   * 跑一轮 agent 对话（非流式）。
   *
   * 空返回自动重试一次：agent 冷启动或偶发空返回时，避免整轮对话白跑。
   */
  async sendTask(input: string | OpenClawTaskRequest): Promise<OpenClawTaskResult> {
    const request: OpenClawTaskRequest = typeof input === "string" ? { message: input } : input;
    const message = request.prompt ?? request.message;

    // 兜底装配：注册接口会装配，但历史用户/装配失败/手工建库的用户也要能聊。
    // ensureUserAgent 幂等且带进程内缓存，已装配过的只做一次 Set 判断。
    if (request.userId) {
      await ensureUserAgent({ userId: request.userId });
    }

    // 显式指定的 sessionKey 优先（后台任务用独立会话，避免与实时对话抢同一会话）；
    // 否则按 userId 派生隔离 sessionKey，避免多用户共用同一 agent 会话上下文/记忆。
    // 带 conversationId 时会话 key 下沉到「用户+会话」粒度，历史由龙虾按会话自管。
    const sessionKey = request.sessionKey || deriveUserSessionKey(request.userId, request.conversationId);
    const retryOnEmpty = request.retryOnEmpty !== false;
    let result = await requestGatewayChat(message, request.timeoutMs, undefined, sessionKey);
    if (!result.content?.trim() && retryOnEmpty) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      result = await requestGatewayChat(message, request.timeoutMs, undefined, sessionKey);
    }

    // retryOnEmpty=false（有副作用的定时任务）：空文本不算失败，原样返回空 content，
    // 由调用方决定语义；此时绝不能重跑任务。
    if (!result.content?.trim() && retryOnEmpty) {
      throw new Error("OpenClaw 未返回任务内容（已自动重试一次），请稍后重试。");
    }

    return {
      taskId: result.runId,
      content: result.content,
      raw: result.raw
    };
  },

  /** 流式版本：每个 delta 回调给前端做打字效果。 */
  async sendTaskStream(
    input: string | OpenClawTaskRequest,
    onDelta: (deltaText: string) => void,
    timeoutMs?: number
  ): Promise<OpenClawTaskResult> {
    const request: OpenClawTaskRequest = typeof input === "string" ? { message: input } : input;
    const message = request.prompt ?? request.message;

    // 兜底装配（同 sendTask）：保证会话 key 指向的 agent 一定存在。
    if (request.userId) {
      await ensureUserAgent({ userId: request.userId });
    }

    const sessionKey = request.sessionKey || deriveUserSessionKey(request.userId, request.conversationId);
    let result = await requestGatewayChat(message, timeoutMs, onDelta, sessionKey);
    if (!result.content?.trim()) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      result = await requestGatewayChat(message, timeoutMs, onDelta, sessionKey);
    }

    if (!result.content?.trim()) {
      throw new Error("OpenClaw 未返回任务内容（已自动重试一次），请稍后重试。");
    }

    return {
      taskId: result.runId,
      content: result.content,
      raw: result.raw
    };
  },

  async listCronJobs(): Promise<CronJobSummary[]> {
    const result = await requestGateway<{
      jobs?: Array<{
        id?: string;
        name?: string;
        displayName?: string;
        enabled?: boolean;
        sessionKey?: string;
        schedule?: { kind?: string; expr?: string; tz?: string; everyMs?: number };
      }>;
    }>("cron.list", { includeDisabled: true, limit: 200 }, 20000);
    return (result.jobs ?? [])
      .filter((j) => Boolean(j?.id))
      .map((j) => {
        const s = j.schedule ?? {};
        let schedule = j.schedule?.expr ?? "";
        if (!schedule && typeof s.everyMs === "number") {
          schedule = `每 ${Math.max(1, Math.round(s.everyMs / 60000))} 分钟`;
        }
        if (schedule && s.tz) schedule = `${schedule} (${s.tz})`;
        return {
          id: String(j.id),
          name: j.name || j.displayName || String(j.id),
          enabled: j.enabled !== false,
          schedule: schedule || s.kind || "unknown",
          sessionKey: j.sessionKey ?? ""
        };
      });
  }
};
