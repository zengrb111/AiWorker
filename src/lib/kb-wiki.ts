/**
 * Wiki 知识库：从图文文档里提炼「知识点 + 讲解」。
 *
 * 与 RAG 的分工：
 * - RAG 关心「原文怎么切、怎么检索」，切片是给模型看的原料，人不需要读；
 * - WIKI 关心「这篇东西讲了哪几个点、每个点怎么讲给人听」，产物是**人可读的知识点**，
 *   每个知识点可以直接转成一条讲解视频。
 *
 * 所以这里不做切片、不做向量，只做一件事：把长文喂给模型，要一份结构化知识点。
 */
import { prisma } from "@/lib/prisma";
import { chatComplete } from "@/lib/llm-client";
import { extractDocumentText } from "@/lib/kb-extract";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** 单次喂给模型的字数上限。超过就分段提炼，避免「一次要太多」被输出长度卡死。 */
const MAX_INPUT_CHARS = 7000;
/** 两段之间的重叠字数：知识点常常跨段，完全不重叠会漏掉被切断的那条。 */
const SEGMENT_OVERLAP = 400;
/** 一个文档最多要几个知识点：太少说明没拆开，太多说明拆碎了。 */
const MAX_POINTS = 8;
/** 整篇合并后的知识点上限（分段时每段都会产出，合计可能超出）。 */
const MAX_TOTAL_POINTS = 14;

/**
 * 单次调用的输出预算。
 *
 * 3000 会出事：8 条 × 300 字中文 ≈ 4800 token，模型写到一半就被 max_tokens 截断，
 * finish_reason=length、正文为空，用户看到的是「输出被长度上限截断」。
 * DeepSeek chat 的上限是 8192，取 8000 留点余量。
 */
const MAX_OUTPUT_TOKENS = 8000;
/** 第一次失败后的降级：更少的条数 + 更短的讲解，确保一定能出东西。 */
const FALLBACK_MAX_POINTS = 4;
const FALLBACK_DETAIL = "120~200 字";

export type ExtractedPoint = {
  title: string;
  explanation: string;
  sourceExcerpt: string;
  videoSeconds: number | null;
};

/** 从模型回复里抠出 JSON 数组：容忍 ```json 包裹、前后有解释文字。 */
export function parsePointsPayload(raw: string): ExtractedPoint[] {
  const text = (raw || "").trim();
  if (!text) return [];

  let candidate = text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1];

  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  candidate = candidate.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item) => {
      const row = item as Record<string, unknown>;
      const title = String(row.title ?? "").trim();
      const explanation = String(row.explanation ?? "").trim();
      if (!title || !explanation) return null;
      const secondsRaw = Number(row.videoSeconds);
      const videoSeconds = Number.isFinite(secondsRaw)
        ? Math.min(90, Math.max(10, Math.round(secondsRaw)))
        : null;
      return {
        title: title.slice(0, 60),
        explanation: explanation.slice(0, 2000),
        sourceExcerpt: String(row.sourceExcerpt ?? "").trim().slice(0, 600),
        videoSeconds
      } satisfies ExtractedPoint;
    })
    .filter((item): item is ExtractedPoint => Boolean(item))
    .slice(0, MAX_POINTS);
}

type PromptOptions = {
  /** 这段文本最多要几个知识点 */
  maxPoints: number;
  /** explanation 的字数要求，如 "200~400 字" */
  detail: string;
  /** 这段是不是整篇中的一段（影响措辞） */
  partLabel?: string;
};

