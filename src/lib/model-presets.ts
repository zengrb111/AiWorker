/**
 * 模型服务预置信息（前后端共用）。
 *
 * 预置项分三类：
 * - OpenAI 兼容对话接口（智谱 / 千问 / 豆包 / 混元 / DeepSeek）：只需 baseUrl + API Key；
 * - 云端配音（智谱 TTS / 千问 TTS）：决定 tts.ts 的降级链走向；
 * - 联网搜索与文生视频：分别服务「今日热点」与「文生视频」两项能力。
 *
 * 这些预置只负责自动填好接口地址与常用模型；API Key 一律由用户本人填写，
 * 加密后存到自己的 UserModelProvider 行里（不存在平台公共密钥）。
 */

export type ModelPreset = {
  /** 预置标识（写入 UserModelProvider.providerId） */
  providerId: string;
  /** 展示名称 */
  label: string;
  /** 品牌色（用于 logo 徽标与选中态） */
  brandColor: string;
  /** logo 徽标文字（无官方 logo 资源时用品牌色 + 首字代替） */
  badge: string;
  /** 接口形态，决定直连时的请求路径与报文风格 */
  apiFormat:
    | "openai-completions"
    | "dashscope-tts"
    | "zhipu-tts"
    | "pollinations-video"
    | "tavily-search"
    | "bocha-search";
  /** 上游 baseUrl */
  baseUrl: string;
  /** 申请 API Key 的控制台地址（面板里给用户跳转） */
  consoleUrl: string;
  /** 常用模型 */
  models: Array<{ id: string; name: string }>;
  /** 给用户的一句提示 */
  hint: string;
};

export const MODEL_PRESETS: ModelPreset[] = [
  {
    providerId: "zhipu",
    label: "智谱 GLM",
    apiFormat: "openai-completions",
    brandColor: "#3b5bdb",
    badge: "智",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    consoleUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    models: [
      { id: "glm-4.6", name: "GLM-4.6" },
      { id: "glm-4.6v", name: "GLM-4.6V（识图）" },
      { id: "glm-4-plus", name: "GLM-4-Plus" },
      { id: "glm-4-flash", name: "GLM-4-Flash" }
    ],
    hint: "在智谱开放平台创建 API Key（格式 xxxxxxxx.yyyyyyyy）"
  },
  {
    providerId: "qwen",
    label: "通义千问",
    apiFormat: "openai-completions",
    brandColor: "#7c3aed",
    badge: "千",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    consoleUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    models: [
      { id: "qwen-max", name: "Qwen Max" },
      { id: "qwen-plus", name: "Qwen Plus" },
      { id: "qwen-turbo", name: "Qwen Turbo" },
      { id: "qwen3-tts-flash", name: "Qwen3-TTS-Flash（配音）" }
    ],
    hint: "在阿里云百炼控制台创建 DashScope API Key（格式 sk-xxxx）"
  },
  {
    providerId: "doubao",
    label: "豆包",
    apiFormat: "openai-completions",
    brandColor: "#2563eb",
    badge: "豆",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    consoleUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    models: [
      { id: "doubao-seed-1-6-250615", name: "Doubao Seed 1.6" },
      { id: "doubao-1-5-pro-32k-250115", name: "Doubao 1.5 Pro 32K" },
      { id: "doubao-pro-32k", name: "Doubao Pro 32K" }
    ],
    hint: "在火山方舟控制台创建 API Key，模型 id 也可填你的接入点 ID（ep-xxxx）"
  },
  {
    providerId: "hunyuan",
    label: "腾讯混元",
    apiFormat: "openai-completions",
    brandColor: "#0ea5e9",
    badge: "混",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    consoleUrl: "https://console.cloud.tencent.com/hunyuan/api-key",
    models: [
      { id: "hunyuan-turbos-latest", name: "Hunyuan TurboS" },
      { id: "hunyuan-pro", name: "Hunyuan Pro" },
      { id: "hunyuan-lite", name: "Hunyuan Lite" }
    ],
    hint: "在腾讯云混元控制台创建 API Key"
  },
  {
    providerId: "deepseek",
    label: "DeepSeek",
    apiFormat: "openai-completions",
    brandColor: "#4f46e5",
    badge: "DS",
    baseUrl: "https://api.deepseek.com/v1",
    consoleUrl: "https://platform.deepseek.com/api_keys",
    models: [
      { id: "deepseek-flash", name: "DeepSeek Flash（快）" },
      { id: "deepseek-chat", name: "DeepSeek Chat" },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner（推理）" }
    ],
    hint: "在 DeepSeek 开放平台创建 API Key（格式 sk-xxxx）"
  },
  {
    providerId: "zhipu-tts",
    label: "智谱配音",
    apiFormat: "zhipu-tts",
    brandColor: "#3b5bdb",
    badge: "智",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    consoleUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    models: [{ id: "glm-tts", name: "GLM-TTS" }],
    hint: "与「智谱 GLM」共用同一个 API Key，可复用已填好的密钥"
  },
  {
    providerId: "qwen-tts",
    label: "千问配音",
    apiFormat: "dashscope-tts",
    brandColor: "#7c3aed",
    badge: "音",
    baseUrl: "https://dashscope.aliyuncs.com",
    consoleUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    models: [{ id: "qwen3-tts-flash", name: "Qwen3-TTS-Flash" }],
    hint: "与「通义千问」共用同一个百炼 API Key"
  },
  {
    providerId: "tavily",
    label: "Tavily 联网搜索",
    apiFormat: "tavily-search",
    brandColor: "#0f766e",
    badge: "TV",
    baseUrl: "https://api.tavily.com",
    consoleUrl: "https://app.tavily.com/home",
    models: [{ id: "tavily-search", name: "Tavily Search" }],
    hint: "在 Tavily 控制台创建 API Key（tvly-…），用于抓取当日真实热点"
  },
  {
    providerId: "bocha",
    label: "博查联网搜索",
    apiFormat: "bocha-search",
    brandColor: "#c2410c",
    badge: "博",
    baseUrl: "https://api.bochaai.com",
    consoleUrl: "https://open.bochaai.com",
    models: [{ id: "bocha-web-search", name: "博查 Web Search" }],
    hint: "需要同时填写 Access-Key 与 Secret-Key 两个密钥"
  },
  {
    providerId: "pollinations",
    label: "Pollinations 文生视频",
    apiFormat: "pollinations-video",
    brandColor: "#db2777",
    badge: "PV",
    baseUrl: "https://gen.pollinations.ai",
    consoleUrl: "https://pollinations.ai",
    models: [
      { id: "wan-fast", name: "Wan Fast" },
      { id: "veo", name: "Veo" }
    ],
    hint: "文生视频服务的 API Key，用于「文生视频」能力"
  }
];

export function findPreset(providerId: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.providerId === providerId);
}

/** 按接口形态给出候选预置（设置页里做智能推荐，降低用户选择成本）。 */
export function presetsForApiFormat(apiFormat: ModelPreset["apiFormat"]): ModelPreset[] {
  return MODEL_PRESETS.filter((preset) => preset.apiFormat === apiFormat);
}
