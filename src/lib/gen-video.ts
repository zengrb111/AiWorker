/**
 * 内容 → 竖版短视频（后台批量出片入口）。
 *
 * 这里曾经是「对话内一键生成视频」的复制粘贴版，与 gen-video 路由逐行重复。
 * 现在出片逻辑收敛到 src/lib/video/pipeline.ts，本模块只负责把「内容条目」
 * 翻译成编排层的入参。
 *
 * 保留的差异只有一处且不能动：成片前缀是 content-video-（不是 gen-video-），
 * 内容库按这个路径存。
 */
import { existsSync } from "node:fs";
import { DEFAULT_TTS_PROVIDER, resolveTtsProvider } from "./tts";
import { pickBgm, resolveRenderEngine, runVideoPipeline } from "./video/pipeline";
import { renderViaOpenClaw } from "./video/legacy-openclaw";

/** 成片文件名前缀（内容库按这个名字入库，不要改）。 */
const OUTPUT_PREFIX = "content-video";

/** 片头标题展示时长（秒） */
const TITLE_SECONDS = 3;

export type GenerateContentVideoInput = {
  /** 归属用户（决定 OpenClaw 会话路由） */
  userId: string;
  /** 内容标题 */
  title: string;
  /** 内容正文（用作创作要求的主体） */
  body: string;
  /** 参考图绝对路径（通常为条目封面；至少一张） */
  imagePaths: string[];
  /** 目标成片时长（秒）；缺省由旁白长度自然决定 */
  targetSeconds?: number;
  /** 语音引擎（zhipu / qwen）；缺省用全局默认（环境变量 TTS_PROVIDER） */
  ttsProvider?: string;
  /** 进度回调（可选，用于写日志/推送状态） */
  onProgress?: (text: string) => void;
};

export type GenerateContentVideoResult = {
  ok: boolean;
  /** 成片地址（/videos/xxx.mp4） */
  videoUrl?: string;
  /** 视频封面地址（/uploads/covers/xxx.jpg） */
  coverUrl?: string;
  /** 视频标题（LLM 生成） */
  videoTitle?: string;
  /** 旁白全文 */
  narration?: string;
  /** 失败原因 */
  reason?: string;
};

export async function generateContentVideo(
  input: GenerateContentVideoInput
): Promise<GenerateContentVideoResult> {
  const report = (text: string) => {
    try {
      input.onProgress?.(text);
    } catch {
      /* 进度回调失败不影响主流程 */
    }
  };
  const imagePaths = input.imagePaths.filter((p) => p && existsSync(p));
  if (!imagePaths.length) {
    return { ok: false, reason: "没有可用的参考图（封面未就绪）" };
  }

  const requirement = [
    input.title,
    input.body,
    input.targetSeconds ? `（本条视频目标时长约 ${input.targetSeconds} 秒，旁白文案请控制在这个长度）` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4000);

  const engine = resolveRenderEngine();
  const result = await runVideoPipeline({
    mode: "generate",
    token: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    materials: imagePaths,
    requirement,
    targetSeconds: input.targetSeconds ?? 30,
    ttsProvider: resolveTtsProvider(input.ttsProvider, DEFAULT_TTS_PROVIDER),
    bgmPath: pickBgm(),
    outputPrefix: OUTPUT_PREFIX,
    userId: input.userId,
    renderOverride: engine === "openclaw" ? renderViaOpenClaw : undefined,
    onProgress: report,
  });

  if (!result.ok) {
    return { ok: false, reason: result.error ?? "视频生成失败" };
  }

  return {
    ok: true,
    videoUrl: result.videoUrl,
    coverUrl: result.coverUrl,
    // LLM 没给出标题时回落到内容条目标题（与改造前一致）
    videoTitle: result.title || input.title.slice(0, 30),
    narration: result.narration,
  };
}
