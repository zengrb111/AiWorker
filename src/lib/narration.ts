/**
 * 旁白文案 + 标题生成（「一键生成视频」的自动配文）。
 *
 * 用智谱 GLM 对话模型，根据用户的整体创作要求生成：
 *   - title：视频标题（8~14 字，用于片头展示与内容库标题）
 *   - segments：4~6 句口播旁白（用于 TTS 配音与逐句字幕）
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

/**
 * 生成标题 + 旁白文案。失败返回 null。
 */
export async function generateNarrationScript(
  requirement: string,
  imageCount: number
): Promise<NarrationScript | null> {
  if (!ZHIPU_API_KEY) return null;

  const prompt = [
    "你是短视频文案专家。请为一条竖版短视频输出「标题 + 口播旁白」。",
    `创作主题 / 要求：${requirement?.trim() || "温暖治愈风格，主题由你根据常识合理设定"}`,
    imageCount > 0 ? `参考图共 ${imageCount} 张，画面围绕这些视觉素材展开。` : "",
    "写作要求：",
    "- 标题：8~14 个字，有吸引力、能勾起共鸣，概括主题，不要引号和标点堆砌",
    "- 旁白：共 4~6 句，每句 8~16 个字。像真人对着镜头说话，口语化、温暖自然，不要书面语和说教口吻",
    "- 句内用逗号断出自然的语气停顿（像说话时换气），句子短一点，避免长难句一气读完",
    "- 句子之间语义连贯、层层递进，念出来有呼吸感",
    "- 旁白不要开场套话（如「大家好」「欢迎收看」），不要表情符号、括号说明、镜头提示、markdown",
    "- 不要任何解释",
    '只输出 JSON：{"title":"视频标题","segments":["第一句","第二句",...]}',
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(ZHIPU_CHAT_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ZHIPU_API_KEY}` },
      body: JSON.stringify({
        model: NARRATION_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.8,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content ?? "";
    const { title, segments } = parseScript(content);
    if (!segments.length) return null;
    // 每句保证以标点结尾：TTS（edge-tts）据此正确分句，字幕才能逐句显示。
    const punctuated = segments.map((s) => (/[。！？!?；;]$/.test(s) ? s : `${s}。`));
    // 标题兜底：模型没给就用首句前 14 字。
    const finalTitle = (title || punctuated[0] || "AI 回忆录").slice(0, 20);
    return { title: finalTitle, fullText: punctuated.join(""), segments: punctuated };
  } catch {
    return null;
  }
}
