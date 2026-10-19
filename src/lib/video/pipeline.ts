/**
 * 视频生产统一编排层 —— 四条链路的唯一实现。
 *
 * 改造前 `gen-video/route.ts` 与 `lib/gen-video.ts` 是两份几乎逐行重复的流程。
 * 现在四条链路只负责「鉴权 + 解析表单 + 落库 + SSE」，出片逻辑全部收敛到这里。
 *
 * 流程（顺序与改造前完全一致，只把「让 agent 现场写码渲染」换成「DSH 出分镜 + 固定渲染」）：
 *   素材归一化 → 旁白 → 配音 → 分镜(DSH/兜底) → Remotion 渲染
 *   → padVideoToDuration → muxNarration → buildSrt + burnSubtitles
 *   → addTitleOverlay → extractCoverFrame
 *
 * 后期这几步全部复用 src/lib/video-stitch.ts，一行未改 —— 那些参数
 * （56 号白字黑描边、MarginV=340、BGM 0.16）都是调好的，不该在这次改造里被动。
 *
 * 本模块**只管 DSH + Remotion 这一条路**。旧 OpenClaw 路径保留在各自路由里，
 * 由 VIDEO_RENDER_ENGINE 开关决定走哪边（resolveRenderEngine），出问题可秒级回退。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readStringEnv } from "../env";
import { probeDuration } from "../ffmpeg";
import { describeDshVersion, getDshStatus, runDshRender, runDshText } from "../dsh";
import { generateNarrationScript } from "../narration";
import {
  ModelConfigError,
  type Capability,
  type ModelConfigErrorKind,
} from "../model-credentials";
import { countInsights, insightImages, visionStatus } from "../vision";
import { inferStyle } from "./style";
import {
  DEFAULT_TTS_PROVIDER,
  resolveTtsProvider,
  synthesizeNarration,
  TTS_ENGINE_LABELS,
  type TtsProvider,
  type WordCaption,
} from "../tts";
import {
  addTitleOverlay,
  buildSrtFromCaptions,
  burnSubtitles,
  extractCoverFrame,
  muxNarration,
  padVideoToDuration,
} from "../video-stitch";
import {
  normalizeMaterials,
  renderVertical,
  type Material,
  type VerticalCompositionId,
} from "./render";
import { checkVideoFrames } from "./frame-check";
import type { ArticlePlanExtension } from "../article/types";
import {
  applyLook,
  normalizeBeats,
  planClipStoryboard,
  planStoryboard,
  synthesizeBeats,
  toPlanSummary,
  type CaptionStyleKey,
  type ChromeSpec,
  type ClipStoryboard,
  type LookConfig,
  type MaterialInsight,
  type PlanSummary,
  type Storyboard,
  type StoryboardPlanResult,
  type TimelineBeat,
} from "./storyboard";
import {
  injectChartOverlays,
  mergeChartOverlays,
  summarizeChartKinds,
  type InjectableChart,
} from "./chart-overlays";

/** 三条链路共用一套编排，靠 mode 区分素材形态与合成模板。 */
export type PipelineMode = "generate" | "montage" | "remake";

/** 引擎开关：dsh = 新链路（默认），openclaw = 旧路径，由各路由自行判断。 */
export type RenderEngine = "dsh" | "openclaw";

export function resolveRenderEngine(): RenderEngine {
  return readStringEnv("VIDEO_RENDER_ENGINE").toLowerCase() === "openclaw" ? "openclaw" : "dsh";
}

/**
 * 三个链路各自的合成模板与文件名前缀。
 * 前缀是落库与内容库的路径约定（gen-video- / montage- / viral-remake-），不要改。
 */
const MODE_SPEC: Record<PipelineMode, { composition: VerticalCompositionId; prefix: string }> = {
  generate: { composition: "VerticalStoryboard", prefix: "gen-video" },
  montage: { composition: "VerticalMontage", prefix: "montage" },
  remake: { composition: "VerticalRemake", prefix: "viral-remake" },
};

export type PipelineInput = {
  mode: PipelineMode;
  /** 本次任务唯一标识，决定输出文件名。 */
  token: string;
  /** 原始素材绝对路径（图片 / 视频混排）。 */
  materials: string[];
  /** 用户创作要求。 */
  requirement: string;
  /**
   * 新闻事实（标题 + 摘要），来自「热点一键生成视频」的联网检索结果。
   *
   * **必须透传到旁白生成**：创作要求只说「怎么做」，不含「讲什么」。
   * 不传的话模型只能凭空编，写出来的口播和文章内容对不上。
   * 剪辑 / 复刻链路不涉及新闻，给空即可。
   */
  newsItems?: Array<{ title?: string; snippet?: string }>;
  /** 已有旁白文本；不给则在 generate 模式下按 requirement 自动生成。 */
  narrationText?: string;
  /** 目标时长（秒）。有配音时以配音实际时长为准。 */
  targetSeconds: number;
  ttsProvider?: TtsProvider;
  /** 背景音乐绝对路径。 */
  bgmPath?: string;
  /** 剪辑 / 复刻链路的 ASR 字幕（毫秒）。给了就不再用 TTS 字幕，避免双份字幕。 */
  captions?: WordCaption[];
  /** 片头标题；不给则从旁白首句截取。 */
  title?: string;
  /** 片尾文案。 */
  outroText?: string;
  /** 主题 key（remotion/src/theme.ts）。 */
  theme?: string;
  /** 跳过渲染后的画面黑屏自检（默认执行；仅用于批量出片等已确认可信的场景）。 */
  skipFrameCheck?: boolean;
  /** 片头标题展示时长（秒）。 */
  titleSeconds?: number;
  /**
   * 成片文件名前缀。缺省用 mode 的默认前缀（gen-video / montage / viral-remake）。
   * 后台批量出片历史上用的是 content-video-，那条链路要显式传进来保持落库路径不变。
   */
  outputPrefix?: string;
  /**
   * 归属用户（**必填**）。
   *
   * 识图、配音、分镜规划都用它去取该用户在「系统配置 → 模型配置」里的模型服务，
   * 漏传会让这三项各自静默降级（识图退轮播、配音退本机 TTS、分镜退固定节奏），
   * 而且不报错、只在进度里留一句提示，极难排查 —— 所以在类型上强制。
   */
  userId: string;
  /**
   * 替换「分镜 + 渲染」这一步（VIDEO_RENDER_ENGINE=openclaw 时由旧路径提供）。
   *
   * 只替换画面生成，旁白、配音、混音、字幕、片头、封面全部仍走本模块 ——
   * 这样新旧两条引擎的成片观感一致，回退时也不会退回到"另一套后期"。
   */
  renderOverride?: (context: RenderContext) => Promise<{ ok: boolean; outputPath: string; detail: string }>;
  /**
   * 外观覆盖：在主题之上叠加特效层 / 统一运镜 / 指定字幕样式。
   *
   * 由**用户**决定，不交给 DSH —— 观感偏好不是模型该猜的东西，
   * 交给模型只会得到「每次不一样的风格」，反而不可复现。
   * 缺省（undefined）时成片观感与改造前完全一致。
   */
  look?: LookConfig;
  /**
   * 渲染 + 后期是否交给 DSH（放开沙箱）完成。
   *
   * 默认 true：平台把渲染清单交给 DSH，由它在沙箱里调用 Remotion + ffmpeg
   * 完成「渲染 + 后期」一条龙，再把成片写回 public/videos。DSH 不可用时
   * （未配置「分镜规划」模型服务）自动回退本地「renderVertical + video-stitch」。
   * 显式传 false 可强制走本地渲染（排障用）。旧引擎（renderOverride）优先级更高，
   * 一旦提供了 renderOverride，本开关无意义。
   */
  renderViaDsh?: boolean;
  /**
   * 已确认的规划阶段产物（来自 `runVideoPlanStage`）。
   *
   * 给了它就**跳过**识图/旁白/配音/分镜，直接进入渲染 ——
   * 这是「先出方案给用户确认，再出片」的第二段。用户确认前的那一次
   * 规划结果存进 VideoPlan 表，确认后原样取回，避免重复跑一次
   * 1~2 分钟的识图+配音+DSH。
   */
  resume?: VideoPlanDraft;
  onProgress?: (text: string) => void;
};

