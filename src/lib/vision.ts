/**
 * 素材识图（千问 VL / 智谱 GLM-V，走 OpenAI 兼容端点）。
 *
 * 为什么要有这个模块：出片链路里「把对的图放在对的句子上」需要先知道每张图是什么，
 * 而原先规划层只拿到裸路径列表，AI 只能按顺序轮播 —— 图与旁白语义毫无关系。
 *
 * 设计约束：
 * - **永不抛错**。识图是增强项，任何失败（没配 key、超时、限流、返回不可解析）
 *   都必须静默降级，让出片链路退回「按顺序轮播」的旧行为。出片不能因为识图挂了而失败。
 * - **批量但受控**。N 张图并发打 VL 接口，同时用信号量限制并发，避免一次把配额打满。
 * - **结构化输出**。让模型返回 JSON，解析失败时退回纯文本描述（仍可用于语义匹配）。
 *
 * 与 vision.js 的关系：那是给人在命令行手动查看单张图的工具；这里是给程序用的批量版本。
 * 两者的 env 解析规则必须一致（后者覆盖前者），否则同一个 .env.local 会得出不同结果。
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { ModelConfigError, resolveCapabilityConfig } from "@/lib/model-credentials";

/** 识图结果。 */
export type ImageInsight = {
  /** 素材的绝对路径（原样回传，便于调用方对应）。 */
  path: string;
  /** 模型给出的内容描述。 */
  caption: string;
  /** 情绪/氛围关键词，如「温暖」「紧张」「宁静」。 */
  mood: string;
  /** 主体类别，如「人物」「风景」「产品」「文字截图」。 */
  subject: string;
  /** 推断的主色调（hex），用于自动选主题。 */
  dominantColor: string;
  /** 是否偏暗（暗调素材配深色主题更协调）。 */
  isDark: boolean;
};

export type VisionOptions = {
  /** 覆盖模型。 */
  model?: string;
  /** 覆盖端点。 */
  baseUrl?: string;
  /** 覆盖 key。 */
  apiKey?: string;
  /** 单张超时（毫秒）。 */
  timeoutMs?: number;
  /** 最大并发。 */
  concurrency?: number;
  /** 归属用户：缺省时从该用户的「识图」能力分配里解析凭据。 */
  userId?: string;
};

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_CONCURRENCY = 3;

/** 端点是否属于智谱（决定 key 用哪个，见 resolveApiKey 的说明）。 */
function isZhipuEndpoint(baseUrl: string): boolean {
  return /bigmodel\.cn/i.test(baseUrl);
}

/**
 * 解析识图凭据：只认当前用户自己在「系统配置」里配置的识图模型。
 *
 * 历史坑：.env.local 里 DASHSCOPE_API_KEY 定义了两次（一次空串、一次阿里云格式），
 * 而 DASHSCOPE_BASE_URL 指向智谱、VISION_MODEL 是 glm-4.6v。三者不匹配必然 401，
 * 且所有用户共用同一份 key。现在这两者都不再成立 —— key 与端点都来自用户配置。
 */
async function resolveVisionCredential(options: VisionOptions): Promise<{
  baseUrl: string;
  apiKey: string;
  model: string;
} | null> {
  if (options.apiKey && options.baseUrl) {
    return {
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model || "glm-4.6v"
    };
  }
  const userId = options.userId?.trim();
  if (!userId) return null;
  const config = await resolveCapabilityConfig(userId, "vision");
  return {
    baseUrl: options.baseUrl || config.baseUrl,
    apiKey: options.apiKey || config.apiKey,
    model: options.model || config.model
  };
}

