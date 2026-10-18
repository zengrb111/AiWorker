import {
  Capability,
  ResolvedModelConfig,
  resolveCapabilityConfig,
  resolveProviderConfig
} from "@/lib/model-credentials";

/**
 * 应用内直连的 OpenAI 兼容客户端。
 *
 * 与旧的网关链路相比，刻意不移植 requestGatewayChat 里的「150 秒连接预算 + 10s 间隔重试」：
 * 那套逻辑是为网关冷启动（实测重启 100~120 秒）设计的，HTTP 直连毫秒级建连，不存在该场景。
 * 这里只对上游 5xx / 网络抖动做有限退避重试（≤2 次），避免放大上游故障。
 */

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatCompleteOptions = {
  userId: string;
  /** 能力，缺省按「对话与写作」取配置。 */
  capability?: Capability;
  /** 单条提示词（与 messages 二选一）。 */
  prompt?: string;
  messages?: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** 长任务可传入 snapshotUserConfig 的一次性快照，保证同一任务内配置一致。 */
  config?: ResolvedModelConfig;
};

export type ChatCompleteResult = {
  content: string;
  model: string;
  providerLabel: string;
};

export type UpstreamErrorKind =
  | "invalid_key"
  | "rate_limited"
  | "not_found"
  | "bad_request"
  | "timeout"
  | "server"
  | "network"
  | "unknown";

/** 上游模型服务返回的错误。kind 供 API 层转结构化错误码，message 为中文可读文案。 */
export class UpstreamModelError extends Error {
  readonly kind: UpstreamErrorKind;
  readonly status: number;
  readonly providerLabel: string;

  constructor(kind: UpstreamErrorKind, message: string, status = 0, providerLabel = "") {
    super(message);
    this.name = "UpstreamModelError";
    this.kind = kind;
    this.status = status;
    this.providerLabel = providerLabel;
  }
}

const DEFAULT_TIMEOUT_MS = Number(process.env.OPENCLAW_CHAT_TIMEOUT_MS ?? 120_000);
const MAX_RETRY = 2;

function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function chatEndpoint(baseUrl: string): string {
  const base = trimBase(baseUrl);
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function buildMessages(opts: ChatCompleteOptions): ChatMessage[] {
  if (opts.messages?.length) return opts.messages;
  const prompt = (opts.prompt ?? "").trim();
  if (!prompt) throw new Error("提示词为空，无法调用模型。");
  return [{ role: "user", content: prompt }];
}

function extractUpstreamDetail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const json = JSON.parse(trimmed) as {
      error?: { message?: string; msg?: string } | string;
      message?: string;
    };
    if (typeof json.error === "string") return json.error.slice(0, 300);
    if (json.error && typeof json.error === "object") {
      return (json.error.message || json.error.msg || "").slice(0, 300);
    }
    return (json.message ?? trimmed).slice(0, 300);
  } catch {
    return trimmed.slice(0, 300);
  }
}

function classifyUpstreamStatus(status: number, detail: string, label: string): UpstreamModelError {
  switch (status) {
    case 401:
    case 403:
      return new UpstreamModelError(
        "invalid_key",
        `「${label}」拒绝了该密钥，请检查 API Key 是否正确、是否已过期或欠费。${detail ? `（${detail}）` : ""}`,
        status,
        label
      );
    case 404:
      return new UpstreamModelError(
        "not_found",
        `「${label}」返回 404，通常是接口地址或模型 id 不正确，请检查系统配置里的接口地址与模型。${detail ? `（${detail}）` : ""}`,
        status,
        label
      );
    case 408:
      return new UpstreamModelError("timeout", `「${label}」响应超时，请稍后重试。`, status, label);
    case 429:
      return new UpstreamModelError(
        "rate_limited",
        `「${label}」当前限流或额度已用尽，请稍后重试或前往系统配置检查余额。${detail ? `（${detail}）` : ""}`,
        status,
        label
      );
    case 400:
    case 422:
      return new UpstreamModelError(
        "bad_request",
        `「${label}」拒绝了本次请求参数：${detail || "请检查模型 id 是否正确"}`,
        status,
        label
      );
    default:
      if (status >= 500) {
        return new UpstreamModelError(
          "server",
          `「${label}」服务端异常（HTTP ${status}），请稍后重试。${detail ? `（${detail}）` : ""}`,
          status,
          label
        );
      }
      return new UpstreamModelError(
        "unknown",
        `「${label}」返回异常响应（HTTP ${status}）：${detail || "无详细信息"}`,
        status,
        label
      );
  }
}

async function resolveConfig(opts: ChatCompleteOptions): Promise<ResolvedModelConfig> {
  if (opts.config) return opts.config;
  return resolveCapabilityConfig(opts.userId, opts.capability ?? "chat");
}

