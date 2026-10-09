/**
 * OCR：调用千问 VL 多模态模型，提取图片中的可见文字。
 *
 * 复用项目已有的 DashScope 通道（与 vision.js 一致）：
 *   DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL / VISION_MODEL
 * 兼容 OpenAI 风格的 /chat/completions 接口，图片以 URL 传入。
 *
 * 注意：这是「一键仿写爆款」的辅助能力——主图文字识别失败不应阻断仿写，
 * 调用方需自行 try/catch 兜底。
 */

const BASE_URL = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const API_KEY = process.env.DASHSCOPE_API_KEY || "";
const MODEL = process.env.VISION_MODEL || "";

const OCR_PROMPT =
  "请提取这张图片中所有可见的文字（包括标题、正文、标语、金句、水印、话题标签等），" +
  "严格按原顺序逐行输出，不要翻译、不要改写、不要添加任何解释或说明性文字。";

export async function ocrImageText(imageUrl: string): Promise<string> {
  if (!API_KEY || !MODEL) {
    throw new Error("OCR 未配置（缺少 DASHSCOPE_API_KEY 或 VISION_MODEL）");
  }
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new Error("OCR 仅支持 http(s) 图片链接。");
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: OCR_PROMPT }
          ]
        }
      ],
      stream: false,
      max_tokens: 1500
    }),
    signal: AbortSignal.timeout(60_000)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OCR 调用失败 ${res.status}：${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (json.choices?.[0]?.message?.content || "").trim();
}
