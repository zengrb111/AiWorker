import {
  ModelConfigError,
  ResolvedModelConfig,
  resolveCapabilityConfig,
  snapshotUserConfig
} from "@/lib/model-credentials";
import type { ProbeResult } from "@/lib/llm-client";
import { describeOrigins, fetchHotBoards } from "@/lib/hot-boards";

/**
 * 联网搜索客户端。
 *
 * 两条路径，优先级固定：
 * 1) 用户自己的搜索服务（Tavily / 博查）—— token 归属用户，密钥从其模型服务取；
 * 2) 内置公开热榜（hot-boards.ts）—— 零 key、零 token，无需任何配置。
 *
 * 之所以保留第 2 条：改造前的当日热点就不依赖搜索 API（Gateway 的
 * hot-topic-digest skill 直接抓公开榜），若只留需要付费 key 的路径，
 * 等于把「开箱可用」降级成「先注册付费服务」。
 *
 * 两条路径都失败时抛 SearchError，由调用方显式处理 —— 严禁静默退化成「无联网」，
 * 更不允许让模型在没有真实素材的情况下编造当日热点。
 */

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  /** 数据来源：用户搜索服务为 tavily/bocha；内置热榜为 weibo/toutiao/douyin/zhihu/baidu */
  origin?: string;
};

export type SearchErrorKind =
  | "no_result"
  | "invalid_key"
  | "rate_limited"
  | "timeout"
  | "server"
  | "network"
  | "unsupported";

export class SearchError extends Error {
  readonly kind: SearchErrorKind;

  constructor(kind: SearchErrorKind, message: string) {
    super(message);
    this.name = "SearchError";
    this.kind = kind;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function truncate(text: string, max = 400): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function readErrorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return truncate(text, 200);
}

function classifyStatus(res: Response, detail: string, label: string): SearchError {
  if (res.status === 401 || res.status === 403) {
    return new SearchError(
      "invalid_key",
      `联网搜索服务「${label}」拒绝了该密钥，请在系统配置中检查 API Key。${detail ? `（${detail}）` : ""}`
    );
  }
  if (res.status === 429) {
    return new SearchError(
      "rate_limited",
      `联网搜索服务「${label}」当前限流或额度已用尽，请稍后重试。${detail ? `（${detail}）` : ""}`
    );
  }
  if (res.status === 408) {
    return new SearchError("timeout", `联网搜索服务「${label}」响应超时，请稍后重试。`);
  }
  if (res.status >= 500) {
    return new SearchError(
      "server",
      `联网搜索服务「${label}」暂时不可用（HTTP ${res.status}），请稍后重试。${detail ? `（${detail}）` : ""}`
    );
  }
  return new SearchError(
    "unsupported",
    `联网搜索服务「${label}」返回异常响应（HTTP ${res.status}）：${detail || "无详细信息"}`
  );
}

async function searchTavily(config: ResolvedModelConfig, query: string, topK: number): Promise<SearchHit[]> {
  const url = trimBase(config.baseUrl).includes("/search")
    ? trimBase(config.baseUrl)
    : `${trimBase(config.baseUrl)}/search`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({ query, max_results: topK, search_depth: "basic" }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  if (!res.ok) throw classifyStatus(res, await readErrorDetail(res), config.label);

  const json = (await res.json().catch(() => null)) as
    | { results?: Array<{ title?: string; url?: string; content?: string }> }
    | null;
  const hits = (json?.results ?? []).map((item) => ({
    title: truncate(item.title ?? "（无标题）", 120),
    url: item.url ?? "",
    snippet: truncate(item.content ?? ""),
    origin: "tavily"
  }));
  if (!hits.length) throw new SearchError("no_result", `联网搜索没有返回「${query}」的结果，请换个关键词重试。`);
  return hits;
}

async function searchBocha(config: ResolvedModelConfig, query: string, topK: number): Promise<SearchHit[]> {
  const url = trimBase(config.baseUrl).includes("/web-search")
    ? trimBase(config.baseUrl)
    : `${trimBase(config.baseUrl)}/web-search`;
  if (!config.apiSecret) {
    throw new SearchError(
      "invalid_key",
      "博查联网搜索需要同时填写 Access-Key 与 Secret-Key，请在系统配置中补全。"
    );
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      summary: true,
      count: topK,
      freshness: "noLimit",
      query
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  if (!res.ok) throw classifyStatus(res, await readErrorDetail(res), config.label);

  const json = (await res.json().catch(() => null)) as
    | {
        data?: {
          webPages?: {
            value?: Array<{ name?: string; url?: string; summary?: string; snippet?: string }>;
          };
        };
      }
    | null;
  const hits = (json?.data?.webPages?.value ?? []).map((item) => ({
    title: truncate(item.name ?? "（无标题）", 120),
    url: item.url ?? "",
    snippet: truncate(item.summary || item.snippet || ""),
    origin: "bocha"
  }));
  if (!hits.length) throw new SearchError("no_result", `联网搜索没有返回「${query}」的结果，请换个关键词重试。`);
  return hits;
}

/**
 * 内置公开热榜：用户没配搜索服务时使用，零 key、零 token。
 * query 在这里不参与检索（公开榜给的是全网当日榜单），只用于日志排查。
 */
async function searchBuiltinHotBoards(topK: number): Promise<SearchHit[]> {
  const items = await fetchHotBoards(topK);
  console.log(`[web-search] 使用内置公开热榜（${describeOrigins(items)}），共 ${items.length} 条`);
  return items.map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    origin: item.origin
  }));
}