/**
 * 规划阶段的产物：一切「渲染之前」能算出来的东西。
 *
 * 这个对象会整体序列化进 VideoPlan 表，所以**只放可 JSON 化的纯数据**，
 * 不要往里塞文件句柄或函数。
 */
export type VideoPlanDraft = {
  /** 素材绝对路径（规划与渲染必须是同一批文件，故 token 一致）。 */
  materials: string[];
  /** 完整的分镜（含 look 覆盖），渲染阶段直接喂 Remotion。 */
  storyboard: Storyboard;
  /** 时间轴骨架，诊断用。 */
  beatCount: number;
  /** 识图结果：给方案面板展示「AI 理解到的素材」。 */
  insights: MaterialInsight[];
  /**
   * 本次用到的新闻事实。存进 draft 是为了让「重新生成方案」后
   * 界面仍能告诉用户「这份文案基于哪几条新闻」，而不是只有一段孤立的旁白。
   */
  newsItems: Array<{ title: string; snippet: string }>;
  narration: string;
  title: string;
  /** 配音文件绝对路径；为空表示无配音版本。 */
  audioPath: string | null;
  audioSeconds: number;
  /** 实际生效的主题 key。 */
  theme: string;
  /** 识图自动选主题的理由，供界面如实告知。 */
  themeReason: string;
  /** 字幕样式（已写入 storyboard.look，这里冗余一份便于渲染阶段直接取用）。 */
  captionStyle: CaptionStyleKey;
  totalSeconds: number;
  /** 规划阶段的诊断信息。 */
  diagnostics: {
    visionRecognized: number;
    visionTotal: number;
    dshAvailable: boolean;
    dshReason?: string;
    /**
     * DSH SDK / 运行时二进制版本，形如「SDK 0.1.5rc1 · 运行时 0.1.5rc1」。
     * 只在读得到时出现（读不到不影响出片）。
     */
    dshVersion?: string;
    /**
     * 版本自检的提醒：装到的版本与本项目核对过的基线不一致时才有内容，
     * 提醒去复核受限 profile 的插件 id 是否还对得上。为空 = 版本一致。
     */
    dshVersionNote?: string;
    storyboardFallback: boolean;
    storyboardAttempts: number;
    /**
     * 用了兜底分镜的原因（DSH 不可用时看 dshReason）。
     * 形如「分镜 JSON 不符合要求：scenes[2].images 最多 3 张」，供方案面板如实展示。
     */
    storyboardReason?: string;
    sceneCount: number;
    timelineBeats: number;
    /** 配音实际使用的引擎与是否发生降级。 */
    ttsEngine?: string;
    ttsFallbackReason?: string;
    /** 规划耗时（毫秒），用于界面上「方案生成用时」。 */
    elapsedMs: number;
  };
  /** 供前端直接渲染的方案摘要。 */
  summary: PlanSummary;
  /**
   * 「文章转视频」的来源与图表清单。
   *
   * 可选字段：generate / montage / remake 三条既有链路不会写它，
   * JSON.stringify 落库与 JSON.parse resume 都照常工作。
   */
  article?: ArticlePlanExtension;
};

/** 传给 renderOverride 的上下文。 */
export type RenderContext = {
  token: string;
  materials: Material[];
  /** 用户创作要求原文。 */
  requirement: string;
  narrationText: string;
  /** 成片输出绝对路径；旧引擎必须写到这里。 */
  outputPath: string;
  targetSeconds: number;
  imageCount: number;
  /** 归属用户（可能为空，仅旧引擎用来隔离会话）。 */
  userId?: string;
  notify: (text: string) => void;
};

export type PipelineDiagnostics = {
  materialCount: number;
  narrationSeconds: number;
  /** 分镜是否走了确定性兜底。 */
  storyboardFallback: boolean;
  storyboardAttempts: number;
  /** 走兜底的原因（DSH 不可用看 dshReason，这里是 DSH 可用但分镜没通过校验）。 */
  storyboardReason?: string;
  /** 画面段数（场景或片段），用于核对画面是否切得太碎。 */
  sceneCount: number;
  /** 时间轴锚点数（= 旁白句数）。 */
  timelineBeats: number;
  /** 识图成功识别的张数（0 = 未启用或全部失败）。 */
  visionRecognized: number;
  /** 参与识图的图片总数。 */
  visionTotal: number;
  /** 识图自动选出的主题 key（未触发为空）。 */
  autoTheme?: string;
  /** 自动选主题的理由。 */
  autoThemeReason?: string;
  dshAvailable: boolean;
  dshReason?: string;
  /** 与 VideoPlanDiagnostics 同义，便于出片任务结果里也能看出 DSH 版本。 */
  dshVersion?: string;
  dshVersionNote?: string;
  /** 后期每一步的成败，便于事后定位是哪一环掉的。 */
  postSteps: { step: string; ok: boolean; detail?: string }[];
  elapsedMs: number;
};

export type PipelineResult = {
  ok: boolean;
  error?: string;
  /**
   * 缺模型配置时的结构化分类（kind + capability）。
   *
   * 渲染阶段的旁白生成同样可能因「未配置对话模型」失败
   * （不带 planToken 的直接出片路径会重新生成文案）。这类错误必须原样上报，
   * API 层才能转成「去系统配置」入口，而不是只给一句无法行动的文案。
   */
  modelConfig?: { kind: ModelConfigErrorKind; capability: Capability | null };
  videoUrl?: string;
  coverUrl?: string;
  title: string;
  narration: string;
  /** 实际使用的引擎与模板，写进任务结果便于排查。 */
  engineUsed: string;
  diagnostics: PipelineDiagnostics;
};

