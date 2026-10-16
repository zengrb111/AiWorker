/**
 * OCR：调用多模态模型（OpenAI 兼容 /chat/completions），提取图片中的可见文字。
 *
 * 凭据来源：当前登录用户在「系统配置 → 模型配置」里为「图片文字识别」指定的模型服务，
 * 不再读全局 env —— 否则所有用户共用同一份 key，且无法按用户隔离。
 *
 * 注意：这是「一键仿写爆款」的辅助能力——主图文字识别失败不应阻断仿写，
 * 调用方需自行 try/catch 兜底。
 */

import { resolveCapabilityConfig, type ResolvedModelConfig } from "@/lib/model-credentials";

const OCR_PROMPT =
  "请提取这张图片中所有可见的文字（包括标题、正文、标语、金句、水印、话题标签等），" +
  "严格按原顺序逐行输出，不要翻译、不要改写、不要添加任何解释或说明性文字。";

export type OcrOptions = {
  /** 归属用户；与 config 二选一。 */
  userId?: string;
  /** 长任务可传入 snapshotUserConfig 的一次性快照。 */
  config?: ResolvedModelConfig | null;
};

export async function ocrImageText(imageUrl: string, options: OcrOptions = {}): Promise<string> {
  const config =
    options.config !== undefined
      ? options.config
      : options.userId
        ? await resolveCapabilityConfig(options.userId, "ocr")
        : null;

  if (!config) {
    throw new Error("尚未指定「图片文字识别」使用哪个模型，请前往「系统配置 → 默认模型分配」选择。");
  }
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new Error("OCR 仅支持 http(s) 图片链接。");
  }

  const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
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
    if (res.status === 401 || res.status === 403) {
      throw new Error(`「${config.label}」拒绝了该密钥，请在「系统配置」中检查图片文字识别模型的 API Key。`);
    }
    throw new Error(`OCR 调用失败 ${res.status}：${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (json.choices?.[0]?.message?.content || "").trim();
}
