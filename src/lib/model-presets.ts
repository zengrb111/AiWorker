/**
 * 模型供应商预置信息（前后端共用）。
 *
 * 四家国内主流模型都是 OpenAI 兼容接口，因此统一按 openai-completions 接入，
 * 只需要 baseUrl + API Key + 模型 id 即可在 OpenClaw 里使用。
 */

export type ModelPreset = {
  /** OpenClaw 里的 provider id */
  providerId: string;
  /** 展示名称 */
  label: string;
  /** 品牌色（用于 logo 徽标与选中态） */
  brandColor: string;
  /** logo 徽标文字（无官方 logo 资源时用品牌色 + 首字代替） */
  badge: string;
  /** OpenAI 兼容 baseUrl */
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
    brandColor: "#3b5bdb",
    badge: "智",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    consoleUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    models: [
      { id: "glm-4.6", name: "GLM-4.6" },
      { id: "glm-4-plus", name: "GLM-4-Plus" },
      { id: "glm-4-flash", name: "GLM-4-Flash" }
    ],
    hint: "在智谱开放平台创建 API Key（格式 xxxxxxxx.yyyyyyyy）"
  },
  {
    providerId: "qwen",
    label: "通义千问",
    brandColor: "#7c3aed",
    badge: "千",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    consoleUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    models: [
      { id: "qwen-max", name: "Qwen Max" },
      { id: "qwen-plus", name: "Qwen Plus" },
      { id: "qwen-turbo", name: "Qwen Turbo" }
    ],
    hint: "在阿里云百炼控制台创建 DashScope API Key（格式 sk-xxxx）"
  },
  {
    providerId: "doubao",
    label: "豆包",
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
  }
];

export function findPreset(providerId: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.providerId === providerId);
}
