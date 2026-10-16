import { decryptCredential, encryptCredential } from "@/lib/platform-creds";
import { prisma } from "@/lib/prisma";

/**
 * 用户级模型凭据解析层。
 *
 * 设计要点：
 * - 所有模型服务与密钥都以 userId 为维度存储在数据库，其他用户既读不到也用不了；
 * - 凭据 AES-256-GCM 加密（复用 platform-creds.ts，密钥文件 .platform-cred.key）；
 * - 解析结果带 60s 内存缓存（视频链路会并发多次解析），写入侧精确失效；
 * - 未配置时抛 ModelConfigError，文案明确指向「系统配置」，不存在平台公共密钥兜底。
 */

/** 平台按能力分配模型。新增能力只需扩展此联合类型与 CAPABILITY_LABELS。 */
export type Capability =
  | "chat" // 对话与写作（主对话、拆解、仿写、humanize、prepare、定时任务、爆款拆解）
  | "vision" // 识图
  | "ocr" // 图片文字识别
  | "tts" // 配音
  | "video" // 文生视频
  | "storyboard" // 分镜规划（DSH）
  | "embedding" // 向量化（RAG）
  | "search"; // 联网搜索（热点）

export const ALL_CAPABILITIES: Capability[] = [
  "chat",
  "vision",
  "ocr",
  "tts",
  "video",
  "storyboard",
  "embedding",
  "search"
];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  chat: "对话与写作",
  vision: "识图",
  ocr: "图片文字识别",
  tts: "配音",
  video: "文生视频",
  storyboard: "分镜规划",
  embedding: "向量化",
  search: "联网搜索"
};

/** 界面上给用户看的用途说明，避免用户面对八个下拉框猜不出区别。 */
export const CAPABILITY_HINTS: Record<Capability, string> = {
  chat: "会话正文生成、一键仿写、去 AI 味改写与定时任务都走这里",
  vision: "读取图片内容，用于爆款封面分析与图文素材理解",
  ocr: "从图片里提取文字，识别后进入知识库或改写流程",
  tts: "把文案合成为配音音频，未配置云端配音时仍可用本地发音兜底",
  video: "按文案生成短视频画面",
  storyboard: "为视频生成逐镜头分镜脚本",
  embedding: "知识库切片的向量化检索",
  search: "抓取当日真实联网热点，再交给对话模型筛选排序"
};

/** 接口形态：决定直连时的请求路径与报文风格。 */
export type ApiFormat =
  | "openai-completions" // OpenAI 兼容 /chat/completions（智谱、千问、豆包、混元、DeepSeek…）
  | "dashscope-tts" // 阿里云百炼 TTS
  | "zhipu-tts" // 智谱 TTS
  | "pollinations-video" // Pollinations 文生视频
  | "tavily-search" // Tavily 联网搜索
  | "bocha-search"; // 博查联网搜索（双密钥）

export const API_FORMAT_LABELS: Record<ApiFormat, string> = {
  "openai-completions": "OpenAI 兼容接口",
  "dashscope-tts": "阿里云百炼配音",
  "zhipu-tts": "智谱配音",
  "pollinations-video": "文生视频",
  "tavily-search": "Tavily 联网搜索",
  "bocha-search": "博查联网搜索"
};

export type ModelConfigErrorKind =
  | "no_provider" // 还没添加过任何模型服务
  | "no_assignment" // 加了服务，但该能力没指定默认模型
  | "invalid_key"; // 凭据缺失或解密失败

/** 凭据缺失或无效。kind 供 API 层转结构化错误码，message 可直接展示给用户。 */
export class ModelConfigError extends Error {
  readonly capability: Capability | null;
  readonly kind: ModelConfigErrorKind;

  constructor(message: string, kind: ModelConfigErrorKind, capability: Capability | null = null) {
    super(message);
    this.name = "ModelConfigError";
    this.kind = kind;
    this.capability = capability;
  }
}

/** 某项能力实际生效的模型配置（已解密，可直接发起上游请求）。 */
export type ResolvedModelConfig = {
  /** UserModelProvider.id（行级引用） */
  rowId: string;
  providerId: string;
  label: string;
  baseUrl: string;
  apiFormat: ApiFormat;
  model: string;
  apiKey: string;
  /** 仅博查等需要双密钥的服务使用。 */
  apiSecret?: string;
};

/** 落库前的凭据明文结构。 */
export type ProviderCredential = {
  apiKey: string;
  apiSecret?: string;
};

type CachedProvider = Omit<ResolvedModelConfig, "model">;

type CachedUserConfig = {
  expiresAt: number;
  /** rowId → 已解密的服务配置 */
  providers: Map<string, CachedProvider>;
  /** capability → 分配行 */
  assignments: Map<Capability, { providerRowId: string; model: string }>;
};

const CACHE_TTL_MS = 60_000;

const cache = new Map<string, CachedUserConfig>();
const inflight = new Map<string, Promise<CachedUserConfig>>();

function decodeCredential(packed: string | null, capability: Capability | null): ProviderCredential {
  if (!packed) {
    throw new ModelConfigError("模型服务缺少密钥，请重新填写并保存。", "invalid_key", capability);
  }
  let parsed: ProviderCredential;
  try {
    parsed = JSON.parse(decryptCredential(packed)) as ProviderCredential;
  } catch {
    throw new ModelConfigError(
      "模型服务的密钥无法解密，请删除后重新添加。",
      "invalid_key",
      capability
    );
  }
  if (!parsed || typeof parsed.apiKey !== "string" || !parsed.apiKey.trim()) {
    throw new ModelConfigError("模型服务缺少密钥，请重新填写并保存。", "invalid_key", capability);
  }
  return { apiKey: parsed.apiKey.trim(), apiSecret: parsed.apiSecret?.trim() || undefined };
}

