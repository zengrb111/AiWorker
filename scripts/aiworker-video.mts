/**
 * 平台视频生成 CLI —— 供 OpenClaw（第一交互人）直接 spawn。
 *
 * 方案 C：OpenClaw 识别视频意图后，用它自己的 bash 工具执行本脚本；
 * 脚本以独立 Node 进程跑完整条视频链路，不经 Next.js。
 *
 * 用法：
 *   npx tsx scripts/aiworker-video.mts \
 *     --user-id <id> --requirement <文本> --materials <路径...> \
 *     [--theme <key>] [--target-seconds <n>] \
 *     [--look-effects <a,b>] [--look-motion <m>] [--caption-style <s>] \
 *     [--token <token>] [--skip-plan] [--tts-provider <p>]
 *
 * 输出契约（OpenClaw 依赖它转述给用户，**不要随意改字段名**）：
 *   stdout 最后一行是 JSON：
 *     规划完成待确认 {"ok":true,"needsConfirmation":true,"token","title","scenes":[...],...}
 *     出片成功       {"ok":true,"token","title","videoPath","coverPath","durationSeconds","narration","sceneCount"}
 *     失败           {"ok":false,"error":"..."}
 *   exit code：0 = 已给出结论（含业务失败），1 = 用法/参数错误，2 = 运行时崩溃
 *
 * 安全边界（方案文档第 6 章）：
 *   · 密钥：内部走 resolveCapabilityConfig(userId, ...) 从平台库自取，
 *     **调用方（OpenClaw）不接触任何 key**，只传 userId。
 *   · 素材：只接受 --materials 显式给出的路径，且必须是已存在的文件。
 *   · 落库：本脚本**不写数据库**。产物 JSON 由 OpenClaw 回传平台
 *     POST /api/conversations/[id]/gen-video/from-cli 完成，数据写入权在平台。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTargetSeconds,
  runVideoPlanStage,
  runVideoPipeline,
  type PipelineResult,
  type VideoPlanDraft,
} from "../src/lib/video/pipeline";
import { ModelConfigError, resolveCapabilityConfig } from "../src/lib/model-credentials";
import { parseLookFromFlags } from "../src/lib/video/plan-params";
import { writeVideoProgress } from "../src/lib/video/progress-file";

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

type CliArgs = {
  userId: string;
  requirement: string;
  materials: string[];
  theme?: string;
  targetSeconds?: number;
  look?: ReturnType<typeof parseLookFromFlags>;
  token?: string;
  skipPlan: boolean;
  ttsProvider?: string;
  /** 归属会话（可选）：带上之后进度只在该会话里展示，避免跨会话串台。 */
  conversationId?: string;
};

class UsageError extends Error {}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { userId: "", requirement: "", materials: [], skipPlan: false };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) continue;

    // --materials 是变长参数：吃掉后续所有非 -- 开头的 token。
    if (flag === "--materials") {
      i++;
      while (i < argv.length && !argv[i].startsWith("--")) {
        const value = argv[i].trim();
        if (value) args.materials.push(value);
        i++;
      }
      i--;
      continue;
    }
    if (flag === "--skip-plan") {
      args.skipPlan = true;
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`参数 ${flag} 缺少取值`);
    }
    switch (flag) {
      case "--user-id":
        args.userId = value.trim();
        break;
      case "--requirement":
        args.requirement = value.trim();
        break;
      case "--theme":
        args.theme = value.trim() || undefined;
        break;
      case "--target-seconds": {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 8 || n > 60) {
          throw new UsageError("--target-seconds 需在 8~60 之间");
        }
        args.targetSeconds = n;
        break;
      }
      case "--look-effects": {
        const form = new FormData();
        form.set("lookEffects", value);
        args.look = { ...(args.look ?? {}), ...parseLookFromFlags(form) };
        break;
      }
      case "--look-motion": {
        const form = new FormData();
        form.set("lookMotion", value);
        args.look = { ...(args.look ?? {}), ...parseLookFromFlags(form) };
        break;
      }
      case "--caption-style": {
        const form = new FormData();
        form.set("captionStyle", value);
        args.look = { ...(args.look ?? {}), ...parseLookFromFlags(form) };
        break;
      }
      case "--token":
        args.token = value.trim() || undefined;
        break;
      case "--conversation-id":
        args.conversationId = value.trim() || undefined;
        break;
      case "--tts-provider":
        args.ttsProvider = value.trim() || undefined;
        break;
      default:
        throw new UsageError(`未知参数 ${flag}`);
    }
    i++; // 消费掉取值
  }

  if (!args.userId) throw new UsageError("缺少必填参数 --user-id");
  if (!args.requirement) throw new UsageError("缺少必填参数 --requirement");
  if (args.requirement.length < 5) {
    throw new UsageError("--requirement 太短（至少 5 个字），无法据此创作");
  }
  if (args.materials.length === 0) {
    throw new UsageError("缺少必填参数 --materials（至少一张图片）");
  }
  return args;
}

