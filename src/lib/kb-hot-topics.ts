/**
 * 「今日产品热点」支持逻辑：
 * 1. 从 AI 返回的"今日全网热点"文本中解析出热点列表；
 * 2. 提取知识库中的产品关键词（高频 n-gram，过滤通用停用词）；
 * 3. 只有命中至少一个产品关键词的热点才进入候选，再按
 *    向量 + 关键词混合相似度排序，筛选出与产品知识相关的热点。
 */

import { prisma } from "./prisma";
import { cosineSimilarity, localEmbed } from "./kb-embed";
import { scoreChunks, type RetrievalChunkInput } from "./kb-retrieval";

const MAX_CANDIDATES = 6000;

/** 常用无实义汉字：出现在任意位置即不作为关键词 */
const STOP_CHARS = new Set(
  "的了和与是在有对上中为等之也及或并从到被将把这个那你们它们吧吗呢啊呀就都很更最又再还不没无会能可要想说去来用做得过地时分让按按照通过给向着于其每各自哪些因为所以但是然后如果虽然然而因此于是".split("")
);

/** 常见通用词（多出现在说明文本中，不具区分度） */
const STOP_WORDS = new Set([
  "可以", "我们", "你们", "自己", "这个", "那个", "内容", "相关", "进行", "需要",
  "或者", "以及", "一个", "一些", "以上", "如下", "以下", "对应", "建议", "注意",
  "方式", "方面", "情况", "问题", "时候", "目前", "当前", "同时", "另外", "此外",
  "支持", "提供", "选择", "包括", "如下表", "如下所示"
]);

export type KbContext = {
  candidates: RetrievalChunkInput[];
  kbNameMap: Map<string, string>;
  filenameMap: Map<string, string>;
  preferredModel: string;
  keywords: string[];
};

export type HotTopicMatch = {
  topic: string;
  score: number;
  keywords: string[];
  knowledgeBaseName: string;
  filename: string;
  snippet: string;
};

/** 加载当前用户全部知识库的可检索切片与产品关键词；没有可用切片时返回 null。 */
export async function loadUserKbContext(userId: string): Promise<KbContext | null> {
  const knowledgeBases = await prisma.knowledgeBase.findMany({
    where: { userId },
    select: { id: true, name: true, vectorModel: true }
  });
  if (knowledgeBases.length === 0) return null;

  const kbIds = knowledgeBases.map((kb) => kb.id);
  const [rows, docRows] = await Promise.all([
    prisma.kbChunk.findMany({
      where: { knowledgeBaseId: { in: kbIds }, enabled: true },
      orderBy: { createdAt: "asc" },
      take: MAX_CANDIDATES,
      select: { id: true, knowledgeBaseId: true, documentId: true, seq: true, content: true, embedding: true, charCount: true }
    }),
    prisma.kbDocument.findMany({
      where: { knowledgeBaseId: { in: kbIds } },
      select: { id: true, filename: true }
    })
  ]);
  if (rows.length === 0) return null;

  const models = new Set(knowledgeBases.map((kb) => kb.vectorModel));
  return {
    candidates: rows as RetrievalChunkInput[],
    kbNameMap: new Map(knowledgeBases.map((kb) => [kb.id, kb.name])),
    filenameMap: new Map(docRows.map((doc) => [doc.id, doc.filename])),
    preferredModel: models.size === 1 ? [...models][0] : "local-hash-256",
    keywords: extractKeywords(rows.map((row) => row.content))
  };
}

/**
 * 从知识库切片文本中提取产品关键词：
 * 统计 2~4 字 n-gram 频次，过滤停用字/停用词/符号/纯数字，取频次最高的前 60 个。
 */
export function extractKeywords(texts: string[], limit = 60): string[] {
  const freq = new Map<string, number>();
  const boundary = /[\s，。、；：！？（）()【】\[\]{}"'`~@#$%^&*=+\-_/\\|<>《》·—.,;:!?]/;

  for (const text of texts) {
    const clean = text.replace(/\s+/g, " ");
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= clean.length; i++) {
        const gram = clean.slice(i, i + n);
        if (boundary.test(gram)) continue;
        if (STOP_WORDS.has(gram)) continue;
        let invalid = false;
        for (const ch of gram) {
          if (STOP_CHARS.has(ch) || /[0-9a-zA-Z]/.test(ch)) {
            invalid = true;
            break;
          }
        }
        if (invalid) continue;
        freq.set(gram, (freq.get(gram) ?? 0) + 1);
      }
    }
  }

  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([gram]) => gram);
}

/** 从 AI 回复文本中解析热点条目（编号/项目符号/中文序号，与前端展示规则一致）。 */
export function parseTopicLines(content: string): string[] {
  const topics: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const topic = matchTopicLine(rawLine.trim());
    if (topic && !topics.includes(topic)) topics.push(topic);
  }
  return topics;
}

