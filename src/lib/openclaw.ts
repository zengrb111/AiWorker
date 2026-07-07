import { createRequire } from "module";
import { pathToFileURL } from "node:url";
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

function endpoint(defaultPath: string, envName: string): string {
  return process.env[envName] || defaultPath;
}

function fillPath(path: string, params: Record<string, string>): string {
  return Object.entries(params).reduce(
    (nextPath, [key, value]) => nextPath.replace(`:${key}`, encodeURIComponent(value)),
    path
  );
}

function openClawAuth(): { token: string } | undefined {
  const token = process.env.OPENCLAW_API_TOKEN?.trim();
  return token ? { token } : undefined;
}

function gatewayErrorMessage(error: GatewayResponse["error"]): string {
  if (!error) {
    return "Gateway request failed.";
  }
  const detail = error.details ? ` ${JSON.stringify(error.details)}` : "";
  return `${error.message ?? error.code ?? "Gateway request failed."}${detail}`;
}

async function requestGateway<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 45000): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(gatewayUrl(), { origin: gatewayOrigin() });
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const timers = new Set<NodeJS.Timeout>();

    function cleanup() {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      pending.clear();
      try {
        ws.close();
      } catch {
        // Ignore close errors from an already closed socket.
      }
    }

    function fail(error: Error) {
      cleanup();
      reject(error);
    }

    function send(requestMethod: string, requestParams: Record<string, unknown>, requestTimeoutMs: number) {
      const id = crypto.randomUUID();
      ws.send(JSON.stringify({ type: "req", id, method: requestMethod, params: requestParams }));
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(new Error(`OpenClaw Gateway 调用超时：${requestMethod}`));
      }, requestTimeoutMs);
      timers.add(timer);
      return new Promise<unknown>((requestResolve, requestReject) => {
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
          }
        });
      });
    }

    ws.on("open", async () => {
      try {
        await send(
          "connect",
          {
            minProtocol: 4,
            maxProtocol: 4,
            client: {
              id: process.env.OPENCLAW_GATEWAY_CLIENT_ID || "gateway-client",
              version: "chuangxingyun-0.1.0",
              platform: "web",
              mode: "backend"
            },
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"],
            caps: ["tool-events"],
            auth: openClawAuth(),
            userAgent: "Chuangxingyun AI Worker",
            locale: "zh-CN"
          },
          15000
        );
        const result = await send(method, params, timeoutMs);
        cleanup();
        resolve(result as T);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ws.on("message", (data) => {
      let message: GatewayResponse;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.type !== "res" || !message.id) {
        return;
      }
      const request = pending.get(message.id);
      if (!request) {
        return;
      }
      pending.delete(message.id);
      if (message.ok) {
        request.resolve(message.payload);
      } else {
        request.reject(new Error(gatewayErrorMessage(message.error)));
      }
    });

    ws.on("error", (error) => {
      fail(new Error(`OpenClaw Gateway 连接失败：${error.message}`));
    });

    ws.on("close", (code, reason) => {
      if (pending.size > 0) {
        fail(new Error(`OpenClaw Gateway 已关闭：${code} ${String(reason)}`.trim()));
      }
    });
  });
}

async function requestOpenClaw<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  const auth = openClawAuth();
  if (auth) {
    headers.set("Authorization", `Bearer ${auth.token}`);
  }

  const url = `${requireBaseUrl()}${path}`;
  const timeoutMs = Number(process.env.OPENCLAW_TIMEOUT_MS ?? 10000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers,
      cache: "no-store"
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenClaw 服务不可用：无法连接 ${url}（${detail}）`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`OpenClaw 调用失败：${url} 返回了非 JSON 内容。`);
  }

  if (!response.ok) {
    const message = payload.error ?? payload.message ?? response.statusText;
    const detail = typeof message === "string" ? message : JSON.stringify(message);
    throw new Error(`OpenClaw 调用失败：${url} 返回 ${response.status}，${detail}`);
  }

  return payload as T;
}

function pickString(payload: Record<string, unknown>, keys: string[]): string | undefined {
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
    const payload = await requestOpenClaw<Record<string, unknown>>(endpoint("/agent/tasks", "OPENCLAW_TASK_PATH"), {
      method: "POST",
      body: JSON.stringify({
        message: request.prompt ?? request.message,
        originalMessage: request.message,
        context: request.context,
        conversationId: request.conversationId,
        userId: request.userId
      })
    });
    const content = pickString(payload, ["content", "message", "result", "text"]);
    if (!content) {
      throw new Error("OpenClaw 未返回任务内容。");
    }
    const inlineImages = Array.isArray(payload.inlineImages)
      ? payload.inlineImages.filter((item): item is string => typeof item === "string")
      : [];
    return {
      taskId: pickString(payload, ["taskId", "task_id", "id"]),
      title: pickString(payload, ["title"]),
      content,
      coverImageUrl: pickString(payload, ["coverImageUrl", "cover_image_url"]),
      inlineImages,
      raw: payload
    };
  }
};