/** 凭据加密后落库（JSON blob，天然支持双密钥）。 */
export function encodeCredential(credential: ProviderCredential): string {
  return encryptCredential(
    JSON.stringify({ apiKey: credential.apiKey, apiSecret: credential.apiSecret ?? "" })
  );
}

/** 掩码回显：sk-1234…cdef → sk-1***cdef */
export function maskSecret(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/** 仅供设置页展示掩码：解密失败返回 null（界面显示「凭据无效」），永不返回明文给前端。 */
export function decryptProviderCredential(packed: string | null): ProviderCredential | null {
  try {
    return decodeCredential(packed, null);
  } catch {
    return null;
  }
}

async function loadUserConfig(userId: string): Promise<CachedUserConfig> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit;

  const pending = inflight.get(userId);
  if (pending) return pending;

  const task = (async () => {
    const [rows, assignmentRows] = await Promise.all([
      prisma.userModelProvider.findMany({ where: { userId } }),
      prisma.userModelAssignment.findMany({ where: { userId } })
    ]);

    const providers = new Map<string, CachedProvider>();
    for (const row of rows) {
      let credential: ProviderCredential;
      try {
        credential = decodeCredential(row.credentialEnc, null);
      } catch {
        continue; // 凭据损坏的服务不进入可用集合，UI 会显示为「凭据无效」
      }
      providers.set(row.id, {
        rowId: row.id,
        providerId: row.providerId,
        label: row.label,
        baseUrl: row.baseUrl,
        apiFormat: row.apiFormat as ApiFormat,
        apiKey: credential.apiKey,
        apiSecret: credential.apiSecret
      });
    }

    const assignments = new Map<Capability, { providerRowId: string; model: string }>();
    for (const row of assignmentRows) {
      assignments.set(row.capability as Capability, {
        providerRowId: row.providerRowId,
        model: row.model
      });
    }

    const next: CachedUserConfig = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      providers,
      assignments
    };
    cache.set(userId, next);
    return next;
  })();

  inflight.set(userId, task);
  try {
    return await task;
  } finally {
    inflight.delete(userId);
  }
}

/**
 * 解析用户在某项能力上的模型配置。
 * 未配置时抛 ModelConfigError，文案明确引导到「系统配置」。
 * 带 60s 内存缓存；写入侧调用 invalidateUserCache(userId) 精确失效。
 */
export async function resolveCapabilityConfig(
  userId: string,
  capability: Capability
): Promise<ResolvedModelConfig> {
  const config = await loadUserConfig(userId);

  const assignment = config.assignments.get(capability);
  const provider = assignment ? config.providers.get(assignment.providerRowId) : undefined;

  if (config.providers.size === 0) {
    throw new ModelConfigError(
      `尚未配置「${CAPABILITY_LABELS[capability]}」所需的模型服务，请前往「系统配置」添加模型服务并填写 API Key。`,
      "no_provider",
      capability
    );
  }
  if (!assignment || !provider) {
    throw new ModelConfigError(
      `尚未指定「${CAPABILITY_LABELS[capability]}」使用哪个模型，请前往「系统配置 → 默认模型分配」选择。`,
      "no_assignment",
      capability
    );
  }
  if (!provider.apiKey) {
    throw new ModelConfigError(
      `「${provider.label}」没有可用密钥，请前往「系统配置」重新填写 API Key。`,
      "invalid_key",
      capability
    );
  }

  return { ...provider, model: assignment.model };
}

/** 供「测试连接」「编辑表单」用：按行 id 取某个服务自己的凭据（不依赖能力分配）。 */
export async function resolveProviderConfig(
  userId: string,
  rowId: string
): Promise<(Omit<ResolvedModelConfig, "model"> & { model: string }) | null> {
  const config = await loadUserConfig(userId);
  const provider = config.providers.get(rowId);
  return provider ? { ...provider, model: "" } : null;
}

/** 长任务入口：一次性取全量配置，保证同一任务内配置一致（避免中途改配置导致半程换模型）。 */
export async function snapshotUserConfig(
  userId: string
): Promise<Record<Capability, ResolvedModelConfig | null>> {
  const config = await loadUserConfig(userId);
  const out = {} as Record<Capability, ResolvedModelConfig | null>;
  for (const capability of ALL_CAPABILITIES) {
    const assignment = config.assignments.get(capability);
    const provider = assignment ? config.providers.get(assignment.providerRowId) : undefined;
    out[capability] = provider && assignment ? { ...provider, model: assignment.model } : null;
  }
  return out;
}

/** 写入/删除配置后调用，立即让该用户的下一次解析看到新配置。 */
export function invalidateUserCache(userId: string): void {
  cache.delete(userId);
  inflight.delete(userId);
}

/** 把 ModelConfigError 转成可直接返回给前端的结构化响应体。 */
export function describeModelConfigError(error: unknown): {
  message: string;
  kind: string;
  capability: Capability | null;
} {
  if (error instanceof ModelConfigError) {
    return { message: error.message, kind: error.kind, capability: error.capability };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    kind: "unknown",
    capability: null
  };
}