function matchTopicLine(line: string): string | null {
  const cleaned = line.replace(/^#{1,4}\s*/, "").replace(/^\*\*\s*/, "").trim();
  if (!cleaned) return null;

  let topic: string | null = null;
  const numbered = cleaned.match(/^\d{1,2}[.、．)）]\s*(.+)$/);
  const bullet = cleaned.match(/^[-*•]\s*(.+)$/);
  const chinese = cleaned.match(/^[一二三四五六七八九十]{1,3}[.、．]\s*(.+)$/);
  if (numbered) topic = numbered[1];
  else if (bullet) topic = bullet[1];
  else if (chinese) topic = chinese[1];
  if (!topic) return null;

  topic = topic
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[「」『』]/g, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  return topic.length >= 4 && topic.length <= 80 ? topic : null;
}

/**
 * 对每条热点做关键词门控 + 相似度打分。
 * 未命中关键词的热点也会打分（keywords 为空），仅供"暂未发现相关热点"时展示参考；
 * 结果按（命中关键词数、相关度）降序排列。
 */
export async function matchTopicsToKnowledge(topics: string[], ctx: KbContext): Promise<HotTopicMatch[]> {
  const results: HotTopicMatch[] = [];

  for (const topic of topics) {
    const hitKeywords = ctx.keywords.filter((keyword) => topic.includes(keyword)).slice(0, 6);
    const best = await bestMatchForTopic(topic, ctx);
    if (!best) continue;
    results.push({ topic, keywords: hitKeywords, ...best });
  }

  return results.sort((a, b) => b.keywords.length - a.keywords.length || b.score - a.score);
}

async function bestMatchForTopic(topic: string, ctx: KbContext): Promise<Omit<HotTopicMatch, "topic" | "keywords"> | null> {
  // 与检索测试一致：向量得分 70% + 本地哈希得分 30% 混合
  const { hits: vectorHits } = await scoreChunks(topic, ctx.candidates, ctx.preferredModel);
  const localQuery = localEmbed(topic);
  const localMap = new Map(
    ctx.candidates.map((chunk) => [chunk.id, cosineSimilarity(localQuery, localEmbed(chunk.content))])
  );

  let bestScore = 0;
  let bestChunk: RetrievalChunkInput | null = null;
  for (const hit of vectorHits) {
    const hybrid = hit.score * 0.7 + (localMap.get(hit.chunk.id) ?? 0) * 0.3;
    if (hybrid > bestScore) {
      bestScore = hybrid;
      bestChunk = hit.chunk;
    }
  }
  if (!bestChunk) return null;

  return {
    score: Number(bestScore.toFixed(4)),
    knowledgeBaseName: ctx.kbNameMap.get(bestChunk.knowledgeBaseId) ?? "未知知识库",
    filename: ctx.filenameMap.get(bestChunk.documentId) ?? "未知文档",
    snippet: bestChunk.content.replace(/\s+/g, " ").trim().slice(0, 80)
  };
}

/**
 * 最终筛选：
 * - 有关键词库时，只保留命中至少一个关键词的热点，取前 10 条；
 * - 无关键词库（退化模式）时，用相对门槛：不低于最高分的 50% 且不低于 0.08。
 */
export function filterRelevantTopics(matches: HotTopicMatch[], hasKeywords: boolean): HotTopicMatch[] {
  if (matches.length === 0) return [];
  const candidates = hasKeywords ? matches.filter((match) => match.keywords.length > 0) : matches;
  if (hasKeywords) return candidates.slice(0, 10);
  const topScore = Math.max(...matches.map((match) => match.score));
  const floor = Math.max(0.08, topScore * 0.5);
  return candidates.filter((match) => match.score >= floor).slice(0, 10);
}

/**
 * 针对多个查询，从用户知识库切片中检索相关片段并拼成参考文本，
 * 供「仿写爆款」等场景把产品知识与营销账号 IP 定位信息注入 prompt。
 * 与检索测试一致：依赖 scoreChunks（按 ctx.preferredModel 选择远端/本地向量）。
 */
export async function retrieveReferenceChunks(queries: string[], ctx: KbContext, topK = 6): Promise<string> {
  if (!ctx || ctx.candidates.length === 0) return "";
  const picked = new Map<string, RetrievalChunkInput>();
  for (const query of queries) {
    const { hits } = await scoreChunks(query, ctx.candidates, ctx.preferredModel);
    for (const hit of hits.slice(0, topK)) {
      picked.set(hit.chunk.id, hit.chunk);
    }
  }
  if (picked.size === 0) return "";
  return [...picked.values()]
    .map((chunk) => {
      const kb = ctx.kbNameMap.get(chunk.knowledgeBaseId) ?? "未知知识库";
      const fn = ctx.filenameMap.get(chunk.documentId) ?? "未知文档";
      const text = chunk.content.replace(/\s+/g, " ").trim();
      return `【知识库「${kb}」/ 文档「${fn}」】\n${text}`;
    })
    .join("\n\n");
}