/** 从 public/audio/bgm 选一首温暖治愈风格的背景音乐。 */
export function pickBgm(): string | undefined {
  const dir = join(process.cwd(), "public", "audio", "bgm");
  try {
    const files = readdirSync(dir).filter((f) => /\.(mp3|m4a|wav|aac)$/i.test(f));
    if (!files.length) return undefined;
    const preferred = files.filter((f) => /dreamy|peaceful|warm|calm|piano|gentle/i.test(f));
    const pool = preferred.length ? preferred : files;
    return join(dir, pool[Math.floor(Math.random() * pool.length)]);
  } catch {
    return undefined;
  }
}

/**
 * 从创作要求里读「N 秒」。
 *
 * 约定：未写或不合理（<8s）时用默认值（10s）；**上限 30 秒** —— 短视频拉太长
 * 会明显拖慢渲染、也影响完播，超过 30s 一律按 30s 处理。
 */
export function parseTargetSeconds(requirement: string, fallback = 10): number {
  const match = requirement.match(/(\d{1,3})\s*秒/);
  const parsed = match ? Number.parseInt(match[1], 10) : Number.NaN;
  const seconds = Number.isFinite(parsed) && parsed >= 8 ? parsed : fallback;
  return Math.min(30, seconds);
}

/**
 * 把 planStoryboard 内部的错误明细压成一句可展示的中文。
 *
 * 只取前 3 条：校验器一次能报十几条，全塞进面板反而看不清主干问题。
 */
function formatStoryboardReason(errors: string[] | undefined): string | undefined {
  if (!errors?.length) return undefined;
  const head = errors.slice(0, 3).join("；");
  return errors.length > 3 ? `${head}（共 ${errors.length} 条）` : head;
}

/**
 * 规划阶段：识图 → 自动选风格 → 旁白 → 配音 → DSH 分镜，**不渲染**。
 *
 * ## 为什么单独拆出来
 *
 * 早先这些步骤全都藏在 `runVideoPipeline` 里，而该函数由「点击开始生成」触发，
 * 于是用户在 2~5 分钟的渲染开始之前，**没有任何机会看到 AI 到底打算怎么剪这条片子**：
 * 分镜结果只变成一行进度文本「分镜规划完成（N 段）」混在几十条进度里，
 * 更谈不上确认或修改。需求是「先理解素材 → 出方案 → 用户选 → 再生成」。
 *
 * 拆开之后，规划阶段（约 1~2 分钟，主要是配音与 DSH）产出一个可序列化的
 * `VideoPlanDraft`，存进 VideoPlan 表；用户确认后由 `runVideoPipeline`
 * 带 `resume` 回来，直接从渲染开始 —— 规划不必重跑。
 *
 * ## 为什么规划阶段必须包含配音
 *
 * 分镜的时间轴骨架 `beats` 来自 TTS 的**句级时间戳**（`buildBeats`），
 * 不跑配音就没有真实时间点，分镜只能是估算。所以方案阶段天然要等配音完成，
 * 这一点已与产品确认并接受。
 *
 * 与 `runVideoPipeline` 一样不抛错：规划失败也要返回 `ok:false` + 可读原因。
 */
export async function runVideoPlanStage(
  input: PlanStageInput,
): Promise<
  | { ok: true; draft: VideoPlanDraft }
  | {
      ok: false;
      error: string;
      /**
       * 结构化错误分类，供 API 层转成错误码、前端决定要不要弹「去系统配置」入口。
       * 缺模型配置（no_provider / no_assignment / invalid_key）必须原样传出去 ——
       * 这类错误不能降级，用户不配就出不了片，得让他知道去配。
       */
      modelConfig?: { kind: ModelConfigErrorKind; capability: Capability | null };
    }
