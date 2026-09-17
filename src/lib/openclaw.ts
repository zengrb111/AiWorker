import { createRequire } from "module";
import { pathToFileURL } from "node:url";
import { sign, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
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
    accountId?: string;
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

async function loadWeixinLoginModule(): Promise<WeixinLoginModule> {
  const pluginPath =
    process.env.OPENCLAW_WEIXIN_LOGIN_MODULE ||
    "C:\\Users\\zengr\\.openclaw\\npm\\projects\\tencent-weixin-openclaw-weixin-7783ac86ba\\node_modules\\@tencent-weixin\\openclaw-weixin\\dist\\src\\auth\\login-qr.js";
  const runtimeImport = new Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<unknown>;
  return (await runtimeImport(pathToFileURL(pluginPath).href)) as WeixinLoginModule;
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
      const fail = (message: string) => {
        const err = new Error(message) as Error & { partialContent?: string };
        if (deltaAccum.trim()) err.partialContent = deltaAccum;
        reject(err);
      };
      const timer = setTimeout(() => {
        fail(`OpenClaw 等待助手回复超时（${effectiveTimeout}ms）`);
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

export const openClawClient = {
  async createWechatBindingQr(): Promise<OpenClawQr> {
    const weixin = await loadWeixinLoginModule();
    const result = await weixin.startWeixinLoginWithQr({
      force: true,
      apiBaseUrl: weixinApiBaseUrl(),
      verbose: false
    });
    if (!result.qrcodeUrl) {
      throw new Error(result.message || "OpenClaw 微信插件未返回绑定二维码。");
    }
    return {
      ticketId: result.sessionKey,
      qrCodeUrl: await renderQrImageDataUrl(result.qrcodeUrl),
      qrCodeText: result.qrcodeUrl
    };
  },

  async getWechatBindingStatus(ticketId: string): Promise<OpenClawBindingStatus> {
    const weixin = await loadWeixinLoginModule();
    const result = await weixin.waitForWeixinLogin({
      sessionKey: ticketId,
      apiBaseUrl: weixinApiBaseUrl(),
      timeoutMs: 480000,
      verbose: false
    });
    const connected = result.connected || result.alreadyConnected === true;
    return {
      status: connected ? "bound" : "pending",
      ticketId,
      wechatNickname: connected ? "OpenClaw 微信通道" : undefined,
      wechatOpenId: result.accountId ?? result.userId,
      wechatNo: result.userId ?? result.accountId
    };
  },

  async unbindWechat(wechatOpenId: string): Promise<void> {
    await requestGateway("channels.logout", { channel: "whatsapp", wechatOpenId });
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