/** 结果是否来自内置热榜（用于界面上如实告知用户当前数据源）。 */
export function isBuiltinHotBoard(hits: SearchHit[]): boolean {
  return hits.length > 0 && hits.every((hit) => Boolean(hit.origin) && !["tavily", "bocha"].includes(hit.origin ?? ""));
}

export type SearchOptions = {
  userId: string;
  query: string;
  topK?: number;
  /** 长任务可传入 snapshotUserConfig 的一次性快照。 */
  config?: ResolvedModelConfig | null;
};

/**
 * 拉取真实联网结果。失败一律抛 SearchError，由调用方决定如何提示用户。
 *
 * 未指定搜索服务时使用内置公开热榜（零配置即可拿到当日热点）；
 * 用户指定了搜索服务则严格走用户自己的服务 —— 它失败时直接报错，
 * 不偷偷回落到内置榜，否则用户会以为拿到的是他付费搜出来的结果。
 */
export async function searchWeb(opts: SearchOptions): Promise<SearchHit[]> {
  const query = opts.query.trim();
  if (!query) throw new SearchError("no_result", "搜索关键词为空。");

  const topK = Math.min(Math.max(opts.topK ?? 8, 1), 20);

  // resolveCapabilityConfig 在未指定时抛 ModelConfigError，这里刻意捕获：
  // 「没配搜索服务」不是错误状态，退到内置公开热榜即可。
  let config: ResolvedModelConfig | null = null;
  try {
    config = opts.config !== undefined ? opts.config : await resolveCapabilityConfig(opts.userId, "search");
  } catch (error) {
    if (!(error instanceof ModelConfigError)) throw error;
    config = null;
  }

  if (!config) {
    try {
      return await searchBuiltinHotBoards(topK);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SearchError(
        "network",
        `内置公开热榜暂时不可用（${message}）。可在「系统配置」中指定 Tavily 或博查作为联网搜索服务。`
      );
    }
  }

  try {
    switch (config.apiFormat) {
      case "tavily-search":
        return await searchTavily(config, query, topK);
      case "bocha-search":
        return await searchBocha(config, query, topK);
      default:
        throw new SearchError(
          "unsupported",
          `「${config.label}」不是联网搜索服务，请在系统配置中把「联网搜索」指向 Tavily 或博查。`
        );
    }
  } catch (error) {
    if (error instanceof SearchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new SearchError("timeout", `联网搜索超时（${query}），请稍后重试。`);
    }
    throw new SearchError("network", `联网搜索失败：${message}`);
  }
}

/** 「测试连接」用：发一条极短 query 验证搜索服务可用。 */
export async function probeSearchProvider(config: ResolvedModelConfig): Promise<ProbeResult> {
  try {
    const hits =
      config.apiFormat === "bocha-search"
        ? await searchBocha(config, "今日热点", 1)
        : await searchTavily(config, "今日热点", 1);
    return {
      ok: true,
      status: "ok",
      message: `连接正常，已返回 ${hits.length} 条搜索结果。`
    };
  } catch (error) {
    if (error instanceof SearchError) return { ok: false, status: "invalid", message: error.message };
    return {
      ok: false,
      status: "invalid",
      message: `连接失败：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/** 长任务入口复用快照时可直接传入，避免二次解析配置。 */
export type UserConfigSnapshot = Awaited<ReturnType<typeof snapshotUserConfig>>;