> {
  const started = Date.now();
  const notify = input.onProgress ?? (() => undefined);
  const record: string[] = [];

  const spec = MODE_SPEC[input.mode];
  const workDir = input.workDir ?? join(process.cwd(), "public", "uploads", `${spec.prefix}-work`, input.token);
  mkdirSync(workDir, { recursive: true });

  // ---- 1. 素材归一化 ----
  const materials = normalizeMaterials(input.materials);
  if (materials.length === 0) return { ok: false, error: "没有可用素材，无法规划视频方案。" };

  // ---- 1.5 识图：素材语义 + 整体色调画像 ----
  //
  // ① 每张图的语义描述 → 喂 DSH，让它把「对的图放在对的句子上」而非按顺序轮播；
  // ② 整体色调 → 自动挑一套协调主题，用户不必懂配色。
  // 任何一步失败都退回改造前行为（insights 为空 → 按顺序轮播 + 用户选/默认主题），
  // 识图是纯增强，绝不允许它让规划失败。
  let insights: MaterialInsight[] = [];
  let autoThemeKey: string | null = null;
  let visionRecognized = 0;
  let visionTotal = 0;
  const imageMaterials = materials.filter((m) => m.kind === "image");
  if (input.mode === "generate" && imageMaterials.length) {
    const status = await visionStatus({ userId: input.userId });
    if (status.ok) {
      notify("正在识别素材图片内容…");
      try {
        const found = await insightImages(
          imageMaterials.map((m) => m.absolutePath),
          { userId: input.userId },
        );
        insights = imageMaterials.map((m, k) => {
          const one = found[k];
          return one
            ? {
                path: m.absolutePath,
                caption: one.caption,
                mood: one.mood,
                subject: one.subject,
                dominantColor: one.dominantColor,
                isDark: one.isDark,
              }
            : { path: m.absolutePath, caption: "", mood: "", subject: "", dominantColor: "" };
        });
        visionTotal = imageMaterials.length;
        visionRecognized = countInsights(insights);
        if (visionRecognized > 0) {
          record.push(`识别 ${visionRecognized}/${visionTotal} 张`);
          // 自动选主题：仅当用户没有显式指定时才生效
          if (!input.theme) {
            const choice = inferStyle(insights.filter((i) => i.caption));
            if (choice) {
              autoThemeKey = choice.themeKey;
              notify(`已根据素材色调自动选择风格「${choice.theme.label}」`);
            }
          }
        } else {
          record.push("未能识别任何图片，按原顺序轮播");
        }
      } catch (error) {
        record.push(`识别异常，已忽略：${(error as Error).message}`);
      }
    } else {
      record.push(`识图不可用（${status.reason}），按原顺序轮播`);
    }
  }

  /** 最终生效的主题：用户显式选择 > 识图推断 > 缺省（规划层用默认）。 */
  const effectiveTheme = input.theme ?? autoThemeKey ?? undefined;
  const themeReason =
    input.theme
      ? "你手动指定的风格"
      : autoThemeKey
        ? "AI 识别素材主色调后自动挑选，避免配色与画面打架"
        : "未能推断素材色调，使用默认风格";

  notify(`已就绪 ${materials.length} 份素材，开始规划分镜…`);

  // ---- 2. 旁白（剪辑 / 复刻链路由 ASR 提供，不需要再生成）----
  let narrationText = input.narrationText?.trim() ?? "";
  let videoTitle = input.title?.trim() ?? "";
  if (!narrationText && input.mode === "generate") {
    notify("正在根据创作要求生成标题与旁白文案…");
    // 「未配置对话模型」必须显式失败并给出指引，不能降级成无旁白纯画面 ——
    // 用户会以为功能坏了，而真实原因只是少配一个模型服务。
    let script: Awaited<ReturnType<typeof generateNarrationScript>>;
    try {
      script = await generateNarrationScript(
        input.requirement,
        materials.length,
        input.targetSeconds,
        insights,
        input.newsItems ?? [],
        input.userId,
      );
    } catch (error) {
      if (error instanceof ModelConfigError) {
        notify(error.message);
        return {
          ok: false,
          error: error.message,
          modelConfig: { kind: error.kind, capability: error.capability },
        };
      }
      throw error;
    }
    narrationText = script?.fullText ?? "";
    videoTitle = videoTitle || (script?.title ?? "");
    if (narrationText) notify(`已生成标题「${videoTitle}」与旁白（${script!.segments.length} 句）`);
  }

  // ---- 3. 配音：规划阶段不做 TTS ----
  // 出方案要快，配音挪到出片阶段再合成（见 runVideoPipeline 的「出片前补配音」）。
  // 这里用旁白字数估算时间轴骨架，分镜按估算时长排版；真实配音时长以出片时为准，
  // 后期的 pad / apad 会消化长度差，字幕仍以真实配音的时间戳为准。
  const estimatedFromText = narrationText ? narrationText.replace(/\s+/g, "").length / 4.5 : 0;

  // ---- 4. 分镜：DSH 出稿，失败自动兜底 ----
  const totalSeconds = Math.max(6, Math.round(estimatedFromText || input.targetSeconds));
  const dsh = await getDshStatus(input.userId);
  const beats = buildBeats(
    input.captions?.length ? input.captions : undefined,
    totalSeconds,
  );
  // prompt 用：这次会注入哪几类图表。必须提前算 —— 它要写进 prompt，
  // 而注入本身发生在 DSH 返回之后（要拿 beats 与场景出点才能排落点）。
  const chartHint = summarizeChartKinds(input.chartSpecs);
  const plan = await planStoryboardFor(
    input,
    materials,
    totalSeconds,
    beats,
    insights,
    effectiveTheme,
    dsh.ok,
    notify,
    chartHint,
  );
  reportPlan(plan, dsh.ok, notify);

  const looked = applyLook(plan.storyboard, {
    captionStyle: input.look?.captionStyle,
    ...(input.look?.effects ? { effects: input.look.effects } : {}),
    ...(input.look?.motion ? { motion: input.look.motion } : {}),
  }) as Storyboard;

  /*
   * 图表注入：把文章分析产出的（已溯源的）结构化数据翻成 Remotion 原生图表图层。
   *
   * 放在 applyLook 之后而不是之前，是因为「撤掉打架的 DSH 图层」是一次结构性改写，
   * 用户调整（Look）不该被它反向覆盖；而它产出的图层不受 Look 的 motion 影响，
   * 所以顺序上无副作用。
   *
   * 放在 DSH 之后而不是之前：DSH 看不到图表数据，让它规划会瞎猜；
   * 而图表的落点需要旁白时间轴（beats），那要等配音跑完才有 —— 此时两者都已就绪。
   */
  const sceneOutPoints = (looked.scenes ?? []).map((s) => s.outSeconds);
  const injected = injectChartOverlays({
    charts: input.chartSpecs ?? [],
    beats,
    sceneOutPoints,
  });
  let board = looked;
  if (injected.overlays.length) {
    board = {
      ...looked,
      overlays: mergeChartOverlays(looked.overlays, injected),
    };
    record.push(`注入图表 ${injected.overlays.length} 张（${injected.kindHint}）`);
    notify(`已把 ${injected.overlays.length} 张数据图表做成动态图层（${injected.kindHint}）`);
  }
  if (input.storyChrome) {
    board = { ...board, chrome: input.storyChrome };
  }

  const sceneCount = "scenes" in board ? board.scenes.length : 0;
  const draft: VideoPlanDraft = {
    materials: materials.map((m) => m.absolutePath),
    storyboard: board,
    beatCount: beats.length,
    insights,
    newsItems: (input.newsItems ?? []).map((n) => ({
      title: (n.title ?? "").slice(0, 200),
      snippet: (n.snippet ?? "").slice(0, 400),
    })).filter((n) => n.title.trim()),
    narration: narrationText,
    title: videoTitle,
    // 规划阶段不做 TTS：音频在出片阶段合成，这里只给「估算时长」供方案展示。
    audioPath: null,
    audioSeconds: totalSeconds,
    theme: board.theme,
    themeReason,
    captionStyle: input.look?.captionStyle ?? "classic",
    totalSeconds,
    diagnostics: {
      visionRecognized,
      visionTotal,
      dshAvailable: dsh.ok,
      dshReason: dsh.ok ? undefined : dsh.reason,
      ...describeDshVersion(dsh),
      storyboardFallback: plan.fallback,
      storyboardAttempts: plan.diagnostics.attempts,
      // DSH 能调通、但返回的分镜没通过 JSON 解析或 schema 校验时，原因只存在于
      // planStoryboard 的内部诊断里。不透出来的话，方案面板只能显示一句
      // 「分镜不可用」，用户无从判断是模型没配好还是这一次的输出不合格。
      storyboardReason: plan.fallback ? formatStoryboardReason(plan.diagnostics.firstAttemptError) : undefined,
      sceneCount,
      timelineBeats: beats.length,
      elapsedMs: Date.now() - started,
    },
    summary: toPlanSummary(
      { ...plan, storyboard: board },
      {
        imagePaths: materials.map((m) => m.absolutePath),
        insights,
        captionStyle: input.look?.captionStyle,
      },
    ),
  };
  if (record.length) console.log(`[plan-stage] ${input.token}：${record.join("；")}`);
  return { ok: true, draft };
}

