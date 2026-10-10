/**
 * 旁白文案生成（「一键生成视频」的自动配文）。
 *
 * 用智谱 GLM 对话模型，根据用户的整体创作要求生成一段中文口播旁白，
 * 供 TTS 配音与字幕使用。模型可用环境变量覆盖：NARRATION_MODEL（默认 glm-4-flash）。
 * 失败返回 null，由上层降级（无旁白，仅画面）。
 */

const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY ?? "";
const ZHIPU_CHAT_API = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const NARRATION_MODEL = process.env.NARRATION_MODEL ?? "glm-4-flash";

export type NarrationScript = {
  /** 整段旁白（用于 TTS） */
  fullText: string;
  /** 分句（用于参考/兜底字幕） */
  segments: string[];
};

/** 从模型返回文本里尽量解析出 segments 数组。 */
function parseSegments(content: string): string[] {
  const cleaned = content.replace(/```json/gi, "").replace(/```/g, "").trim();
  let arr: unknown = null;
  try {
    const j = JSON.parse(cleaned) as { segments?: unknown };
    if (Array.isArray(j?.segments)) arr = j.segments;
  } catch {
    const m = cleaned.match(/\{[\s\S]*"segments"[\s\S]*\}/);
    if (m) {
      try {
        const j = JSON.parse(m[0]) as { segments?: unknown };
        if (Array.isArray(j?.segments)) arr = j.segments;
      } catch {
        /* ignore */
      }
    }
  }
  if (!Array.isArray(arr)) return [];
  return (arr as unknown[])
    .map((s) => String(s).replace(/["'“”‘’]/g, "").trim())
    .filter((s) => s.length > 0);
}

/**
 * 生成旁白文案：4~6 句、每句 10~22 字、口语温暖、适合逐句字幕。
 * 失败返回 null。
 */
export async function generateNarrationScript(
  requirement: string,
  imageCount: number
): Promise<NarrationScript | null> {
  if (!ZHIPU_API_KEY) return null;

  const prompt = [
    "你是短视频口播文案专家。请为一条竖版短视频写一段中文旁白（将用于配音和字幕）。",
    `创作主题 / 要求：${requirement?.trim() || "温暖治愈风格，主题由你根据常识合理设定"}`,
    imageCount > 0 ? `参考图共 ${imageCount} 张，画面围绕这些视觉素材展开。` : "",
    "写作要求：",
    "- 共 4~6 句，每句 10~22 个字，口语化、温暖自然、朗朗上口",
    "- 句子之间语义连贯，像一个人娓娓道来",
    "- 不要开场套话（如「大家好」「欢迎收看」），不要表情符号、括号说明、镜头提示、markdown、引号",
    "- 直接给最终旁白，不要任何解释",
    '只输出 JSON：{"segments":["第一句","第二句",...]}',
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
    const segments = parseSegments(content);
    if (!segments.length) return null;
    // 每句保证以标点结尾：TTS（edge-tts）据此正确分句，字幕才能逐句显示。
    const punctuated = segments.map((s) => (/[。！？!?；;]$/.test(s) ? s : `${s}。`));
    return { fullText: punctuated.join(""), segments: punctuated };
  } catch {
    return null;
  }
}