// ---------------------------------------------------------------------------
// 进度文件（前端轮询用，与 cli-status 路由约定一致）
// ---------------------------------------------------------------------------

type Stage =
  | "normalizing"
  | "vision"
  | "narration"
  | "tts"
  | "storyboard"
  | "rendering"
  | "done"
  | "failed";

const STAGE_LABELS: Record<Stage, string> = {
  normalizing: "正在整理素材…",
  vision: "正在识别图片内容…",
  narration: "正在撰写旁白文案…",
  tts: "正在合成配音…",
  storyboard: "正在规划分镜…",
  rendering: "正在渲染画面…",
  done: "已完成",
  failed: "失败",
};

/** 每个阶段的完成度百分比（用于前端进度条）。 */
const STAGE_PERCENT: Record<Stage, number> = {
  normalizing: 5,
  vision: 15,
  narration: 30,
  tts: 45,
  storyboard: 60,
  rendering: 90,
  done: 100,
  failed: 100,
};

class ProgressWriter {
  private lastWrite = 0;
  private lastKey = "";
  private isFirstWrite = true;

  constructor(
    private readonly workDir: string,
    private readonly token: string,
    /** 平台用户 id：另外写一份「该用户最新一次出片进度」，前端不用知道 token 也能看到进度。 */
    private readonly userId: string,
    /** 归属会话（可选）：带上之后进度只在该会话里展示。 */
    private readonly conversationId?: string
  ) {
    mkdirSync(workDir, { recursive: true });
  }

  /**
   * 写进度。节流 500ms —— 渲染阶段回调很密，高频写盘会拖慢主流程。
   * 同 stage + 同文案的重复调用会被丢弃。
   */
  write(stage: Stage, message?: string, terminal = false): void {
    const now = Date.now();
    const text = message ?? STAGE_LABELS[stage];
    const key = `${stage}|${text}`;
    if (key === this.lastKey && now - this.lastWrite < 500 && !terminal) return;
    this.lastKey = key;
    this.lastWrite = now;
    const payload = {
      token: this.token,
      stage,
      percent: STAGE_PERCENT[stage],
      message: text,
      updatedAt: new Date(now).toISOString(),
      terminal,
    };
    try {
      writeFileSync(
        join(this.workDir, "progress.json"),
        `${JSON.stringify(payload, null, 2)}\n`,
        "utf8"
      );
    } catch {
      // 进度写盘失败不影响出片，静默跳过（前端只会看到进度停住）。
    }
    // 再落一份「按用户的最新进度」。agent 用 bash 跑本脚本时平台拿不到 token
    // （token 是这里随机生成的），会话里就只能看到一个「思考中」转圈十几分钟。
    // /api/conversations/<id>/video-progress 读这个文件，按登录用户取值。
    if (this.userId) {
      writeVideoProgress({
        userId: this.userId,
        conversationId: this.conversationId ?? null,
        kind: "generate",
        stage,
        percent: payload.percent,
        message: text,
        token: this.token,
        terminal,
        start: this.isFirstWrite
      });
      this.isFirstWrite = false;
    }
  }
}

