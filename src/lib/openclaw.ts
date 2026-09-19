import { createRequire } from "module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { sign, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import QRCode from "qrcode";

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
};

export type OpenClawTaskRequest = {
  message: string;
  context?: string;
  prompt?: string;
  conversationId?: string;
  userId?: string;
};

export type OpenClawTaskResult = {
  taskId?: string;
  content: string;
  title?: string;
  coverImageUrl?: string;
  inlineImages?: string[];
  raw: unknown;
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

const DEFAULT_WEIXIN_LOGIN_MODULE =
  "C:\\Users\\zengr\\.openclaw\\npm\\projects\\tencent-weixin-openclaw-weixin-7783ac86ba\\node_modules\\@tencent-weixin\\openclaw-weixin\\dist\\src\\auth\\login-qr.js";

function weixinLoginModulePath(): string {
  return process.env.OPENCLAW_WEIXIN_LOGIN_MODULE || DEFAULT_WEIXIN_LOGIN_MODULE;
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

function weixinApiBaseUrl(): string {
  return process.env.OPENCLAW_WEIXIN_API_BASE_URL || "https://ilinkai.weixin.qq.com";
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

function loadDeviceCredentials(): DeviceCredentials {
  if (cachedDeviceCreds) return cachedDeviceCreds;
  const home = homedir();
  const dev = JSON.parse(
    readFileSync(`${home}/.openclaw/identity/device.json`, "utf8")
  ) as {
    deviceId: string;
    publicKeyPem: string;
    privateKeyPem: string;
  };
  const devAuth = JSON.parse(
    readFileSync(`${home}/.openclaw/identity/device-auth.json`, "utf8")
  ) as {
    tokens: { operator: { token: string } };
  };
  const opToken = devAuth.tokens?.operator?.token;
  if (!opToken) {
    throw new Error("OpenClaw 设备认证文件中未找到 operator token。");
  }

  const pubObj = createPublicKey({
    key: dev.publicKeyPem,
    format: "pem",
    type: "spki",
  });
  const pubDer = pubObj.export({ type: "spki", format: "der" });
  const pubB64Url = pubDer.subarray(pubDer.length - 32).toString("base64url");

  cachedDeviceCreds = {
    deviceId: dev.deviceId,
    privateKeyPem: dev.privateKeyPem,
    publicKeyB64Url: pubB64Url,
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
      for (const [, request] of pending) {
        request.reject(
          new Error(`OpenClaw Gateway 连接失败：${error.message}`)
        );
      }
      pending.clear();
      if (!settled) {
        cleanup();
        reject(new Error(`OpenClaw Gateway 连接失败：${error.message}`));
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
// Chat via gateway
//
// Flow:
//   1. Connect with device auth
//   2. chat.startup({ sessionKey }) — initialise the chat session
//   3. chat.send({ sessionKey, message, deliver: false, idempotencyKey })
//      → returns { runId, status: "started" }
//   4. Listen for `chat` events until payload.state === "final" and
//      payload.runId === runId, then extract text from
//      payload.message.content[].text
// ---------------------------------------------------------------------------

type ChatContentItem = { type: string; text: string };

async function requestGatewayChat(
  message: string,
  timeoutMs?: number,
  onDelta?: (deltaText: string) => void
): Promise<{ runId: string; content: string; raw: unknown }> {
  const effectiveTimeout =
    timeoutMs ?? Number(process.env.OPENCLAW_CHAT_TIMEOUT_MS ?? 120000);
  const conn = await connectGateway();
  try {
    const sessionKey = process.env.OPENCLAW_SESSION_KEY || "agent:main:main";

    // Initialise the chat session.
    await conn.request("chat.startup", { sessionKey }, 15000);

    // Send the user message — the response returns immediately with a runId.
    const sendResult = await conn.request<{ runId: string; status: string }>(
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
          message?: { content?: ChatContentItem[] };
        };
        if (p.state === "delta" && p.runId === runId && p.deltaText) {
          deltaAccum += p.deltaText;
          if (onDelta) onDelta(p.deltaText);
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

function pickString(
  payload: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

/**
 * 把 API Key 交给官方 CLI 落盘。
 * OpenClaw 的模型凭证存放在 agent 的 sqlite（不是 JSON 文件），所以必须走
 * `openclaw models auth paste-api-key`，通过 stdin 把 key 传进去。
 */
function saveModelApiKey(providerId: string, apiKey: string): Promise<void> {
  const entry =
    process.env.OPENCLAW_CLI_ENTRY ||
    "C:\\Users\\zengr\\AppData\\Local\\hermes\\node\\node_modules\\openclaw\\openclaw.mjs";

  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        entry,
        "models",
        "auth",
        "paste-api-key",
        "--provider",
        providerId,
        "--profile-id",
        `${providerId}:manual`
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`保存 API Key 失败（退出码 ${code}）：${stderr.slice(-300)}`));
    });
    child.stdin?.write(`${apiKey}\n`);
    child.stdin?.end();
  });
}

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
    if (result.connected && result.botToken && result.accountId) {
      await persistWeixinBinding(result);
    }

    const connected = result.connected || result.alreadyConnected === true;
    return {
      status: connected ? "bound" : "pending",
      ticketId,
      wechatNickname: connected ? "OpenClaw 微信通道" : undefined,
      wechatOpenId: result.accountId ?? result.userId,
      wechatNo: result.userId ?? result.accountId
    };
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

  // -------------------------------------------------------------------------
  // 模型管理：查询当前模型 / 可用模型 / 切换 / 添加自定义 provider
  // -------------------------------------------------------------------------

  /** 当前 main 会话实际使用的模型（即「龙虾正在调用的模型」）。 */
  async getCurrentModel(): Promise<{ provider: string; model: string } | null> {
    const sessionKey = process.env.OPENCLAW_SESSION_KEY || "agent:main:main";
    const result = await requestGateway<{
      sessions?: Array<{ key?: string; model?: string; modelProvider?: string }>;
    }>("sessions.list", {}, 20000);
    const sessions = result.sessions ?? [];
    const session = sessions.find((s) => s.key === sessionKey) ?? sessions[0];
    if (!session?.model) return null;
    return { provider: session.modelProvider ?? "", model: session.model };
  },

  /** 网关已配置的模型列表。 */
  async listModels(): Promise<Array<{ id: string; name: string; provider: string; available: boolean }>> {
    const result = await requestGateway<{
      models?: Array<{ id?: string; name?: string; provider?: string; available?: boolean }>;
    }>("models.list", {}, 20000);
    return (result.models ?? [])
      .filter((m) => Boolean(m?.id))
      .map((m) => ({
        id: String(m.id),
        name: m.name || String(m.id),
        provider: m.provider ?? "",
        available: m.available !== false
      }));
  },

  /** 切换 main 会话使用的模型。 */
  async switchModel(model: string): Promise<void> {
    const sessionKey = process.env.OPENCLAW_SESSION_KEY || "agent:main:main";
    await requestGateway("sessions.patch", { key: sessionKey, model }, 25000);
  },

  /**
   * 添加/更新一个 OpenAI 兼容的模型 provider，并保存 API Key。
   * - provider 定义写进 ~/.openclaw/openclaw.json 的 models.providers；
   * - API Key 交给官方 CLI 落盘（凭证存在 agent 的 sqlite 里，不能手工拼 JSON 文件）。
   */
  async upsertModelProvider(input: {
    providerId: string;
    baseUrl: string;
    modelId: string;
    modelName?: string;
    apiKey?: string;
    contextWindow?: number;
    maxTokens?: number;
  }): Promise<void> {
    const providerId = input.providerId.trim();
    const modelId = input.modelId.trim();
    const baseUrl = input.baseUrl.trim();
    if (!providerId || !modelId || !baseUrl) {
      throw new Error("provider、模型 id 与 baseUrl 均不能为空。");
    }

    const configPath = openClawConfigPath();
    const cfg = JSON.parse(
      readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")
    ) as Record<string, unknown>;
    const models = (cfg.models ?? {}) as Record<string, unknown>;
    const providers = (models.providers ?? {}) as Record<string, unknown>;
    const existing = (providers[providerId] ?? {}) as Record<string, unknown>;
    const existingModels: Array<Record<string, unknown>> = Array.isArray(existing.models)
      ? (existing.models as Array<Record<string, unknown>>)
      : [];

    if (!existingModels.some((m) => m?.id === modelId)) {
      existingModels.push({
        id: modelId,
        name: input.modelName?.trim() || modelId,
        input: ["text"],
        contextWindow: input.contextWindow ?? 131072,
        maxTokens: input.maxTokens ?? 8192,
        compat: { supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
        api: "openai-completions"
      });
    }

    providers[providerId] = {
      ...existing,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      api: "openai-completions",
      models: existingModels
    };
    models.providers = providers;
    cfg.models = models;
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

    if (input.apiKey?.trim()) {
      await withTimeout(
        saveModelApiKey(providerId, input.apiKey.trim()),
        45000,
        "保存 API Key 超时，请稍后重试。"
      );
    }
  },

  async sendTask(input: string | OpenClawTaskRequest): Promise<OpenClawTaskResult> {
    const request = typeof input === "string" ? { message: input } : input;
    const message = request.prompt ?? request.message;

    const result = await requestGatewayChat(message);

    if (!result.content) {
      throw new Error("OpenClaw 未返回任务内容。");
    }

    return {
      taskId: result.runId,
      content: result.content,
      raw: result.raw
    };
  },

  async sendTaskStream(
    input: string | OpenClawTaskRequest,
    onDelta: (deltaText: string) => void
  ): Promise<OpenClawTaskResult> {
    const request = typeof input === "string" ? { message: input } : input;
    const message = request.prompt ?? request.message;

    const result = await requestGatewayChat(message, undefined, onDelta);

    if (!result.content) {
      throw new Error("OpenClaw 未返回任务内容。");
    }

    return {
      taskId: result.runId,
      content: result.content,
      raw: result.raw
    };
  }
};