function buildPrompt(filename: string, body: string, options: PromptOptions): string {
  return [
    "你是一个知识提炼助手。下面是一篇文档的正文（可能混有从图片里 OCR 出来的文字，语句不一定通顺）。",
    options.partLabel
      ? `这是长文档的${options.partLabel}，只提炼这一段里讲到的内容，不要脑补上下文。`
      : "",
    "请把它拆成若干个「知识点」：每个知识点是一个能独立讲清楚的完整概念、方法或结论。",
    "",
    "要求：",
    `1. 提炼 2~${options.maxPoints} 个知识点。太少说明没拆开，太多说明拆碎了；这段内容不足就只给 1 个。`,
    "2. 每个知识点给出四个字段：",
    "   - title：不超过 20 字的名词短语，能一眼看出讲什么；",
    `   - explanation：${options.detail}口语化讲解，像面对面跟人说话。不要「首先/其次/综上所述」这类书面连接词，`,
    "     不要出现「本文」「文章」「作者」这类指代，直接讲内容本身；",
    "   - sourceExcerpt：原文里最能支撑这个知识点的 1~2 句，原样摘录，不要改写；",
    `   - videoSeconds：这个知识点做成讲解视频的合适时长，${10}~${90} 的整数秒。`,
    "3. 只输出 JSON 数组，不要任何解释文字，不要 markdown 代码块。",
    "4. 文字里引用别人的说法、口头禅、设问句时，一律用中文引号「」，不要用英文单引号。",
    "",
    "格式示例：",
    '[{"title":"什么是RAG","explanation":"……","sourceExcerpt":"……","videoSeconds":30}]',
    "",
    `文档名：${filename}`,
    "正文：",
    body
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * 按段落切成若干段，每段不超过 MAX_INPUT_CHARS，段间留 SEGMENT_OVERLAP 字重叠。
 *
 * 为什么按段落切而不是硬切：硬切会把一句话劈成两半，模型读到的第一句就是残缺的。
 */
export function splitIntoSegments(text: string): string[] {
  const source = text.trim();
  if (source.length <= MAX_INPUT_CHARS) return [source];

  const paragraphs = source.split(/\n{2,}/);
  const segments: string[] = [];
  let current = "";

  const push = () => {
    if (current.trim()) segments.push(current.trim());
    // 下一段带上尾部内容，保证跨段的知识点不至于被切断
    current = current.length > SEGMENT_OVERLAP ? current.slice(-SEGMENT_OVERLAP) : "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_INPUT_CHARS) {
      // 单个段落就超长（比如一整页 OCR 文本没有空行）：按句号硬切
      const sentences = paragraph.split(/(?<=[。！？；\n])/);
      for (const sentence of sentences) {
        if (current.length + sentence.length > MAX_INPUT_CHARS) push();
        current += sentence;
      }
      continue;
    }
    if (current.length + paragraph.length > MAX_INPUT_CHARS) push();
    current += `${paragraph}\n\n`;
  }
  if (current.trim()) segments.push(current.trim());

  return segments.length ? segments : [source.slice(0, MAX_INPUT_CHARS)];
}

/** 调一次模型拿知识点；失败（截断 / 空返回）由调用方决定要不要降级。 */
async function requestPoints(
  userId: string,
  filename: string,
  body: string,
  options: PromptOptions
): Promise<ExtractedPoint[]> {
  const call = async (maxTokens: number) => {
    const result = await chatComplete({
      userId,
      capability: "chat",
      prompt: buildPrompt(filename, body, options),
      temperature: 0.3,
      maxTokens,
      timeoutMs: 180_000
    });
    return parsePointsPayload(result.content);
  };

  try {
    return await call(MAX_OUTPUT_TOKENS);
  } catch (error) {
    // 有些模型/网关硬上限小于 8000，会直接 400。这种错重试大值没用，
    // 换成 3500 再试一次；仍然失败就交给调用方降级。
    const kind = (error as { kind?: string } | null)?.kind;
    if (kind !== "bad_request") throw error;
    return call(3500);
  }
}

/**
 * 提炼一篇文档的知识点，并替换该文档原有的知识点。
 *
 * 三层兜底，目标只有一个：**别让用户看到「输出被截断」**。
 *   1. 长文档分段，每段单独提炼（单次输出量可控）；
 *   2. 某段失败自动降级重试（条数减半、讲解压短）；
 *   3. 整篇一条都没出来，再兜底请求一次「只给 1~2 条」。
 *
 * 替换而非追加：同一篇文档重新解析时，旧知识点就是过期的，
 * 留着会让列表里出现两份相似条目，用户分不清哪份是新的。
 */
export async function extractPointsFromDocument(input: {
  userId: string;
  knowledgeBaseId: string;
  documentId: string;
}): Promise<{ points: ExtractedPoint[]; note: string }> {
  const doc = await prisma.kbDocument.findFirst({
    where: { id: input.documentId, knowledgeBaseId: input.knowledgeBaseId }
  });
  if (!doc) throw new Error("文档不存在。");

  // 没解析过的文档先解析：用户上传完直接点「提炼知识点」是正常操作。
  let text = (doc.extractedText || "").trim();
  if (!text) {
    if (!doc.storedPath) throw new Error("这个文档没有保留源文件，无法重新解析。");
    const buffer = await readFile(path.join(process.cwd(), doc.storedPath));
    const result = await extractDocumentText(buffer, doc.filename);
    text = (result.text || "").trim();
    if (!text) {
      throw new Error(result.note || "这个文档没有提取到文字，无法提炼知识点。");
    }
    await prisma.kbDocument.update({
      where: { id: doc.id },
      data: { extractedText: text, parseStatus: result.status, parseNote: result.note }
    });
  }

  const segments = splitIntoSegments(text);
  const collected: ExtractedPoint[] = [];
  const failures: string[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const partLabel =
      segments.length > 1 ? `第 ${index + 1}/${segments.length} 段` : undefined;

    let points: ExtractedPoint[] = [];
    try {
      points = await requestPoints(input.userId, doc.filename, segment, {
        maxPoints: MAX_POINTS,
        detail: "200~400 字",
        partLabel
      });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }

    // 第一次没出东西就降级：条数减半、讲解压短，输出量直接砍掉一半以上。
    if (!points.length) {
      try {
        points = await requestPoints(input.userId, doc.filename, segment, {
          maxPoints: FALLBACK_MAX_POINTS,
          detail: FALLBACK_DETAIL,
          partLabel
        });
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    collected.push(...points);
    if (collected.length >= MAX_TOTAL_POINTS) break;
  }

  // 整篇还是空的：最后再搏一次，只要 1~2 条，几乎不可能再被截断。
  if (!collected.length) {
    try {
      const rescue = await requestPoints(input.userId, doc.filename, text.slice(0, 3000), {
        maxPoints: 2,
        detail: "100~150 字"
      });
      collected.push(...rescue);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  // 分段重叠会让相邻段提炼出同一条，按标题去重。
  const seen = new Set<string>();
  const points = collected
    .filter((point) => {
      const key = point.title.replace(/\s+/g, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_TOTAL_POINTS);

  if (!points.length) {
    // 具体原因只进服务端日志：用户看到「输出被长度上限截断」「reasoning 预算」
    // 这类话没有任何可操作性，只会以为功能坏了。
    console.warn(`[kb-wiki] 《${doc.filename}》提炼失败：`, failures);
    throw new Error(
      "这篇文档没能提炼出知识点。可以试试：把文档拆成小一点的几篇再上传，或者换一篇正文更完整的文档。"
    );
  }

  await prisma.$transaction([
    prisma.kbKnowledgePoint.deleteMany({ where: { documentId: doc.id } }),
    prisma.kbKnowledgePoint.createMany({
      data: points.map((point, index) => ({
        knowledgeBaseId: input.knowledgeBaseId,
        documentId: doc.id,
        seq: index,
        title: point.title,
        explanation: point.explanation,
        sourceExcerpt: point.sourceExcerpt,
        videoSeconds: point.videoSeconds
      }))
    })
  ]);

  await prisma.knowledgeBase.update({
    where: { id: input.knowledgeBaseId },
    data: { status: "READY" }
  });

  return {
    points,
    note: `《${doc.filename}》提炼出 ${points.length} 个知识点${segments.length > 1 ? `（分 ${segments.length} 段处理）` : ""}。`
  };
}

/* --------------------------- 知识点 → 视频脚本 --------------------------- */

export type StoryboardShot = {
  seconds: number;
  /** 画面描述（可执行的具体画面，不是"展示相关内容"这种空话） */
  visual: string;
  /** 口播念白 */
  narration: string;
};

/** 从模型回复里抠出分镜数组。 */
export function parseStoryboardPayload(raw: string): StoryboardShot[] {
  const text = (raw || "").trim();
  if (!text) return [];

  let candidate = text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1];
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item) => {
      const row = item as Record<string, unknown>;
      const visual = String(row.visual ?? "").trim();
      const narration = String(row.narration ?? "").trim();
      if (!visual && !narration) return null;
      const secondsRaw = Number(row.seconds);
      return {
        seconds: Number.isFinite(secondsRaw) ? Math.min(30, Math.max(2, Math.round(secondsRaw))) : 5,
        visual: visual.slice(0, 300),
        narration: narration.slice(0, 400)
      } satisfies StoryboardShot;
    })
    .filter((item): item is StoryboardShot => Boolean(item))
    .slice(0, 6);
}

/** 把分镜排成「标题 + 分镜脚本」的创作需求文本（这就是「一键生成视频」预填的内容）。 */
export function formatVideoRequirement(
  title: string,
  shots: StoryboardShot[],
  totalSeconds: number
): string {
  const lines: string[] = [title.trim(), ""];
  let cursor = 0;
  shots.forEach((shot, index) => {
    const from = cursor;
    const to = Math.min(totalSeconds, cursor + shot.seconds);
    cursor = to;
    lines.push(`镜头 ${index + 1}（${from}-${to}s）`);
    if (shot.visual) lines.push(`画面：${shot.visual}`);
    if (shot.narration) lines.push(`口播：${shot.narration}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

/**
 * 知识点 → 视频创作需求。
 *
 * 为什么在点击时现场生成、而不是提炼知识点时就存下来：
 * 用户几乎总会改讲解稿，存下来的分镜立刻过期；现场生成才和当前讲解一致。
 * 代价是点按钮要等 10 秒左右，前端用「正在生成分镜…」兜住。
 */
export async function buildVideoRequirement(input: {
  userId: string;
  title: string;
  explanation: string;
  videoSeconds: number | null;
}): Promise<string> {
  const total = Math.min(90, Math.max(10, input.videoSeconds ?? 30));
  const explanation = (input.explanation || "").trim();
  if (!explanation) throw new Error("这个知识点还没有讲解内容，先补充讲解再生成视频。");

  const prompt = [
    "把下面这个知识点改写成一条竖版知识讲解视频的分镜脚本。",
    "",
    `知识点标题：${input.title}`,
    `目标时长：${total} 秒`,
    "讲解内容：",
    explanation,
    "",
    "要求：",
    "1. 拆成 3~5 个镜头，镜头时长相加接近目标时长。",
    "2. 每个镜头给两个字段：visual（画面描述，写具体能看到的东西：物件、动作、字幕位置、镜头运动；",
    "   不要写「展示相关内容」「配合讲解出现画面」这类空话）、narration（口播念白，口语，一句话一个意思）。",
    "3. 口播合起来要覆盖讲解的核心信息，结论不能漏。",
    "4. 第一个镜头的画面要能抓住人，不要用「大家好」开场。",
    "5. 只输出 JSON 数组，不要解释文字，不要 markdown 代码块。",
    "6. 引用说法、口头禅、设问句时用中文引号「」，不要用英文单引号。",
    "",
    "格式示例：",
    '[{"seconds":7,"visual":"一只缺口的搪瓷缸特写，镜头缓慢推近","narration":"别一上来就问最难忘的事，老人接不住。"}]'
  ].join("\n");

  /**
   * 输出预算要够：5 个镜头 × (画面 100 字 + 口播 80 字) + JSON 结构 ≈ 2000+ token，
   * 给 2000 会在最后一个镜头被截断 → 整个 JSON 解析失败 → 用户点按钮只看到报错。
   */
  const ask = async (maxTokens: number, shots: string) =>
    chatComplete({
      userId: input.userId,
      capability: "chat",
      prompt: shots ? `${prompt}\n\n补充：镜头数控制在 ${shots}。` : prompt,
      temperature: 0.6,
      maxTokens,
      timeoutMs: 120_000
    });

  let shots = parseStoryboardPayload((await ask(8000, "")).content);
  if (!shots.length) {
    // 极少数模型会把预算花在思考上；压到 3 个镜头再要一次，输出量直接减半。
    shots = parseStoryboardPayload((await ask(8000, "3 个")).content);
  }

  if (!shots.length) {
    // 还不给就退化成「整段讲解当一个镜头」——
    // 用户拿到的仍然是一个能直接用的创作需求，不会卡在报错上。
    return formatVideoRequirement(
      input.title,
      [{ seconds: total, visual: "围绕知识点主题的简洁图形化画面，关键句大字幕", narration: explanation }],
      total
    );
  }
  return formatVideoRequirement(input.title, shots, total);
}