/** 把 pipeline 的 onProgress 文案映射到阶段枚举。 */
function stageOf(text: string): Stage {
  if (/识别|识图|vision/i.test(text)) return "vision";
  if (/旁白|文案|写作/i.test(text)) return "narration";
  if (/配音|语音|TTS|tts/i.test(text)) return "tts";
  if (/分镜|storyboard/i.test(text)) return "storyboard";
  if (/渲染|画面|render/i.test(text)) return "rendering";
  return "normalizing";
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** stdout 只写一行 JSON —— 这是与 OpenClaw 的协议，日志一律走 stderr。 */
function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 素材存在性校验：路径由 OpenClaw 传入，可能拼错或指向已清理的文件。
  // 早失败比跑到一半再报错体验好得多。
  const materials: string[] = [];
  for (const raw of args.materials) {
    if (!existsSync(raw)) throw new UsageError(`素材文件不存在：${raw}`);
    materials.push(raw);
  }

  // 预检该用户是否配齐了必要能力：缺配置时立刻给出可操作错误，
  // 而不是跑 30 秒后才在配音阶段失败。
  // 只预检 chat（旁白）与 storyboard（分镜）—— 这两项缺失会直接让规划失败；
  // vision/tts 缺失时有降级路径（轮播 / 本机 TTS），不该在这里拦。
  for (const capability of ["chat", "storyboard"] as const) {
    try {
      await resolveCapabilityConfig(args.userId, capability);
    } catch (error) {
      if (error instanceof ModelConfigError) {
        throw new UsageError(
          `${error.message}（该用户的「${capability === "chat" ? "对话与写作" : "分镜规划"}」模型未配置，` +
            `请在平台「系统配置 → 默认模型分配」中设置）`
        );
      }
      throw error;
    }
  }

  const token = args.token ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const workDir = join(process.cwd(), "public", "uploads", "gen-video-work", token);
  const progress = new ProgressWriter(workDir, token, args.userId, args.conversationId);

  const baseInput = {
    mode: "generate" as const,
    token,
    materials,
    requirement: args.requirement,
    targetSeconds: args.targetSeconds ?? parseTargetSeconds(args.requirement, 20),
    userId: args.userId,
    theme: args.theme,
    look: args.look,
    workDir,
    ttsProvider: args.ttsProvider as never,
    onProgress: (text: string) => progress.write(stageOf(text), text),
  };

  // ---- 规划阶段：识图 → 风格 → 旁白 → 配音 → DSH 分镜 ----
  progress.write("normalizing", "正在整理素材…");
  const plan = await runVideoPlanStage(baseInput);
  if (!plan.ok) {
    progress.write("failed", plan.error, true);
    emit({ ok: false, error: plan.error, token });
    // 业务失败也走 exit 0：OpenClaw 读 JSON 判断，不需要靠 exit code 区分。
    return;
  }
  const draft: VideoPlanDraft = plan.draft;
  progress.write("storyboard", `分镜已规划（${draft.summary.scenes.length} 个镜头）`);

  // ---- 方案确认：默认不跳过，由 OpenClaw 转述方案给用户 ----
  // --skip-plan 表示用户已在对话里确认过，直接渲染。
  // 注意：这里**不落库 VideoPlan** —— 落库由 from-cli 接口在产物回收时统一做，
  // 保持「CLI 无数据库写权限」的边界。
  if (!args.skipPlan) {
    progress.write("done", "方案已生成，等待用户确认", true);
    emit({
      ok: true,
      needsConfirmation: true,
      token,
      title: draft.title,
      theme: draft.theme,
      themeLabel: draft.summary.themeLabel,
      themeReason: draft.themeReason,
      captionStyle: draft.captionStyle,
      durationSeconds: draft.totalSeconds,
      audioSeconds: draft.audioSeconds,
      narration: draft.narration,
      scenes: draft.summary.scenes.map((s) => ({
        id: s.id,
        start: Number(s.startSeconds.toFixed(2)),
        end: Number(s.outSeconds.toFixed(2)),
        images: s.imageIndexes,
        motion: s.motion,
        overlays: s.overlays.filter((o) => o.text).map((o) => o.text),
      })),
      effects: draft.summary.effects,
      storyboardFallback: draft.diagnostics.storyboardFallback,
      hint:
        "这是视频方案，尚未开始渲染。请把方案自然地转述给用户并询问是否开始生成；" +
        "用户确认后，重新执行同一条命令并追加 --skip-plan。",
    });
    return;
  }

  // ---- 渲染阶段：Remotion + ffmpeg（复用 runVideoPipeline + resume 跳过规划） ----
  progress.write("rendering", "用户已确认，开始渲染…");
  const result: PipelineResult = await runVideoPipeline({
    ...baseInput,
    resume: draft,
  });
  if (!result.ok) {
    progress.write("failed", result.error ?? "渲染失败", true);
    emit({ ok: false, error: result.error ?? "渲染失败。", token });
    return;
  }

  progress.write("done", "视频生成完成", true);
  emit({
    ok: true,
    token,
    title: result.title,
    videoPath: result.videoUrl ?? null,
    coverPath: result.coverUrl ?? null,
    durationSeconds: result.diagnostics?.narrationSeconds ?? 0,
    narration: result.narration,
    sceneCount: draft.summary.scenes.length,
  });
}

main().catch((error) => {
  if (error instanceof UsageError) {
    emit({ ok: false, error: `参数错误：${error.message}` });
    process.exitCode = 1;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[aiworker-video] 运行失败：${message}`);
  if (error instanceof Error && error.stack) console.error(error.stack);
  emit({ ok: false, error: message });
  process.exitCode = 2;
});
