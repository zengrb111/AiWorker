/**
 * 旁白文案 + 标题生成（「一键生成视频」的自动配文）。
 *
 * 用智谱 GLM 对话模型，根据用户的整体创作要求生成：
 *   - title：视频标题（8~14 字，用于片头展示与内容库标题）
 *   - segments：口播旁白（用于 TTS 配音与逐句字幕）
 * 旁白长度由 targetSeconds（目标口播时长）决定——视频时长即由 TTS 旁白时长决定，
 * 因此必须让旁白长度服从创作要求中的时长目标，否则视频会比预期短。
 * 实测 GLM 单次生成倾向偏短，故在字数不足目标 85% 时自动扩充（最多 2 次）。
 * 模型可用环境变量覆盖：NARRATION_MODEL（默认 glm-4-flash）。
 * 失败返回 null，由上层降级（无旁白，仅画面）。
 */

const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY ?? "";
const ZHIPU_CHAT_API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const NARRATION_MODEL = process.env.NARRATION_MODEL ?? "glm-4-flash";

export type NarrationScript = {
  /** 视频标题（8~14 字） */
  title: string;
  /** 整段旁白（用于 TTS） */
  fullText: string;
  /** 分句（用于参考/兜底字幕） */
  segments: string[];
};

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

/** 调用智谱 GLM 对话，返回纯文本（失败返回 null）。 */
async function chatOnce(prompt: string): Promise<string | null> {
  try {
    const res = await fetch(ZHIPU_CHAT_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ZHIPU_API_KEY}` },
      body: JSON.stringify({
        model: NARRATION_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.6,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return (json.choices?.[0]?.message?.content ?? "").trim() || null;
  } catch {
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
  targetChars: number
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
  const text = await chatOnce(prompt);
  if (!text) return null;
  // 去掉模型可能带的引号/围栏
  return text.replace(/```/g, "").replace(/^["“”]+|["“”]+$/g, "").trim();
}

/**
 * 生成标题 + 旁白文案。失败返回 null。
 *
 * targetSeconds：目标口播时长（秒）。默认 30s，封顶 45s（兼顾渲染耗时）。
 * 视频时长 = TTS 旁白时长，所以旁白字数必须服从该目标。
 */
export async function generateNarrationScript(
  requirement: string,
  imageCount: number,
  targetSeconds = 30
): Promise<NarrationScript | null> {
  if (!ZHIPU_API_KEY) return null;

  // 目标时长（秒）→ 目标字数（中文口播约 4.5 字/秒）。封顶 45s、下限 8s。
  const safeTarget = Math.min(45, Math.max(8, Math.round(targetSeconds || 30)));
  const targetChars = Math.round(safeTarget * 4.5);

  const prompt = [
    "你是短视频文案专家。请为一条竖版短视频输出「标题 + 口播旁白」。",
    `创作主题 / 要求：${requirement?.trim() || "温暖治愈风格，主题由你根据常识合理设定"}`,
    imageCount > 0 ? `参考图共 ${imageCount} 张，画面围绕这些视觉素材展开。` : "",
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

  const raw = await chatOnce(prompt);
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
    const expanded = await expandNarrationScript(fullText, requirement, targetChars);
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