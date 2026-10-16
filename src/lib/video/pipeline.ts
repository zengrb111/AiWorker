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

import { mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { readStringEnv } from "../env";
import { probeDuration } from "../ffmpeg";
import { getDshStatus, runDshText } from "../dsh";
import { generateNarrationScript } from "../narration";
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
import {
  normalizeBeats,
  planClipStoryboard,
  planStoryboard,
  synthesizeBeats,
  type ClipStoryboard,
  type MaterialInsight,
  type Storyboard,
  type StoryboardPlanResult,
  type TimelineBeat,
} from "./storyboard";

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
  onProgress?: (text: string) => void;
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
  /** 后期每一步的成败，便于事后定位是哪一环掉的。 */
  postSteps: { step: string; ok: boolean; detail?: string }[];
  elapsedMs: number;
};

export type PipelineResult = {
  ok: boolean;
  error?: string;
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

/** 从创作要求里读「N 秒」；未写或不合理时用默认值，并封顶 60 秒（兼顾渲染耗时）。 */
export function parseTargetSeconds(requirement: string, fallback = 30): number {
  const match = requirement.match(/(\d{1,3})\s*秒/);
  const parsed = match ? Number.parseInt(match[1], 10) : Number.NaN;
  const seconds = Number.isFinite(parsed) && parsed >= 8 ? parsed : fallback;
  return Math.min(60, seconds);
}

/**
 * 跑完整条出片流程。
 *
 * 不抛错：任何环节失败都通过 `ok:false` + `error` 返回，
 * 由路由决定是落 FAILED，还是回退旧引擎重试。
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
    // ---- 1. 素材归一化 ----
    const materials = normalizeMaterials(input.materials);
    diagnostics.materialCount = materials.length;
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

    // ---- 1.5 识图（增强项，失败静默降级）----
    //
    // 产出两份东西：
    //   ① 每张图的语义描述 → 喂给 DSH，让它把「对的图放在对的句子上」，
    //      而不是按列表顺序轮播；
    //   ② 整体色调画像 → 自动挑一套协调的主题，用户不必懂配色。
    //
    // 任何一步失败都退回改造前行为：insights 为空 → 按顺序轮播 + 用户选/默认主题。
    // 识图是纯增强，绝不允许它让出片失败。
    let insights: MaterialInsight[] = [];
    let autoThemeKey: string | null = null;
    const wantVision = input.mode === "generate" && materials.some((m) => m.kind === "image");
    if (wantVision) {
      const status = await visionStatus({ userId: input.userId });
      if (status.ok && input.userId) {
        notify("正在识别素材图片内容…");
        try {
          const imagePaths = materials.filter((m) => m.kind === "image").map((m) => m.absolutePath);
          const found = await insightImages(imagePaths, { userId: input.userId });
          // 只保留图片类结果，且与 materials 的下标对齐
          const imageIndexes = materials
            .map((m, i) => (m.kind === "image" ? i : -1))
            .filter((i) => i >= 0);
          insights = imageIndexes.map((idx, k) => {
            const one = found[k];
            return one
              ? {
                  path: materials[idx].absolutePath,
                  caption: one.caption,
                  mood: one.mood,
                  subject: one.subject,
                  dominantColor: one.dominantColor,
                  isDark: one.isDark,
                }
              : {
                  path: materials[idx].absolutePath,
                  caption: "",
                  mood: "",
                  subject: "",
                  dominantColor: "",
                };
          });

          const recognized = countInsights(insights);
          diagnostics.visionRecognized = recognized;
          diagnostics.visionTotal = imagePaths.length;
          if (recognized > 0) {
            record("素材识图", true, `识别 ${recognized}/${imagePaths.length} 张`);

            // 自动选主题：仅当用户没有显式指定时才生效
            if (!input.theme) {
              const choice = inferStyle(insights.filter((i) => i.caption));
              if (choice) {
                autoThemeKey = choice.themeKey;
                diagnostics.autoTheme = choice.themeKey;
                diagnostics.autoThemeReason = choice.reason;
                notify(`已根据素材色调自动选择风格「${choice.theme.label}」`);
              }
            }
          } else {
            record("素材识图", false, "未能识别任何图片，按原顺序轮播");
          }
        } catch (error) {
          record("素材识图", false, `识别异常，已忽略：${(error as Error).message}`);
        }
      } else {
        record("素材识图", false, `识图不可用（${!status.ok ? status.reason : "缺少登录用户"}），按原顺序轮播`);
      }
    }

    /** 最终生效的主题：用户显式选择 > 识图推断 > 未指定（规划层用默认）。 */
    const effectiveTheme = input.theme ?? autoThemeKey ?? undefined;
    notify(`已就绪 ${materials.length} 份素材，开始规划分镜…`);

    // ---- 2. 旁白（剪辑 / 复刻链路由 ASR 提供，不需要再生成） ----
    if (!narrationText && input.mode === "generate") {
      notify("正在根据创作要求生成标题与旁白文案…");
      const script = await generateNarrationScript(input.requirement, materials.length, input.targetSeconds);
      narrationText = script?.fullText ?? "";
      videoTitle = videoTitle || (script?.title ?? "");
      if (narrationText) notify(`已生成标题「${videoTitle}」与旁白（${script!.segments.length} 句）`);
    }

    // ---- 3. 配音 ----
    const ttsProvider = resolveTtsProvider(input.ttsProvider, DEFAULT_TTS_PROVIDER);
    let audio: { audioPath: string; durationSeconds: number; captions: WordCaption[] } | null = null;
    // 剪辑 / 复刻链路已有 ASR 字幕与原声，不需要再合成一份配音
    const needVoice = Boolean(narrationText) && input.mode === "generate";
    if (needVoice) {
      notify(`正在用${TTS_ENGINE_LABELS[ttsProvider]}合成配音…`);
      try {
        const tts = await synthesizeNarration(narrationText, workDir, undefined, ttsProvider, {
          userId: input.userId
        });
        audio = { audioPath: tts.audioPath, durationSeconds: tts.durationSeconds, captions: tts.captions };
        diagnostics.narrationSeconds = tts.durationSeconds;
        if (tts.engine && tts.engine !== ttsProvider) {
          // 引擎与用户选择不一致 = 发生了降级回退。
          // 必须带上真实原因：早先只说「引擎不可用」，用户无从判断是缺 key、限流还是参数错。
          const reason = tts.fallbackReason ? `。原因：${tts.fallbackReason.slice(0, 160)}` : "";
          notify(
            `所选引擎不可用，已自动切换到${TTS_ENGINE_LABELS[tts.engine]}合成配音（约 ${tts.durationSeconds.toFixed(1)} 秒）${reason}`,
          );
          record("配音引擎降级", false, `${ttsProvider} → ${tts.engine}：${tts.fallbackReason ?? "原因未记录"}`);
        } else {
          notify(`配音合成完成（约 ${tts.durationSeconds.toFixed(1)} 秒）`);
        }
      } catch (error) {
        // 配音失败不阻断出片：无配音版本也是完整成片
        const message = (error as Error).message;
        record("配音合成", false, message);
        notify(`配音合成失败，将生成无配音版本：${message}`);
      }
    } else if (narrationText) {
      notify("沿用原视频音轨与 ASR 字幕，跳过配音合成…");
    } else {
      notify("未生成旁白文案，直接进入画面渲染…");
    }

    // ---- 4. 分镜：DSH 出稿，失败自动兜底 ----
    // 画面总时长跟配音走；没有配音就用调用方给的目标时长。
    // 分镜与渲染两处都要用，提到循环外只算一次。
    const totalSeconds = Math.max(6, audio?.durationSeconds ?? input.targetSeconds);

    // 走旧引擎时不规划分镜 —— 旧路径自己现场写渲染代码，规划纯属浪费一次 DSH 调用
    let plan: StoryboardPlanResult | null = null;
    let beats: TimelineBeat[] = [];
    if (!input.renderOverride) {
      const dsh = await getDshStatus(input.userId);
      diagnostics.dshAvailable = dsh.ok;
      if (!dsh.ok) diagnostics.dshReason = dsh.reason;

      // P0：把配音/ASR 的句级时间戳折成时间轴骨架，分镜挂在它上面 → 成片长度 = 口播长度
      beats = buildBeats(input.captions?.length ? input.captions : audio?.captions, totalSeconds);
      plan = await planStoryboardFor(
        input,
        materials,
        totalSeconds,
        beats,
        insights,
        effectiveTheme,
        dsh.ok,
        notify,
      );
      diagnostics.storyboardFallback = plan.fallback;
      diagnostics.storyboardAttempts = plan.diagnostics.attempts;
      diagnostics.sceneCount = countSegments(plan.storyboard);
      diagnostics.timelineBeats = beats.length;
      reportPlan(plan, dsh.ok, notify);
    }

    // ---- 5. 渲染画面（Remotion，或由调用方替换成旧引擎） ----
    const rawAbs = join(videosDir, `${prefix}-${input.token}.mp4`);
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
    let currentAbs = rawAbs;

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
    if (captions?.length) {
      const subAbs = join(videosDir, `${prefix}-${input.token}-sub.mp4`);
      const srtPath = join(workDir, "captions.srt");
      const srt = buildSrtFromCaptions(captions, srtPath);
      if (srt.ok) {
        const burn = await burnSubtitles(currentAbs, srtPath, subAbs, notify);
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
    const coverAbs = join(coverDir, `${prefix}-${input.token}.jpg`);
    const cover = await extractCoverFrame(currentAbs, coverAbs, Math.max(1, Math.min(4, duration * 0.35)));
    record("封面截取", cover.ok, cover.ok ? undefined : cover.reason);

    return finish({
      ok: true,
      videoUrl: `/videos/${basename(currentAbs)}`,
      coverUrl: cover.ok ? `/uploads/covers/${prefix}-${input.token}.jpg` : undefined,
      title: videoTitle,
      narration: narrationText,
      engineUsed: input.renderOverride ? "openclaw" : `dsh-remotion/${spec.composition}`,
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
 * 分镜规划：按 mode 选图片分镜或片段分镜。
 *
 * 这一步永不失败 —— DSH 不可用或输出不合法时，规划层会退回确定性兜底分镜。
 * `dshAvailable=false` 时直接返回 null 让规划层走兜底，不做无谓的重试。
 */
async function planStoryboardFor(
  input: PipelineInput,
  materials: Material[],
  totalSeconds: number,
  beats: TimelineBeat[],
  insights: MaterialInsight[],
  effectiveTheme: string | undefined,
  dshAvailable: boolean,
  notify: (text: string) => void,
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
