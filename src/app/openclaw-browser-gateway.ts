type GatewayConfig = {
  wsUrl: string;
  token: string;
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

type GatewayEvent = {
  type?: string;
  event?: string;
  payload?: unknown;
};

type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKeyJwk: JsonWebKey;
};

type DeviceAuth = {
  deviceId: string;
  token: string;
  scopes: string[];
};

export type BrowserQrData = {
  ticketId: string;
  qrCodeUrl?: string;
  qrCodeText?: string;
};

export type BrowserBindingStatus = {
  status: "pending" | "bound" | "unbound";
  ticketId: string;
  wechatNickname?: string;
  wechatOpenId?: string;
  wechatNo?: string;
};

const identityKey = "chuangxingyun.openclaw.deviceIdentity";
const authKey = "chuangxingyun.openclaw.deviceAuth";
const scopes = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];
const clientId = "openclaw-control-ui";
const clientMode = "ui";
const role = "operator";
const platform = "web";

function base64Url(bytes: ArrayBuffer | Uint8Array) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes);
  return crypto.subtle.digest("SHA-256", copy.buffer);
}

async function generateIdentity(): Promise<DeviceIdentity> {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" } as EcKeyGenParams, true, ["sign", "verify"]);
  const publicDer = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const publicRaw = publicDer.slice(-32);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    deviceId: hex(await sha256(publicRaw)),
    publicKey: base64Url(publicRaw),
    privateKeyJwk
  };
}

async function loadIdentity() {
  const stored = localStorage.getItem(identityKey);
  if (stored) {
    try {
      return JSON.parse(stored) as DeviceIdentity;
    } catch {
      localStorage.removeItem(identityKey);
    }
  }
  const identity = await generateIdentity();
  localStorage.setItem(identityKey, JSON.stringify(identity));
  return identity;
}

function loadDeviceAuth(deviceId: string): DeviceAuth | null {
  const stored = localStorage.getItem(authKey);
  if (!stored) {
    return null;
  }
  try {
    const auth = JSON.parse(stored) as DeviceAuth;
    return auth.deviceId === deviceId && auth.token ? auth : null;
  } catch {
    localStorage.removeItem(authKey);
    return null;
  }
}

function storeDeviceAuth(deviceId: string, token: string, authScopes: string[]) {
  localStorage.setItem(authKey, JSON.stringify({ deviceId, token, scopes: authScopes }));
}

function gatewayError(error: GatewayResponse["error"]) {
  if (!error) {
    return "OpenClaw Gateway 调用失败。";
  }
  const details = error.details ? ` ${JSON.stringify(error.details)}` : "";
  return `${error.message ?? error.code ?? "OpenClaw Gateway 调用失败。"}${details}`;
}

async function readConfig(): Promise<GatewayConfig> {
  const response = await fetch("/api/openclaw/gateway-config", { cache: "no-store" });
  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(payload.error || "读取 OpenClaw Gateway 配置失败。");
  }
  return payload.data;
}

async function signPayload(identity: DeviceIdentity, payload: string) {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    identity.privateKeyJwk,
    { name: "Ed25519" } as EcKeyImportParams,
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign({ name: "Ed25519" } as Algorithm, privateKey, new TextEncoder().encode(payload));
  return base64Url(signature);
}

function buildAuthPayload(params: {
  identity: DeviceIdentity;
  token: string;
  nonce: string;
  signedAtMs: number;
}) {
  return [
    "v3",
    params.identity.deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(","),
    String(params.signedAtMs),
    params.token,
    params.nonce,
    platform,
    ""
  ].join("|");
}