async function postChat(
  config: ResolvedModelConfig,
  body: Record<string, unknown>,
  timeoutMs: number,
  stream: boolean
): Promise<Response> {
  const url = chatEndpoint(config.baseUrl);
  let lastError: UpstreamModelError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok) return res;

      const detail = extractUpstreamDetail(await res.text().catch(() => ""));
      const upstreamError = classifyUpstreamStatus(res.status, detail, config.label);
      // 只对上游 5xx 与网络类错误重试；4xx 是配置/请求问题，重试无意义。
      if (upstreamError.kind !== "server" || attempt === MAX_RETRY) throw upstreamError;
      lastError = upstreamError;
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof UpstreamModelError) {
        if (error.kind !== "server" || attempt === MAX_RETRY) throw error;
        lastError = error;
      } else if (isAbortError(error)) {
        const timeoutError = new UpstreamModelError(
          "timeout",
          `调用「${config.label}」超时（超过 ${Math.round(timeoutMs / 1000)} 秒），请稍后重试或改用更快的模型。`,
          0,
          config.label
        );
        if (stream) throw timeoutError;
        throw timeoutError;
      } else {
        lastError = new UpstreamModelError(
          "network",
          `无法连接「${config.label}」：${error instanceof Error ? error.message : String(error)}`,
          0,
          config.label
        );
        if (attempt === MAX_RETRY) throw lastError;
      }
    }
    // 指数退避：0.6s / 1.8s，只在确认是上游抖动时等待。
    await new Promise((r) => setTimeout(r, 600 * Math.pow(3, attempt)));
  }
  throw lastError ?? new UpstreamModelError("unknown", "调用模型失败。", 0, config.label);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError")
  );
}

function readMessageText(data: unknown): string {
  const json = data as {
    choices?: Array<{ message?: { content?: string | null }; text?: string }>;
  };
  const choice = json.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string" && content) return content;
  if (typeof choice?.text === "string" && choice.text) return choice.text;
  return "";
}

/**
 * 读 finish_reason，区分「上游没给正文」与「正文被输出上限截断」。
 *
 * 后者很容易被误判成模型坏了：reasoning 模型（DeepSeek reasoner / R1 系列）会把
 * 输出预算的大量部分花在思考过程上，任务一复杂，预算可能在轮到正文之前就耗尽，
 * 于是 content 长度为 0、finish_reason=length。此时调大 max_tokens 即可解决。
 */
function readFinishReason(data: unknown): string {
  const json = data as { choices?: Array<{ finish_reason?: string | null }> };
  return String(json.choices?.[0]?.finish_reason ?? "");
}

/** 非流式对话补全。 */
export async function chatComplete(opts: ChatCompleteOptions): Promise<ChatCompleteResult> {
  const config = await resolveConfig(opts);
  const body: Record<string, unknown> = {
    model: config.model,
    messages: buildMessages(opts),
    stream: false
  };
  if (typeof opts.temperature === "number") body.temperature = opts.temperature;
  if (typeof opts.maxTokens === "number") body.max_tokens = opts.maxTokens;

  const res = await postChat(config, body, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, false);
  const data = (await res.json().catch(() => null)) as unknown;
  const content = data ? readMessageText(data) : "";
  if (!content.trim()) {
    const truncated = data ? readFinishReason(data) === "length" : false;
    throw new UpstreamModelError(
      truncated ? "bad_request" : "unknown",
      truncated
        ? `「${config.label}」的输出被长度上限截断，没有产出正文` +
          `（reasoning 模型会把大量预算用于思考）。请调大该模型的输出上限，或换用思考较少的模型。`
        : `「${config.label}」没有返回内容，请稍后重试或更换模型。`,
      200,
      config.label
    );
  }
  return { content, model: config.model, providerLabel: config.label };
}

/**
 * 流式对话补全：解析 OpenAI 兼容 SSE（data: {choices:[{delta:{content}}]}），
 * 把增量文本喂给 onDelta。调用方对前端的输出协议无需改动。
 *
 * 中断时抛出的错误带 partialContent，调用方可据此展示已生成的部分内容。
 */
export async function chatCompleteStream(
  opts: ChatCompleteOptions & { onDelta?: (deltaText: string) => void }
): Promise<ChatCompleteResult> {
  const config = await resolveConfig(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body: Record<string, unknown> = {
    model: config.model,
    messages: buildMessages(opts),
    stream: true
  };
  if (typeof opts.temperature === "number") body.temperature = opts.temperature;
  if (typeof opts.maxTokens === "number") body.max_tokens = opts.maxTokens;

  const res = await postChat(config, body, timeoutMs, true);
  if (!res.body) {
    throw new UpstreamModelError("unknown", `「${config.label}」未返回流式响应。`, 200, config.label);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let content = "";
  let idleTimer = setTimeout(() => reader.cancel(), timeoutMs);

  const fail = (error: UpstreamModelError) => {
    clearTimeout(idleTimer);
    if (content.trim()) {
      (error as Error & { partialContent?: string }).partialContent = content;
    }
    throw error;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => reader.cancel(), timeoutMs);

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let delta = "";
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string | null } }>;
          };
          delta = json.choices?.[0]?.delta?.content ?? "";
        } catch {
          continue; // 忽略无法解析的心跳/注释行
        }
        if (!delta) continue;
        content += delta;
        opts.onDelta?.(delta);
      }
    }
  } catch (error) {
    if (error instanceof UpstreamModelError) throw error;
    if (isAbortError(error) || (error as Error)?.name === "AbortError") {
      fail(
        new UpstreamModelError(
          "timeout",
          `调用「${config.label}」超时（超过 ${Math.round(timeoutMs / 1000)} 秒未收到内容）。`,
          0,
          config.label
        )
      );
    }
    fail(
      new UpstreamModelError(
        "network",
        `「${config.label}」连接中断：${error instanceof Error ? error.message : String(error)}`,
        0,
        config.label
      )
    );
  } finally {
    clearTimeout(idleTimer);
  }

  if (!content.trim()) {
    throw new UpstreamModelError(
      "unknown",
      `「${config.label}」没有返回内容，请稍后重试或更换模型。`,
      200,
      config.label
    );
  }
  return { content, model: config.model, providerLabel: config.label };
}