/** 规划阶段的输入。渲染阶段用不到 `look` 之外的任何渲染参数。 */
export type PlanStageInput = {
  mode: PipelineMode;
  token: string;
  materials: string[];
  requirement: string;
  targetSeconds: number;
  userId: string;
  narrationText?: string;
  title?: string;
  outroText?: string;
  ttsProvider?: TtsProvider;
  captions?: WordCaption[];
  theme?: string;
  look?: LookConfig;
  /**
   * 新闻事实（标题 + 摘要），来自联网检索。透传给旁白生成 ——
   * 创作要求只说「怎么做」，不含「讲什么」，不传模型只能编。
   *
   * `isPrimary` 标记「这条视频到底讲哪一条」。只有主新闻是要写进文案的内容，
   * 其余仅作背景参考；不带标记时第一条视为主新闻。
   */
  newsItems?: Array<{ title?: string; snippet?: string; isPrimary?: boolean }>;
  /**
   * 文章分析产出的**结构化图表数据**（已过溯源闸门）。
   *
   * 给了就会：① 在分镜 prompt 里声明「图表由系统注入」；
   * ② 在 DSH 出稿后按旁白时间轴把图表排进 overlays，并撤掉与之打架的文字图层。
   *
   * 不给（纯图片转视频链路）则两件事都不发生，行为与改造前完全一致。
   */
  chartSpecs?: InjectableChart[];
  /**
   * 常驻页面装饰（顶部彩条 / 页眉 / 页脚 / 进度线）。
   * 由服务端用文章标题与来源生成，不交给模型。
   */
  storyChrome?: ChromeSpec;
  /** 配音工作目录；不给则用「<prefix>-work/<token>」。渲染阶段必须沿用同一个。 */
  workDir?: string;
  onProgress?: (text: string) => void;
};

/**
 * 跑完整条出片流程。
 *
 * 不抛错：任何环节失败都通过 `ok:false` + `error` 返回，
 * 由路由决定是落 FAILED，还是回退旧引擎重试。
 *
 * 传了 `input.resume` 时跳过识图/旁白/配音/分镜，直接从渲染开始
 * （用户已在方案确认环节看过并接受这份规划结果）。
 */
