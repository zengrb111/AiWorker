/**
 * 旁白文案 + 标题生成（「一键生成视频」的自动配文）。
 *
 * 根据用户的整体创作要求生成：
 *   - title：视频标题（8~14 字，用于片头展示与内容库标题）
 *   - segments：口播旁白（用于 TTS 配音与逐句字幕）
 * 旁白长度由 targetSeconds（目标口播时长）决定——视频时长即由 TTS 旁白时长决定，
 * 因此必须让旁白长度服从创作要求中的时长目标，否则视频会比预期短。
 * 实测 GLM 单次生成倾向偏短，故在字数不足目标 85% 时自动扩充（最多 2 次）。
 * 失败返回 null，由上层降级（无旁白，仅画面）。
 *
 * ## 为什么接收 insights
 *
 * 早先这里只收 `imageCount`，于是旁白对「这些图到底是什么」一无所知，
 * 只能按创作要求凭空写 —— 结果常常是旁白讲的人和画面里拍的东西对不上。
 * 识图结果（caption/mood/subject）在 pipeline 里本来就已经拿到了，
 * 却没有一路传到这里，是「先理解素材再出方案」链路上最明显的一处断点。
 *
 * ## 模型来源（只用当前用户自己的）
 *
 * 走**当前用户**在「系统配置 → 模型配置」里为 chat 指定的服务。
 *
 * 这里曾经有一个「全局 env 智谱 GLM」兜底（`process.env.ZHIPU_API_KEY` 直连），
 * 2026-10-16 已移除。原因有两条：
 *  1. 违反按用户隔离 —— 用户没配也照样出片，平台替所有人付钱，调用记录还不归属任何人；
 *  2. 静默失败 —— 用户看到的只是「文案写得不好」，完全不知道是自己没配置。
 * 现在未配置会抛 `ModelConfigError`，由 API 层转成结构化错误码，前端给出跳转指引。
 *
 * 但**调用失败（限流 / 超时 / 上游 5xx）仍然降级为无旁白**，不阻断出片：
 * 那属于外部抖动，与「没配置」是两回事，不该让用户为一次抖动等重试。
 */
import { chatComplete } from "./llm-client";
import { ModelConfigError } from "./model-credentials";

export type NarrationScript = {
  /** 视频标题（8~14 字） */
  title: string;
  /** 整段旁白（用于 TTS） */
  fullText: string;
  /** 分句（用于参考/兜底字幕） */
  segments: string[];
};

/** 识图结果的最小形状（与 vision.ImageInsight 对齐，此处不依赖该模块避免循环引用）。 */
export type NarrationInsight = {
  caption?: string;
  mood?: string;
  subject?: string;
};

/**
 * 新闻事实的最小形状（与 web-search.SearchHit 对齐，同样不直接依赖以避免循环引用）。
 *
 * 为什么要单独传新闻，而不能只靠创作要求：
 * 创作要求是「怎么做」的指令（角度、节奏、风格），它**不含事实**。
 * 模型拿不到标题和摘要就只能编 —— 写出来的旁白听着通顺，但和文章对不上。
 */
export type NarrationNewsItem = {
  title?: string;
  snippet?: string;
  /**
   * 是否为「这条视频唯一要讲的新闻」。
   * 缺省时第一条视为主新闻（见 generateNarrationScript）。
   */
  isPrimary?: boolean;
};

/**
 * 内置公开热榜的「摘要」多数是占位串而不是真摘要（hot-boards.ts 里
 * `snippet: clean(row[snippetField]) || \`来自 ${origin} 热榜\``）。
 * 这类文本没有任何信息量，塞进 prompt 只会占位置并误导模型，识别到就丢掉。
 */
const PLACEHOLDER_SNIPPET = /^(来自\s*\S+\s*热榜|热榜|暂无摘要|-{2,})[\s。.]*$/;