/** 连通性探测结果（写入 provider 的 status / statusMsg）。 */
export type ProbeResult = {
  ok: boolean;
  status: "ok" | "invalid";
  message: string;
};

async function probeOpenAICompatible(config: ResolvedModelConfig): Promise<ProbeResult> {
  const body = {
    model: config.model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false
  };
  const res = await postChat(config, body, 20_000, false);
  void res;
  return { ok: true, status: "ok", message: "连接正常，模型可用。" };
}

async function probeZhipuTTS(config: ResolvedModelConfig): Promise<ProbeResult> {
  const url = config.baseUrl.includes("/audio/speech")
    ? trimBase(config.baseUrl)
    : `${trimBase(config.baseUrl)}/audio/speech`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      input: "啊",
      voice: process.env.ZHIPU_TTS_VOICE || "xiaochen",
      response_format: "pcm"
    }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) {
    const detail = extractUpstreamDetail(await res.text().catch(() => ""));
    throw classifyUpstreamStatus(res.status, detail, config.label);
  }
  await res.arrayBuffer();
  return { ok: true, status: "ok", message: "连接正常，配音接口可用。" };
}

async function probeDashscopeTTS(config: ResolvedModelConfig): Promise<ProbeResult> {
  const base = trimBase(config.baseUrl).replace(/\/compatible-mode\/v1$/, "");
  const url = `${base}/api/v1/services/aigc/multimodal-generation/generation`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      input: { text: "啊", voice: process.env.QWEN_TTS_VOICE || "Cherry" }
    }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) {
    const detail = extractUpstreamDetail(await res.text().catch(() => ""));
    throw classifyUpstreamStatus(res.status, detail, config.label);
  }
  const json = (await res.json().catch(() => null)) as { output?: { audio?: { url?: string } } } | null;
  if (!json?.output?.audio?.url) {
    throw new UpstreamModelError(
      "unknown",
      `「${config.label}」未返回音频地址，请确认已开通该模型。`,
      200,
      config.label
    );
  }
  return { ok: true, status: "ok", message: "连接正常，配音接口可用。" };
}

async function probePollinationsVideo(config: ResolvedModelConfig): Promise<ProbeResult> {
  const base = trimBase(config.baseUrl);
  const url = new URL(`${base}/${encodeURIComponent(config.model || "wan-fast")}`);
  url.searchParams.set("key", config.apiKey);
  // 只探测接口可达性：请求一张 16x16 的最小图片，避免生成费用。
  url.searchParams.set("width", "16");
  url.searchParams.set("height", "16");
  url.searchParams.set("nologo", "true");
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) {
    const detail = extractUpstreamDetail(await res.text().catch(() => ""));
    throw classifyUpstreamStatus(res.status, detail, config.label);
  }
  await res.arrayBuffer();
  return { ok: true, status: "ok", message: "连接正常，文生视频接口可用。" };
}

/**
 * 「测试连接」：按接口形态做最小连通性探测。
 * 永不抛错 —— 失败一律转成 ok=false + 中文原因，由调用方写回状态。
 */
export async function probeProvider(
  userId: string,
  rowId: string,
  apiFormat?: string,
  model?: string
): Promise<ProbeResult> {
  const stored = await resolveProviderConfig(userId, rowId);
  if (!stored) {
    return { ok: false, status: "invalid", message: "服务不存在或已删除。" };
  }
  const config: ResolvedModelConfig = { ...stored, model: model || stored.model };

  try {
    switch (config.apiFormat) {
      case "zhipu-tts":
        return await probeZhipuTTS(config);
      case "dashscope-tts":
        return await probeDashscopeTTS(config);
      case "pollinations-video":
        return await probePollinationsVideo(config);
      case "tavily-search":
      case "bocha-search": {
        const { probeSearchProvider } = await import("@/lib/web-search");
        return await probeSearchProvider(config);
      }
      default:
        return await probeOpenAICompatible(config);
    }
  } catch (error) {
    if (error instanceof UpstreamModelError) {
      return { ok: false, status: "invalid", message: error.message };
    }
    return {
      ok: false,
      status: "invalid",
      message: `连接失败：${error instanceof Error ? error.message : String(error)}`
    };
  }
}