export async function runVideoPipeline(input: PipelineInput): Promise<PipelineResult> {
  const started = Date.now();
  const spec = MODE_SPEC[input.mode];
  // outputPrefix 允许调用方沿用自己的历史命名（后台出片是 content-video-）
  const prefix = input.outputPrefix?.trim() || spec.prefix;
  const notify = input.onProgress ?? (() => undefined);
  const postSteps: PipelineDiagnostics["postSteps"] = [];
  const record = (step: string, ok: boolean, detail?: string) => postSteps.push({ step, ok, detail });

  const diagnostics: PipelineDiagnostics = {
    materialCount: 0,
    narrationSeconds: 0,
    storyboardFallback: true,
    storyboardAttempts: 0,
    sceneCount: 0,
    timelineBeats: 0,
    visionRecognized: 0,
    visionTotal: 0,
    dshAvailable: false,
    postSteps,
    elapsedMs: 0,
  };

  const finish = (result: Omit<PipelineResult, "diagnostics">): PipelineResult => {
    diagnostics.elapsedMs = Date.now() - started;
    return { ...result, diagnostics };
  };

  const videosDir = join(process.cwd(), "public", "videos");
  const coverDir = join(process.cwd(), "public", "uploads", "covers");
  const workDir = join(process.cwd(), "public", "uploads", `${prefix}-work`, input.token);
  mkdirSync(videosDir, { recursive: true });
  mkdirSync(coverDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  let videoTitle = input.title?.trim() ?? "";
  let narrationText = input.narrationText?.trim() ?? "";

  try {
    // ---- 1~4. 规划阶段 ----
    //
    // resume 分支：用户已在方案确认环节看过这份规划，直接取用。
    // 必须复用**同一个 workDir**（同一个 token），否则配音文件找不到。
    let materials: Material[];
    let plan: StoryboardPlanResult | null = null;
    let beats: TimelineBeat[] = [];
    let audio: { audioPath: string; durationSeconds: number; captions: WordCaption[] } | null = null;
    let totalSeconds = input.targetSeconds;

    if (input.resume) {
      const draft = input.resume;
      materials = normalizeMaterials(draft.materials);
      videoTitle = draft.title || videoTitle;
      narrationText = draft.narration || narrationText;
      // 规划阶段已经把 look 写进 storyboard，这里不再重复应用。
      plan = { storyboard: draft.storyboard, fallback: draft.diagnostics.storyboardFallback, diagnostics: {
        attempts: draft.diagnostics.storyboardAttempts,
        usedDsh: draft.diagnostics.dshAvailable,
        elapsedMs: draft.diagnostics.elapsedMs,
        rawLength: 0,
      } };
      beats = draft.storyboard.beats ?? [];
      // 用分镜自带的时间轴骨架还原字幕，而不是按字数估算：
      // beats 本身就是 TTS 的句级时间戳（只是归一化过），比估算准。
      audio = draft.audioPath
        ? {
            audioPath: draft.audioPath,
            durationSeconds: draft.audioSeconds,
            captions: beatsToCaptions(beats),
          }
        : null;
      totalSeconds = draft.totalSeconds;
      diagnostics.materialCount = materials.length;
      diagnostics.narrationSeconds = draft.audioSeconds;
      diagnostics.storyboardFallback = draft.diagnostics.storyboardFallback;
      diagnostics.storyboardAttempts = draft.diagnostics.storyboardAttempts;
      diagnostics.storyboardReason = draft.diagnostics.storyboardReason;
      diagnostics.sceneCount = draft.diagnostics.sceneCount;
      diagnostics.timelineBeats = draft.beatCount;
      diagnostics.visionRecognized = draft.diagnostics.visionRecognized;
      diagnostics.visionTotal = draft.diagnostics.visionTotal;
      diagnostics.dshAvailable = draft.diagnostics.dshAvailable;
      diagnostics.dshReason = draft.diagnostics.dshReason;
      diagnostics.dshVersion = draft.diagnostics.dshVersion;
      diagnostics.dshVersionNote = draft.diagnostics.dshVersionNote;
      record("沿用已确认方案", true, `${draft.diagnostics.sceneCount} 个镜头 / 风格 ${draft.theme}`);
      notify(`已沿用你确认的方案（${draft.diagnostics.sceneCount} 个镜头），开始渲染…`);
    } else {
      const stage = await runVideoPlanStage({
        mode: input.mode,
        token: input.token,
        materials: input.materials,
        requirement: input.requirement,
        targetSeconds: input.targetSeconds,
        userId: input.userId,
        narrationText: input.narrationText,
        title: input.title,
        outroText: input.outroText,
        ttsProvider: input.ttsProvider,
        captions: input.captions,
        theme: input.theme,
        look: input.look,
        workDir,
        onProgress: notify,
      });
      if (!stage.ok) {
        record("规划阶段", false, stage.error);
        return finish({
          ok: false,
          error: stage.error,
          title: videoTitle,
          narration: narrationText,
          engineUsed: "dsh-remotion",
        });
      }
      const draft = stage.draft;
      materials = normalizeMaterials(draft.materials);
      videoTitle = draft.title || videoTitle;
      narrationText = draft.narration || narrationText;
      plan = { storyboard: draft.storyboard, fallback: draft.diagnostics.storyboardFallback, diagnostics: {
        attempts: draft.diagnostics.storyboardAttempts,
        usedDsh: draft.diagnostics.dshAvailable,
        elapsedMs: draft.diagnostics.elapsedMs,
        rawLength: 0,
      } };
      beats = draft.storyboard.beats ?? [];
      audio = draft.audioPath
        ? {
            audioPath: draft.audioPath,
            durationSeconds: draft.audioSeconds,
            captions: beatsToCaptions(beats),
          }
        : null;
      totalSeconds = draft.totalSeconds;
      diagnostics.materialCount = materials.length;
      diagnostics.narrationSeconds = draft.audioSeconds;
      diagnostics.storyboardFallback = draft.diagnostics.storyboardFallback;
      diagnostics.storyboardAttempts = draft.diagnostics.storyboardAttempts;
      diagnostics.storyboardReason = draft.diagnostics.storyboardReason;
      diagnostics.sceneCount = draft.diagnostics.sceneCount;
      diagnostics.timelineBeats = draft.beatCount;
      diagnostics.visionRecognized = draft.diagnostics.visionRecognized;
      diagnostics.visionTotal = draft.diagnostics.visionTotal;
      diagnostics.dshAvailable = draft.diagnostics.dshAvailable;
      diagnostics.dshReason = draft.diagnostics.dshReason;
      diagnostics.dshVersion = draft.diagnostics.dshVersion;
      diagnostics.dshVersionNote = draft.diagnostics.dshVersionNote;
    }

    if (materials.length === 0) {
      record("素材归一化", false, "没有可用素材");
      return finish({
        ok: false,
        error: "没有可用素材，无法出片。",
        title: videoTitle,
        narration: narrationText,
        engineUsed: "dsh-remotion",
      });
    }

    // ---- 4.5 出片前补配音 ----
    // 规划阶段不做 TTS（参考图 / 参考文章两个模式都一样）：这里用规划产物里的旁白文本
    // 在出片时合成，字幕与混音都基于真实配音时长。老方案若已带 audioPath，直接复用、不重复合成。
    if (input.mode === "generate" && !audio && narrationText) {
      const ttsProvider = resolveTtsProvider(input.ttsProvider, DEFAULT_TTS_PROVIDER);
      notify(`正在用${TTS_ENGINE_LABELS[ttsProvider]}合成配音…`);
      try {
        const tts = await synthesizeNarration(narrationText, workDir, undefined, ttsProvider, {
          userId: input.userId,
        });
        audio = {
          audioPath: tts.audioPath,
          durationSeconds: tts.durationSeconds,
          captions: tts.captions,
        };
        record("配音合成", true, `约 ${tts.durationSeconds.toFixed(1)} 秒`);
        notify(`配音合成完成（约 ${tts.durationSeconds.toFixed(1)} 秒）`);
      } catch (error) {
        record("配音合成", false, (error as Error).message);
        notify(`配音合成失败，将生成无配音版本：${(error as Error).message}`);
      }
    }

    // ---- 5. 渲染画面 ----
    // 默认交给 DSH（放开沙箱）完成「Remotion 渲染 + 后期」一条龙；失败自动回退本地渲染。
    const rawAbs = join(videosDir, `${prefix}-${input.token}.mp4`);
    const coverAbs = join(coverDir, `${prefix}-${input.token}.jpg`);
    let currentAbs = rawAbs;
    let cover: { ok: boolean; outputPath?: string; reason?: string } = { ok: false };
    let engineUsed = input.renderOverride ? "openclaw" : `dsh-remotion/${spec.composition}`;

    const dshRenderStatus = await getDshStatus(input.userId);
    let usedDshRender =
      input.renderOverride === undefined && input.renderViaDsh !== false && dshRenderStatus.ok;

    if (usedDshRender) {
      try {
        const progressPath = join(workDir, "render-progress.log");
        const manifest = {
          projectRoot: process.cwd(),
          compositionId: spec.composition,
          token: input.token,
          prefix,
          storyboard: plan!.storyboard,
          materials: materials.map((m) => m.absolutePath),
          outputVideoAbs: rawAbs,
          outputCoverAbs: coverAbs,
          audioPath: audio?.audioPath ?? null,
          captions: input.captions?.length ? input.captions : audio?.captions ?? null,
          titleText: videoTitle || narrationText.slice(0, 14),
          titleSeconds: input.titleSeconds ?? 3,
          bgmPath: input.bgmPath ?? null,
          captionStyle: (input.resume?.captionStyle ?? input.look?.captionStyle ?? "classic") as CaptionStyleKey,
          skipFrameCheck: !!input.skipFrameCheck,
          ffmpegBin: readStringEnv("FFMPEG_BIN") || "ffmpeg",
          ffprobeBin: readStringEnv("FFPROBE_BIN") || "ffprobe",
          browserExe: readStringEnv("REMOTION_BROWSER_EXECUTABLE") || undefined,
          /** 脚本把每一步进度追加到这里，平台在出片期间轮询并流式推给会话。 */
          progressPath,
        };
        const manifestPath = join(workDir, "render-manifest.json");
        const resultPath = join(workDir, "render-result.json");
        writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

        const renderScript = join(process.cwd(), "scripts", "dsh-storyboard", "render-video.mjs");
        const nodeBin = process.execPath;
        const prompt =
          `请使用你的命令执行工具（Windows 上通常是 pwsh，其他平台是 bash），原样运行下面的渲染命令，` +
          `不要修改路径、不要拆行、不要添加任何额外步骤。\n\n` +
          `命令（按你实际使用的 shell 选择其一）：\n` +
          `- pwsh：  & "${nodeBin}" "${renderScript}" --input "${manifestPath}" --output "${resultPath}"\n` +
          `- bash：  "${nodeBin}" "${renderScript}" --input "${manifestPath}" --output "${resultPath}"\n\n` +
          `说明：\n` +
          `- --input 是渲染清单 JSON（含素材路径、分镜、配音、字幕、标题等）；\n` +
          `- --output 是渲染结果 JSON 的写入路径；\n` +
          `- node 与 ffmpeg 已在环境变量 NODE_BIN / FFMPEG_BIN / FFPROBE_BIN / PATH 中注入，可直接使用；\n` +
          `- 渲染脚本会把最终视频写到清单里指定的 public/videos 目录，并把结果写入 --output 文件。\n\n` +
          `命令退出后，请读取 "${resultPath}" 文件，把其中的 JSON 内容原样返回给我（不要改写）。` +
          `若脚本报告 ok:false，也请原样返回并附上 error 字段文字。` +
          `除运行上述命令外，不要创建或修改任何项目文件，也不要执行其他命令。`;

        // 清掉上一轮的进度残留，避免重复推送。
        try {
          writeFileSync(progressPath, "", "utf8");
        } catch {
          // 忽略
        }

        notify(`已交给 DSH（DeepSeek），正在调用 Remotion 渲染并做后期…`);
        // DSH 渲染是黑盒、可能持续数分钟。脚本会把每一步（渲染 / 自检 / 混音 /
        // 字幕 / 片头 / 封面）写进 progressPath，这里轮询它并把新增行流式推给会话，
        // 让用户看到真实进展而不是干等。
        let seenProgress = 0;
        const flushDshProgress = () => {
          try {
            if (!existsSync(progressPath)) return;
            const raw = readFileSync(progressPath, "utf8");
            // 只消费「完整行」：脚本 appendFileSync 时若正好读到半行，丢掉半行等下一轮，
            // 否则半行会被当成一条进展推出去、且下一轮已越过它。
            const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
            const lines = complete.split(/\r?\n/).filter((line) => line.trim());
            for (; seenProgress < lines.length; seenProgress++) notify(lines[seenProgress]);
          } catch {
            // 读进度失败不影响出片
          }
        };
        const progressPoller = setInterval(flushDshProgress, 2000);
        try {
          await runDshRender(prompt, { userId: input.userId, sessionId: `render-${input.token}` });
        } finally {
          clearInterval(progressPoller);
          flushDshProgress(); // 冲掉最后几行
        }

        if (existsSync(resultPath)) {
          const result = JSON.parse(readFileSync(resultPath, "utf8"));
          // 成片存在即可采用；封面缺失不阻断（避免为了一张封面把整条片子重渲一遍）。
          if (result.ok && existsSync(rawAbs)) {
            currentAbs = rawAbs;
            const hasCover = existsSync(coverAbs);
            cover = hasCover ? { ok: true, outputPath: coverAbs } : { ok: false, reason: "封面缺失" };
            engineUsed = `dsh-remotion/${spec.composition}`;
            const fc = result.diagnostics?.frameCheck;
            record("DSH 渲染+后期", true, fc ? `黑屏自检：${fc.detail}` : "完成");
            notify("DSH 已完成渲染与后期，成片已回传平台");
          } else {
            throw new Error(result.error || "DSH 渲染未产出成片文件");
          }
        } else {
          throw new Error("DSH 渲染未产出结果文件");
        }
      } catch (err) {
        const message = (err as Error).message;
        record("DSH 渲染", false, message);
        notify(`DSH 渲染失败，回退本地渲染：${message}`);
        usedDshRender = false;
      }
    }

    if (!usedDshRender) {
      // ---- 5（本地兜底）. Remotion 渲染或由旧引擎替换 ----
      const render = input.renderOverride
        ? await input.renderOverride({
            token: input.token,
            materials,
            requirement: input.requirement,
            narrationText,
            outputPath: rawAbs,
            targetSeconds: totalSeconds,
            imageCount: materials.length,
            userId: input.userId,
            notify,
          })
        : await renderVertical({
            compositionId: spec.composition,
            storyboard: plan!.storyboard,
            token: input.token,
            materials,
            outputPath: rawAbs,
            onProgress: notify,
          });
      record(input.renderOverride ? "画面渲染（旧引擎）" : "Remotion 渲染", render.ok, render.detail);
      if (!render.ok) {
        return finish({
          ok: false,
          error: `画面渲染失败：${render.detail}`,
          title: videoTitle,
          narration: narrationText,
          engineUsed: input.renderOverride ? "openclaw" : `dsh-remotion/${spec.composition}`,
        });
      }

      // ---- 5.5 画面自检：渲染退出码为 0 不等于每帧都有内容 ----
      // 这里检出的黑屏「曾经真的发生过」：Sequence 漏 from 会让 4/5 的成片纯黑，
      // 而渲染是成功的。检查只告警不阻断 —— 宁可让用户拿到一条有瑕疵的片子，
      // 也不要因为自检不通过就丢掉整条出片结果。
      if (!input.skipFrameCheck) {
        const check = await checkVideoFrames(rawAbs);
        record("画面黑屏自检", check.ok, check.detail);
        if (!check.ok) {
          notify(`⚠ 画面自检未通过：${check.detail}`);
        } else {
          notify("画面自检通过（无异常黑屏）");
        }
      }

      // ---- 6. 后期：延长 → 混音 → 字幕 → 片头 → 封面 ----
      currentAbs = rawAbs;

      // P0 之后画面长度由「排版末端」决定，正常情况下就等于口播长度。
      // 这里的延长只剩兜底意义（AI 少给了一个镜头、或渲染层钳位），但一旦发生就必须补，
      // 否则就是用户报的「口播没说完视频已经停了」。
      if (audio && audio.durationSeconds > 0) {
        const rendered = await probeDuration(currentAbs);
        const gap = audio.durationSeconds - rendered;
        if (Number.isFinite(gap) && gap > 0.3) {
          const paddedAbs = join(videosDir, `${prefix}-${input.token}-pad.mp4`);
          const pad = await padVideoToDuration(currentAbs, paddedAbs, gap, notify);
          record("画面延长", pad.ok, pad.ok ? `+${gap.toFixed(1)}s` : pad.reason);
          if (pad.ok) {
            currentAbs = paddedAbs;
            notify(`画面比口播短 ${gap.toFixed(1)} 秒，已补齐末帧`);
          }
        }
      }

      if (audio) {
        const muxedAbs = join(videosDir, `${prefix}-${input.token}-voice.mp4`);
        const mux = await muxNarration(currentAbs, audio.audioPath, muxedAbs, {
          bgmPath: input.bgmPath,
          onProgress: notify,
        });
        record("配音混音", mux.ok, mux.ok ? undefined : mux.reason);
        if (mux.ok) {
          currentAbs = muxedAbs;
          notify(input.bgmPath ? "配音与背景音乐已合成进视频" : "配音已合成进视频");

          // 硬断言：成片不得短于口播。短了就是「口播被掐断」，必须当场暴露而不是等用户发现。
          const finalDur = await probeDuration(currentAbs);
          const lost = audio.durationSeconds - finalDur;
          if (Number.isFinite(lost) && lost > 0.5) {
            record("成片时长校验", false, `成片 ${finalDur.toFixed(2)}s 短于口播 ${audio.durationSeconds.toFixed(2)}s，末句被截断 ${lost.toFixed(2)}s`);
            notify(`⚠ 成片比口播短 ${lost.toFixed(2)} 秒，末句可能不完整`);
          } else {
            record("成片时长校验", true, `成片 ${finalDur.toFixed(2)}s / 口播 ${audio.durationSeconds.toFixed(2)}s`);
          }
        } else {
          notify(`配音合入失败，保留原声版：${mux.reason}`);
        }
      }

      // 字幕来源二选一：剪辑链路的 ASR 字幕优先，避免同一句话出现两层字幕
      const captions = input.captions?.length ? input.captions : audio?.captions;
      // 字幕样式：resume 分支用方案里确认过的（规划阶段已写进 storyboard.look），
      // 否则用本次请求带的 look；都没有就是 classic（与改造前一致）。
      const captionStyle =
        (input.resume?.captionStyle ?? input.look?.captionStyle ?? "classic") as CaptionStyleKey;
      if (captions?.length) {
        const subAbs = join(videosDir, `${prefix}-${input.token}-sub.mp4`);
        const srtPath = join(workDir, "captions.srt");
        const srt = buildSrtFromCaptions(captions, srtPath);
        if (srt.ok) {
          const burn = await burnSubtitles(currentAbs, srtPath, subAbs, notify, captionStyle);
          record("字幕烧录", burn.ok, burn.ok ? `${srt.cueCount} 句` : burn.reason);
          if (burn.ok) {
            currentAbs = subAbs;
            notify(`字幕已烧录（${srt.cueCount} 句）`);
          } else {
            notify(`字幕烧录失败，保留无字幕版：${burn.reason}`);
          }
        } else {
          record("字幕烧录", false, "字幕数据为空");
          notify("字幕数据为空，跳过字幕烧录。");
        }
      }

      const titleText = videoTitle || narrationText.slice(0, 14);
      if (titleText) {
        const titleSeconds = input.titleSeconds ?? 3;
        const titleAbs = join(videosDir, `${prefix}-${input.token}-title.mp4`);
        const overlay = await addTitleOverlay(currentAbs, titleText, titleAbs, {
          durationSec: titleSeconds,
          onProgress: notify,
        });
        record("片头标题", overlay.ok, overlay.ok ? undefined : overlay.reason);
        if (overlay.ok) {
          currentAbs = titleAbs;
          notify(`已添加片头标题（前 ${titleSeconds} 秒展示）`);
        } else {
          notify(`片头标题添加失败：${overlay.reason}`);
        }
      }

      const duration = await probeDuration(currentAbs);
      cover = await extractCoverFrame(currentAbs, coverAbs, Math.max(1, Math.min(4, duration * 0.35)));
      record("封面截取", cover.ok, cover.ok ? undefined : cover.reason);
    }

    return finish({
      ok: true,
      videoUrl: `/videos/${basename(currentAbs)}`,
      coverUrl: cover.ok ? `/uploads/covers/${prefix}-${input.token}.jpg` : undefined,
      title: videoTitle,
      narration: narrationText,
      engineUsed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "视频生成失败。";
    record("编排异常", false, message);
    return finish({
      ok: false,
      error: message,
      title: videoTitle,
      narration: narrationText,
      engineUsed: "dsh-remotion",
    });
  }
}

/** 数一数分镜里有几段画面 / 几个文字图层，用于诊断信息。 */
function countSegments(storyboard: Storyboard | ClipStoryboard): number {
  const count = "scenes" in storyboard ? storyboard.scenes.length : storyboard.clips.length;
  return count;
}

/** 分镜结果播报。区分「DeepSeek 不可用」与「模型输出没通过校验」——排障时指向完全不同。 */
function reportPlan(plan: StoryboardPlanResult, dshAvailable: boolean, notify: (text: string) => void): void {
  if (!plan.fallback) {
    const segments =
      (plan.storyboard as Storyboard).scenes?.length ?? (plan.storyboard as ClipStoryboard).clips.length;
    notify(`分镜规划完成（${segments} 段）`);
    return;
  }
  if (!dshAvailable) {
    notify("DeepSeek 规划不可用，已改用默认节奏（不影响出片）");
    return;
  }
  const errors = plan.diagnostics.firstAttemptError?.join("；");
  notify(`分镜输出未通过校验，已改用默认节奏${errors ? `：${errors}` : ""}`);
}

/**
 * 把 TTS/ASR 的句级字幕折成绝对时间轴骨架。
 *
 * 这是 P0 的关键接线：分镜不再由 AI 估「每段多少秒」，而是挂在这条由配音
 * 时间戳算出来的骨架上，成片长度因此天然等于口播长度。
 */
function buildBeats(captions: WordCaption[] | undefined, durationSeconds: number): TimelineBeat[] {
  const fromCaptions = (captions ?? [])
    .filter((c) => c.word && c.word.trim() && c.endMs > c.startMs)
    .map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.word.trim() }));
  return fromCaptions.length
    ? normalizeBeats(fromCaptions, durationSeconds)
    : synthesizeBeats(durationSeconds);
}