/** 识图是否可用（缺配置时给出可读原因，指向系统配置）。 */
export async function visionStatus(options: VisionOptions = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (options.apiKey && options.model) return { ok: true };
  if (!options.userId?.trim()) {
    return { ok: false, reason: "缺少登录用户，无法确定该用哪个识图模型。" };
  }
  try {
    await resolveVisionCredential(options);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof ModelConfigError ? error.message : error instanceof Error ? error.message : "识图配置不可用"
    };
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** 读本地图片转 base64 data URL。非图片或读失败返回 null。 */
async function toDataUrl(absolutePath: string): Promise<string | null> {
  const mime = MIME_BY_EXT[extname(absolutePath).toLowerCase()];
  if (!mime) return null;
  try {
    const buf = await readFile(absolutePath);
    if (buf.length < 512) return null;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** 让模型输出结构化 JSON 的指令。字段与 ImageInsight 一一对应。 */
const INSIGHT_PROMPT = [
  "请分析这张图片，只输出一个 JSON 对象，不要任何其它文字、不要 markdown 围栏。",
  "JSON 字段：",
  '{',
  '  "caption": "一句话描述画面内容（20 字以内）",',
  '  "mood": "情绪氛围，2-4 个字，如 温暖/紧张/宁静/激昂/忧伤",',
  '  "subject": "主体类别，从 人物/风景/产品/食物/建筑/动物/文字截图/抽象/其它 中选一个",',
  '  "dominantColor": "画面主色调的 hex 值，如 #3b2f2a",',
  '  "isDark": true',
  "}",
  "要求：dominantColor 必须是真实存在于画面中的颜色，不要一律给白色或黑色。",
].join("\n");

/** 从模型输出里提取第一个完整的 JSON 对象；失败返回 null（调用方会退回纯文本）。 */
function extractJson(raw: string): Record<string, unknown> | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const brace = text.indexOf("{");
  if (brace < 0) return null;
  // 括号计数截取（跳过字符串字面量内的括号）
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = brace; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(brace, i + 1));
          return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 把模型输出收敛成 ImageInsight。字段缺失时给安全默认值，绝不让整批失败。 */
function toInsight(path: string, raw: string): ImageInsight | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  const json = extractJson(text);
  if (json) {
    const caption = typeof json.caption === "string" ? json.caption.trim() : "";
    const mood = typeof json.mood === "string" ? json.mood.trim() : "";
    const subject = typeof json.subject === "string" ? json.subject.trim() : "";
    const dominantColor =
      typeof json.dominantColor === "string" && /^#[0-9a-f]{3,8}$/i.test(json.dominantColor.trim())
        ? json.dominantColor.trim()
        : "#808080";
    return {
      path,
      caption: caption || text.slice(0, 40),
      mood: mood || "中性",
      subject: subject || "其它",
      dominantColor,
      isDark: json.isDark === true || luminance(dominantColor) < 110,
    };
  }

  // 退回：模型没按 JSON 输出时，把全文当 caption，其余字段给保守默认值。
  // 这仍然对「图文语义匹配」有用，只是拿不到色调。
  return {
    path,
    caption: text.slice(0, 40),
    mood: "中性",
    subject: "其它",
    dominantColor: "#808080",
    isDark: false,
  };
}

/** 感知亮度，用于 isDark 兜底判断。 */
function luminance(hex: string): number {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const n = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return 128;
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
}

/** 单张识图。失败返回 null。 */
async function insightOne(absolutePath: string, options: Required<Pick<VisionOptions, "model" | "baseUrl" | "apiKey" | "timeoutMs">>): Promise<ImageInsight | null> {
  const dataUrl = await toDataUrl(absolutePath);
  if (!dataUrl) return null;

  try {
    const res = await fetch(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataUrl } },
              { type: "text", text: INSIGHT_PROMPT },
            ],
          },
        ],
        stream: false,
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as
      | { choices?: { message?: { content?: string } }[] }
      | null;
    const content = json?.choices?.[0]?.message?.content;
    return typeof content === "string" ? toInsight(absolutePath, content) : null;
  } catch {
    return null;
  }
}

/** 极简信号量，避免一次把 VL 配额打满。 */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
  }
  release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}

/**
 * 批量识图。
 *
 * @param paths 图片绝对路径列表（非图片会被跳过）
 * @returns 与输入等长的结果数组；识别失败的项为 null，**不会**整体失败
 */
export async function insightImages(paths: string[], options: VisionOptions = {}): Promise<ImageInsight[]> {
  const emptyResult = paths.map((path) => ({
    path,
    caption: "",
    mood: "",
    subject: "",
    dominantColor: "",
    isDark: false
  }));
  if (paths.length === 0) return [];

  let credential: { baseUrl: string; apiKey: string; model: string } | null = null;
  try {
    credential = await resolveVisionCredential(options);
  } catch (error) {
    // 识图是增强项：未配置识图模型时静默降级为「按顺序轮播」，但把原因写进日志便于排查。
    console.warn(
      `[vision] 识图跳过：${error instanceof ModelConfigError ? error.message : error instanceof Error ? error.message : String(error)}`
    );
    return emptyResult;
  }
  if (!credential) return emptyResult;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const { baseUrl, apiKey, model } = credential;

  const gate = new Semaphore(concurrency);
  const settled = await Promise.all(
    paths.map(async (path) => {
      await gate.acquire();
      try {
        return await insightOne(path, { model, baseUrl, apiKey, timeoutMs });
      } finally {
        gate.release();
      }
    })
  );

  // 输入与输出一一对应；失败的项补一个空壳，调用方按 caption 是否为空判断是否可用
  return paths.map((path, i) => {
    return (
      settled[i] ?? { path, caption: "", mood: "", subject: "", dominantColor: "", isDark: false }
    );
  });
}

/**
 * 该批素材里成功识别的张数，用于诊断信息。
 *
 * 入参刻意放宽到「只要有 caption 字段即可」——调用方手里的可能是
 * ImageInsight、MaterialInsight 或别处的等价结构，不该为了统计一个数字
 * 就强迫它们互相转换。
 */
export function countInsights(insights: { caption: string }[]): number {
  return insights.filter((i) => Boolean(i.caption)).length;
}