/** 从模型返回文本里尽量解析出 { title, segments }。 */
function parseScript(content: string): { title: string; segments: string[] } {
  const cleaned = content.replace(/```json/gi, "").replace(/```/g, "").trim();
  let parsed: { title?: unknown; segments?: unknown } | null = null;
  try {
    parsed = JSON.parse(cleaned) as { title?: unknown; segments?: unknown };
  } catch {
    const m = cleaned.match(/\{[\s\S]*"segments"[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]) as { title?: unknown; segments?: unknown };
      } catch {
        parsed = null;
      }
    }
  }
  const segments = Array.isArray(parsed?.segments)
    ? (parsed!.segments as unknown[])
        .map((s) => String(s).replace(/["'“”‘’]/g, "").trim())
        .filter((s) => s.length > 0)
    : [];
  const title = typeof parsed?.title === "string" ? parsed.title.replace(/["'“”‘’]/g, "").trim() : "";
  return { title, segments };
}

/** 按句末标点拆分句子，用于字幕逐句显示。 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 去掉空白后的字数（中文口播字数估算用）。 */
function countChars(text: string): number {
  return text.replace(/\s/g, "").length;
}

/** 超长时按整句裁到 maxChars（保留句义完整，不硬切断句子）。 */
function trimToMaxChars(text: string, maxChars: number): string {
  const sentences = splitSentences(text);
  let out = "";
  for (const sentence of sentences) {
    const next = out + sentence;
    if (out && countChars(next) > maxChars) break;
    out = next;
  }
  return out.trim() || text;
}

/**
 * 调用模型一次，返回纯文本（失败返回 null）。
 *
 * 有 userId 时优先走用户自己的 chat 服务；没有配置或调用失败时回落全局 env 的智谱 GLM。
 * 两条路都失败才返回 null，由上层降级成「无旁白，仅画面」。
 */
/**
 * 调一次对话模型。
 *
 * 两类失败刻意区别对待：
 * - `ModelConfigError`（用户没配 chat 服务）→ **向上抛**，让上层给配置指引。
 *   不能吞：吞掉就退化成「无旁白纯画面」，用户看完片子也不知道是缺配置。
 * - 其它（限流 / 超时 / 上游 5xx / 余额不足）→ 返回 null 降级为无旁白。
 *   这类是外部抖动，阻断出片反而更糟。
 */
async function chatOnce(prompt: string, userId: string): Promise<string | null> {
  if (!userId) return null;
  try {
    const r = await chatComplete({
      userId,
      capability: "chat",
      prompt,
      temperature: 0.6,
      timeoutMs: 90_000,
    });
    return r.content.trim() || null;
  } catch (error) {
    if (error instanceof ModelConfigError) throw error;
    return null;
  }
}

/**
 * 旁白扩充：在保持主题与风格不变的前提下，把偏短的旁白自然扩充到目标字数。
 * 失败返回 null（调用方保留原文，不阻断）。
 */
async function expandNarrationScript(
  existing: string,
  requirement: string,
  targetChars: number,
  userId?: string
): Promise<string | null> {
  const prompt = [
    "下面是一条竖版短视频的口播旁白，请保持主题与温暖口语风格不变，把它自然扩充得更充实。",
    `【当前旁白】${existing}`,
    requirement?.trim() ? `【创作要求】${requirement.trim()}` : "",
    `请将旁白扩充到约 ${targetChars} 字（当前偏短，需要明显增加内容）。`,
    "要求：口语化、像真人对镜头说话；句内用逗号断出语气停顿；句子之间层层递进；",
    "不要开场套话、不要表情符号、不要括号说明、不要 markdown、不要任何解释。",
    "只输出扩充后的旁白正文。",
  ]
    .filter(Boolean)
    .join("\n");
  const text = await chatOnce(prompt, userId ?? "");
  if (!text) return null;
  // 去掉模型可能带的引号/围栏
  return text.replace(/```/g, "").replace(/^["“”]+|["“”]+$/g, "").trim();
}

/**
 * 生成标题 + 旁白文案。失败返回 null。
 *
 * targetSeconds：目标口播时长（秒）。默认 30s，封顶 40s（兼顾渲染耗时）。
 * 视频时长 = TTS 旁白时长，所以旁白字数必须服从该目标。
 *
 * insights：识图结果。给了就会写进 prompt —— 这让旁白能「看着素材说话」，
 * 而不是只知道「有 N 张图」。没有识图（未配 vision 模型）时行为与改造前一致。
 */
export async function generateNarrationScript(
  requirement: string,
  imageCount: number,
  targetSeconds = 30,
  insights: NarrationInsight[] = [],
  newsItems: NarrationNewsItem[] = [],
  userId?: string
): Promise<NarrationScript | null> {
  // 没传 userId 就没有「用户自己的 key」可用，放弃生成（上层降级为无旁白）。
  // 不再退回全局 env —— 见文件头「模型来源」。
  if (!userId) return null;

  // 目标时长（秒）→ 目标字数（中文口播约 4.5 字/秒）。封顶 60s、下限 8s。
  const safeTarget = Math.min(60, Math.max(8, Math.round(targetSeconds || 30)));
  const targetChars = Math.round(safeTarget * 4.5);

  // 有描述的图才写进 prompt：全空的 insight 列表等于没识别，传了反而误导模型。
  const described = insights.filter((i) => (i.caption ?? "").trim());
  const materialLines =
    described.length > 0
      ? described
          .slice(0, 12)
          .map(
            (i, k) =>
              `图${k + 1}：${(i.caption ?? "").trim()}` +
              `${i.mood ? `（氛围：${i.mood.trim()}）` : ""}` +
              `${i.subject ? `（主体：${i.subject.trim()}）` : ""}`,
          )
          .join("\n")
      : imageCount > 0
        ? `参考图共 ${imageCount} 张，画面围绕这些视觉素材展开。`
        : "";

  // 新闻事实：与图片一起构成「素材」。缺了它模型只能按创作要求凭空写，
  // 写出来的旁白和文章内容对不上 —— 这正是「针对性」要解决的问题。
  // snippet 可能是热榜的占位串（"来自 toutiao 热榜"），这类必须滤掉，
  // 否则等于把噪声当新闻塞给模型。
  //
  // 关键：**主新闻只有一条**。联网检索（尤其内置热榜）常常返回十几条彼此无关的
  // 新闻，早期版本把它们全写进 prompt，结果一条视频里讲了好几件不相干的事。
  // 现在只有 isPrimary 的那条是要写进文案的内容，其余仅作背景理解，
  // 并且 prompt 里明确禁止把它们的事件、人物、数字写进来。
  const usableNews = newsItems.filter((n) => (n.title ?? "").trim()).slice(0, 12);
  const formatNews = (n: NarrationNewsItem) => {
    const summary = (n.snippet ?? "").trim();
    const body = summary && !PLACEHOLDER_SNIPPET.test(summary) ? summary : "";
    return `${(n.title ?? "").trim()}${body ? ` —— ${body}` : ""}`;
  };
  const primaryNews = usableNews.find((n) => n.isPrimary) ?? usableNews[0];
  const backgroundNews = usableNews.filter((n) => n !== primaryNews).slice(0, 3);

  const newsBlock = primaryNews
    ? [
        "以下是这条视频**唯一要讲的新闻事实**（来自联网检索的真实报道）。",
        "硬性要求：",
        "- 标题和旁白都必须扣住这条新闻，不要出现任何其它新闻的事件、人物、数字或结论",
        "- **严禁编造**上面没有出现的人物、数字、时间、地点、结论",
        "- 信息不足时用「据报道」这类模糊表达，不要自己补细节",
        "",
        `【主新闻】${formatNews(primaryNews)}`,
        backgroundNews.length > 0
          ? `\n【仅供理解背景，禁止写入文案】\n${backgroundNews.map(formatNews).map((line) => `- ${line}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  // 总长度兜底，避免把写作要求挤出 prompt。
  const trimmedNews = newsBlock.length > 2600 ? newsBlock.slice(0, 2600) + "…" : newsBlock;

  const prompt = [
    "你是短视频文案专家。请为一条竖版短视频输出「标题 + 口播旁白」。",
    `创作主题 / 要求：${requirement?.trim() || "温暖治愈风格，主题由你根据常识合理设定"}`,
    trimmedNews,
    described.length > 0
      ? `以下是系统识别出的素材内容，旁白必须围绕这些画面展开，不要描述画面里没有的东西：\n${materialLines}`
      : materialLines,
    trimmedNews && described.length > 0
      ? "画面与新闻要互相印证：优先挑选那些**能对得上新闻内容**的画面来承担对应句子。"
      : "",
    "写作要求：",
    "- 标题：8~14 个字，有吸引力、能勾起共鸣，概括主题，不要引号和标点堆砌",
    // 旁白长度服从目标时长：这是视频时长的唯一决定因素，必须严格遵守。
    `- 旁白：口播总时长需约 ${safeTarget} 秒（约 ${targetChars} 字），据此自行决定句数；每句 8~16 个字，句数不设固定条数`,
    "- 像真人对着镜头说话，口语化、温暖自然，不要书面语和说教口吻",
    "- 句内用逗号断出自然的语气停顿（像说话时换气），句子短一点，避免长难句一气读完",
    "- 句子之间语义连贯、层层递进，念出来有呼吸感",
    "- 旁白不要开场套话（如「大家好」「欢迎收看」），不要表情符号、括号说明、镜头提示、markdown",
    "- 不要任何解释",
    '只输出 JSON：{"title":"视频标题","segments":["第一句","第二句",...]}',
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await chatOnce(prompt, userId ?? "");
  if (!raw) return null;
  const { title, segments } = parseScript(raw);
  if (!segments.length) return null;

  const punctuated = segments.map((s) => (/[。！？!?；;]$/.test(s) ? s : `${s}。`));
  const finalTitle = (title || punctuated[0] || "AI 回忆录").slice(0, 20);
  let fullText = punctuated.join("");

  // 目标字数区间：低于下限则扩充，高于上限则按整句裁剪，把时长控制在目标附近。
  const lowChars = Math.round(targetChars * 0.9);
  const highChars = Math.round(targetChars * 1.1);
  if (countChars(fullText) > highChars) fullText = trimToMaxChars(fullText, highChars);

  let expandRounds = 0;
  while (countChars(fullText) < lowChars && expandRounds < 2) {
    const expanded = await expandNarrationScript(fullText, requirement, targetChars, userId);
    if (!expanded) break;
    const sentences = splitSentences(expanded);
    if (sentences.length < 2) break; // 扩充结果异常，保留原文
    let candidate = sentences.join("");
    if (countChars(candidate) > highChars) candidate = trimToMaxChars(candidate, highChars);
    if (countChars(candidate) <= countChars(fullText)) break; // 扩充反而更短，停止
    fullText = candidate;
    expandRounds++;
  }

  return { title: finalTitle, fullText, segments: splitSentences(fullText) };
}

/* -------------------------------------------------------------------------- */
/* 文章转视频：直读原文生成旁白                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 原文送给模型的字符预算。
 *
 * 为什么是 9000 而不是全部塞进去：
 *   - 原文普遍 2~4 万字，全塞会让 prompt 极慢（且 reasoning 模型会烧掉大量预算做「思考」）；
 *   - 新闻/评测类文章的**导语与结尾**才是可播的信息，中段常是参数表与冗余描述。
 * 所以取「头 7000 + 尾 1500」，中间用显式省略号标记，让模型知道那里被截断了，
 * 而不是误以为文章就这么短。
 */
const ARTICLE_TEXT_BUDGET = 9000;

function clipArticleText(text: string, budget = ARTICLE_TEXT_BUDGET): string {
  const clean = (text ?? "").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= budget) return clean;
  const head = clean.slice(0, Math.round(budget * 0.78));
  const tail = clean.slice(-Math.round(budget * 0.22));
  return `${head}\n\n……（中间约 ${clean.length - budget} 字已省略）……\n\n${tail}`;
}

export type ArticleNarrationInput = {
  /** 文章正文原文（会被截断到预算内）。 */
  articleText: string;
  title: string;
  summary: string;
  keyPoints: string[];
  /** 已核实的数据图表的人话描述，用于让旁白念到对应数字。 */
  chartLines: string[];
  targetSeconds: number;
  /** 用户的额外创作要求（可空）。 */
  requirement?: string;
  userId?: string;
};

/**
 * 直接读**文章原文**生成标题 + 旁白。
 *
 * ## 为什么必须有这个函数（而不是复用 generateNarrationScript）
 *
 * 原来的链路是三段接力：
 *   文章 → analyze(LLM#1) → requirement 文本 → narration(LLM#2) → DSH 分镜(LLM#3)
 * 旁白那一步只看得见 requirement 里的「标题 + 80 字摘要 + 若干要点」，
 * 于是它写出来的东西本质上是**对摘要的再创作**，措辞容易飘、
 * 细节会丢、还会把文章里明确说了的限定条件说满。这正是「对文章理解不精准」的来源。
 *
 * 现在把原文直接交给旁白那一步：它读的是一手材料，文章说了什么它就讲什么。
 * 摘要与要点仍作为「结构提示」一并给出（帮它快速定位重点段落），但不再是唯一信息源。
 *
 * 失败返回 null，由上层退回 generateNarrationScript（行为与改造前一致，不会让出片失败）。
 */
export async function generateArticleNarration(
  input: ArticleNarrationInput
): Promise<NarrationScript | null> {
  if (!input.userId) return null;

  const safeTarget = Math.min(60, Math.max(8, Math.round(input.targetSeconds || 30)));
  const targetChars = Math.round(safeTarget * 4.5);

  const chartBlock = input.chartLines.filter(Boolean).length
    ? [
        "以下是文章中已核实的数据图表（这些数字都可以放心照着念，但不要复述图表标题）：",
        ...input.chartLines.map((line, i) => `图${i + 1}：${line}`),
      ].join("\n")
    : "";

  const prompt = [
    "你是短视频文案专家。下面给你一篇**完整原文**，请直接读原文写出一条竖版短视频的「标题 + 口播旁白」。",
    "",
    `【文章标题】${input.title}`,
    input.summary ? `【内容摘要】${input.summary}` : "",
    input.keyPoints.length
      ? `【文章要点】\n${input.keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
      : "",
    chartBlock,
    "",
    "【文章原文】",
    clipArticleText(input.articleText),
    "",
    "写作要求：",
    "1. **以原文为唯一依据**：只讲原文里真实出现的人名、数字、型号、价格、时间与结论。",
    "   原文没写的数字绝对不许出现，也不许根据常识补全或推算。",
    "2. 原文里的限定语（「约」「最高」「起」「部分」「截至」等）要跟着念出来，不要说成绝对值。",
    "3. 挑最有信息量的 2~3 个点展开，不要面面俱到地复述全文；",
    "   有数据的地方优先讲数据，因为画面上会同步出现图表。",
    `4. 旁白口播总时长约 ${safeTarget} 秒（约 ${targetChars} 字）；每句 8~18 个字，句数不设固定条数。`,
    "5. 句内用逗号断出语气停顿，句子短一点，念出来有呼吸感。",
    "6. 像真人讲给朋友听，口语化；不要开场套话（「大家好」「欢迎收看」）、不要表情符号、",
    "   不要括号说明、不要镜头提示、不要 markdown、不要任何解释。",
    input.requirement?.trim() ? `\n【用户的额外要求】\n${input.requirement.trim()}` : "",
    "",
    '只输出 JSON：{"title":"视频标题","segments":["第一句","第二句",...]}',
  ]
    .filter((line) => line !== "")
    .join("\n");

  const raw = await chatOnce(prompt, input.userId);
  if (!raw) return null;
  const { title, segments } = parseScript(raw);
  if (!segments.length) return null;

  const punctuated = segments.map((s) => (/[。！？!?；;]$/.test(s) ? s : `${s}。`));
  const finalTitle = (title || input.title || punctuated[0] || "文章解读").slice(0, 20);
  let fullText = punctuated.join("");

  // 字数控制与扩充：和 generateNarrationScript 同一套逻辑（目标 ±10%）。
  // 这里不能省 —— 旁白长度直接决定 TTS 时长，也直接决定成片长度。
  const lowChars = Math.round(targetChars * 0.9);
  const highChars = Math.round(targetChars * 1.1);
  if (countChars(fullText) > highChars) fullText = trimToMaxChars(fullText, highChars);

  let expandRounds = 0;
  while (countChars(fullText) < lowChars && expandRounds < 2) {
    const expanded = await expandNarrationScript(
      fullText,
      `基于原文讲解「${input.title}」，保持事实与口语风格不变`,
      targetChars,
      input.userId
    );
    if (!expanded) break;
    const sentences = splitSentences(expanded);
    if (sentences.length < 2) break;
    let candidate = sentences.join("");
    if (countChars(candidate) > highChars) candidate = trimToMaxChars(candidate, highChars);
    if (countChars(candidate) <= countChars(fullText)) break;
    fullText = candidate;
    expandRounds++;
  }

  return { title: finalTitle, fullText, segments: splitSentences(fullText) };
}