/**
 * 时间轴骨架还原成字幕条目。
 *
 * 规划阶段与渲染阶段是两次 HTTP 请求，原始 TTS 字幕对象不会跨请求传递；
 * 而 beats 本来就是从字幕归一化来的，所以反向还原比按字数重新估算准确得多。
 */
function beatsToCaptions(beats: TimelineBeat[]): WordCaption[] {
  return beats
    .filter((b) => b.text && b.text.trim() && b.endMs > b.startMs)
    .map((b) => ({ word: b.text.trim(), startMs: b.startMs, endMs: b.endMs }));
}

/**
 * 分镜规划：按 mode 选图片分镜或片段分镜。
 *
 * 这一步永不失败 —— DSH 不可用或输出不合法时，规划层会退回确定性兜底分镜。
 * `dshAvailable=false` 时直接返回 null 让规划层走兜底，不做无谓的重试。
 */
async function planStoryboardFor(
  input: Pick<PlanStageInput, "mode" | "userId" | "token" | "requirement" | "outroText">,
  materials: Material[],
  totalSeconds: number,
  beats: TimelineBeat[],
  insights: MaterialInsight[],
  effectiveTheme: string | undefined,
  dshAvailable: boolean,
  notify: (text: string) => void,
  /** 本次将被系统注入的图表类型提示（中文名）。空串 = 不注入，prompt 里不提。 */
  chartKindHint?: string,
): Promise<StoryboardPlanResult> {
  const run = async (prompt: string): Promise<string | null> => {
    if (!dshAvailable) return null;
    return runDshText({ userId: input.userId, prompt, sessionId: `storyboard-${input.token}` });
  };

  if (input.mode === "generate") {
    notify(dshAvailable ? "正在用 DeepSeek 规划分镜节奏…" : "未配置 DeepSeek，改用默认分镜节奏…");
    return planStoryboard(
      {
        requirement: input.requirement,
        imagePaths: materials.map((m) => m.absolutePath),
        beats,
        insights: insights.length ? insights : undefined,
        durationSeconds: totalSeconds,
        outroText: input.outroText,
        theme: effectiveTheme,
        chartKindHint,
      },
      run,
    );
  }

  notify(dshAvailable ? "正在用 DeepSeek 规划剪辑节奏…" : "未配置 DeepSeek，改用默认剪辑节奏…");
  return planClipStoryboard(
    {
      requirement: input.requirement,
      materialPaths: materials.map((m) => m.absolutePath),
      beats,
      insights: insights.length ? insights : undefined,
      durationSeconds: totalSeconds,
      outroText: input.outroText,
      theme: effectiveTheme,
    },
    run,
  );
}
