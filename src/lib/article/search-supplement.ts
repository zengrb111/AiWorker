/**
 * 按需联网补充数据。
 *
 * 触发条件很窄：**文章缺数据**（analysis.dataGaps 非空）**且**用户勾选了允许联网。
 * 全流程硬约束是「最多 1 次搜索 + 1 次抽取」—— 不按图表数量循环搜，否则规划阶段
 * 会从 1 分钟膨胀到 5 分钟，用户直接放弃。
 *
 * 联网失败**绝不静默**：searchWeb 抛 SearchError 时把原因回传，由方案面板如实展示
 * 「联网补充没生效」。静默失败会让用户以为图上的数据是搜来的，实际并没有。
 */
import { chatComplete } from "../llm-client";
import type { ResolvedModelConfig } from "../model-credentials";
import { searchWeb, type SearchError, type SearchHit } from "../web-search";
import { extractJsonObject, type DataPoint, type SearchEvidence } from "./analyze";

const SEARCH_TOP_K = 6;

export type SearchSupplementResult =
  | {
      ok: true;
      /** 本次搜索命中的结果，同时作为溯源校验的证据集。 */
      evidence: SearchEvidence;
      /** 从搜索结果里抽到的、带 sourceUrl 的新数据点（尚未校验，需过 verifyChartSpecs）。 */
      dataPoints: DataPoint[];
      query: string;
      /** 抽取环节的告警（搜索本身成功了，但没有抽到可用数据）。 */
      reason?: string;
    }
  | { ok: false; reason: string };

const EXTRACT_PROMPT = `你从搜索结果摘要里抽取可用的数值事实。只输出 JSON。

铁律：
1. 只用摘要里**真实出现**的数字，不许推算、不许补充常识。
2. 每条数据的 sourceQuote 必须是从该条摘要里一字不改复制下来的连续片段（8~60 字，包含数字本身）。
3. sourceUrl 必须原样等于所属摘要的 url 字段，不许改写。
4. 摘要里没有合适数字就返回空数组，不要为了凑数编造。

输入（JSON）：
%INPUT%

输出格式（严格 JSON，不要 markdown 围栏）：
{"dataPoints":[{"value":0,"unit":"","label":"","sourceQuote":"","sourceUrl":""}]}`;

/** 把多个数据缺口压成一条查询，避免多次搜索。 */
export function buildSearchQuery(gaps: string[], topic: string): string {
  const cleaned = gaps.map((gap) => gap.trim()).filter(Boolean).slice(0, 4);
  const tail = cleaned.join("；");
  return [topic, tail].filter(Boolean).join(" ").slice(0, 200);
}

export async function supplementFromSearch(input: {
  userId: string;
  config: ResolvedModelConfig;
  topic: string;
  gaps: string[];
  /** 本次已经拿到的数据点数量上限，防止搜索结果把图表撑爆。 */
  limit?: number;
}): Promise<SearchSupplementResult> {
  const query = buildSearchQuery(input.gaps, input.topic);
  if (!query.trim()) return { ok: false, reason: "没有需要联网补充的数据点。" };

  let hits: SearchHit[];
  try {
    hits = await searchWeb({
      userId: input.userId,
      query,
      topK: SEARCH_TOP_K,
      config: input.config,
    });
  } catch (error) {
    const kind = (error as SearchError)?.kind ? `（${(error as SearchError).kind}）` : "";
    return { ok: false, reason: `联网搜索失败${kind}：${error instanceof Error ? error.message : "未知错误"}` };
  }

  if (!hits.length) return { ok: false, reason: "联网搜索没有返回任何结果。" };

  const evidence: SearchEvidence = hits.map((hit) => ({ url: hit.url, snippet: hit.snippet }));
  const limited = evidence.slice(0, 4);
  const limit = input.limit ?? 4;

  try {
    const result = await chatComplete({
      userId: input.userId,
      capability: "chat",
      config: input.config,
      prompt: EXTRACT_PROMPT.replace("%INPUT%", JSON.stringify(limited)),
      temperature: 0.1,
      // 同 analyze：reasoning 模型的思考会吃掉大部分输出预算，给低了正文会为空。
      maxTokens: 16_000,
      timeoutMs: 150_000,
    });

    const parsed = extractJsonObject(result.content);
    const record = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    const dataPoints: DataPoint[] = [];
    const known = new Set<string>();

    for (const item of Array.isArray(record.dataPoints) ? record.dataPoints : []) {
      if (dataPoints.length >= limit) break;
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const value = typeof entry.value === "number" ? entry.value : Number(entry.value);
      const sourceQuote = typeof entry.sourceQuote === "string" ? entry.sourceQuote.trim() : "";
      const sourceUrl = typeof entry.sourceUrl === "string" ? entry.sourceUrl.trim() : "";
      if (!Number.isFinite(value) || sourceQuote.length < 4 || !sourceUrl) continue;
      const key = `${sourceUrl}|${sourceQuote}`;
      if (known.has(key)) continue;
      known.add(key);
      dataPoints.push({
        id: `s${dataPoints.length + 1}`,
        value,
        unit: typeof entry.unit === "string" ? entry.unit.trim().slice(0, 12) : "",
        label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, 16) : "搜索数据",
        sourceQuote: sourceQuote.slice(0, 120),
        sourceKind: "search",
        sourceUrl,
      });
    }

    return { ok: true, evidence, dataPoints, query };
  } catch (error) {
    // 抽取失败不影响已抓到的搜索结果本身，只是没有新增数据点。
    return {
      ok: true,
      evidence,
      dataPoints: [],
      query,
      reason: `从搜索结果抽取数据失败：${error instanceof Error ? error.message : "未知错误"}`,
    };
  }
}