async function connectGateway<T>(call: (request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>) {
  const config = await readConfig();
  const identity = await loadIdentity();
  const storedAuth = loadDeviceAuth(identity.deviceId);
  const token = storedAuth?.token ?? config.token;

  return await new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(config.wsUrl);
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const timeout = window.setTimeout(() => {
      reject(new Error("连接 OpenClaw Gateway 超时。"));
      ws.close();
    }, 60000);

    function cleanup() {
      window.clearTimeout(timeout);
      pending.clear();
      ws.close();
    }

    function request(method: string, params: Record<string, unknown> = {}) {
      const id = crypto.randomUUID();
      ws.send(JSON.stringify({ type: "req", id, method, params }));
      return new Promise<unknown>((requestResolve, requestReject) => {
        pending.set(id, { resolve: requestResolve, reject: requestReject });
      });
    }

    async function sendConnect(nonce: string) {
      const signedAtMs = Date.now();
      const signature = await signPayload(identity, buildAuthPayload({ identity, token, nonce, signedAtMs }));
      const auth = storedAuth ? { token, deviceToken: token } : { token };
      const hello = (await request("connect", {
        minProtocol: 4,
        maxProtocol: 4,
        client: { id: clientId, version: "chuangxingyun-web", platform, mode: clientMode },
        role,
        scopes: storedAuth?.scopes?.length ? storedAuth.scopes : scopes,
        caps: ["tool-events"],
        auth,
        device: {
          id: identity.deviceId,
          publicKey: identity.publicKey,
          signature,
          signedAt: signedAtMs,
          nonce
        },
        locale: "zh-CN"
      })) as { auth?: { deviceToken?: string; scopes?: string[] } };

      if (hello.auth?.deviceToken) {
        storeDeviceAuth(identity.deviceId, hello.auth.deviceToken, hello.auth.scopes ?? scopes);
      }

      const result = await call(request);
      cleanup();
      resolve(result);
    }

    ws.addEventListener("message", (event) => {
      let message: GatewayResponse | GatewayEvent;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (message.type === "event" && "event" in message && message.event === "connect.challenge") {
        const payload = message.payload as { nonce?: string } | undefined;
        if (!payload?.nonce) {
          reject(new Error("OpenClaw Gateway 未返回连接挑战。"));
          cleanup();
          return;
        }
        void sendConnect(payload.nonce).catch((error) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }

      if (message.type !== "res" || !("id" in message) || !message.id) {
        return;
      }
      const item = pending.get(message.id);
      if (!item) {
        return;
      }
      pending.delete(message.id);
      if (message.ok) {
        item.resolve(message.payload);
      } else {
        item.reject(new Error(gatewayError(message.error)));
      }
    });

    ws.addEventListener("error", () => {
      cleanup();
      reject(new Error("无法连接 OpenClaw Gateway，请确认 OpenClaw 已启动。"));
    });
  });
}

function pickString(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

export async function createWechatQrInBrowser(): Promise<BrowserQrData> {
  return connectGateway(async (request) => {
    const payload = (await request("web.login.start", { force: true, timeoutMs: 30000 })) as Record<string, unknown>;
    const qrCodeUrl = pickString(payload, ["qrDataUrl", "qrCodeUrl", "qr_code_url", "url"]);
    if (!qrCodeUrl) {
      throw new Error(pickString(payload, ["message", "text"]) || "OpenClaw 未返回微信通道二维码。");
    }
    return {
      ticketId: crypto.randomUUID(),
      qrCodeUrl,
      qrCodeText: pickString(payload, ["message", "text"])
    };
  });
}

export async function waitWechatBindingInBrowser(ticketId: string): Promise<BrowserBindingStatus> {
  return connectGateway(async (request) => {
    const payload = (await request("web.login.wait", { timeoutMs: 120000 })) as Record<string, unknown>;
    const connected = payload.connected === true;
    return {
      status: connected ? "bound" : "pending",
      ticketId,
      wechatNickname: pickString(payload, ["wechatNickname", "nickname", "name"]) ?? (connected ? "OpenClaw 微信通道" : undefined),
      wechatOpenId: pickString(payload, ["wechatOpenId", "openid", "wechat_open_id"]),
      wechatNo: pickString(payload, ["wechatNo", "wechat_no", "wechatId"])
    };
  });
}
