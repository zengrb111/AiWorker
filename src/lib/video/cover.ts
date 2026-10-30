/**
 * 视频封面：从成片里截一帧 + 把标题用黄色粗体压在画面正中。
 *
 * 为什么要有这个模块（而不是继续用 `extractVideoPoster` 抽一帧）：
 * - 内容库列表里视频条目只显示一张 16:9/9:16 的静帧，观众看不出主题；
 * - 截图里叠一句黄色大标题，列表里一眼能读懂「这条片子讲什么」，也符合短视频封面的惯例。
 *
 * 两条链路共用：
 * 1. 「一键生成视频」出片完成后自动生成一版（`huashu-generate.ts`）；
 * 2. 内容详情页点「重新生成」手动换一版（每次换截图位置 + 换标题角度）。
 *
 * 失败策略：任何一步（ffprobe / AI 标题 / drawtext）失败都退化成「抽一帧不带字」，
 * 绝不让封面生成把出片主流程带崩。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDuration } from "@/lib/ffmpeg";
import { chatComplete } from "@/lib/llm-client";
import { extractVideoPoster, localVideoPath } from "./poster";

const COVER_DIR = join(process.cwd(), "public", "uploads", "covers");

/** 截图位置（占全片时长的比例）。按 variant 轮换，保证每次「换一版」不会截到同一帧。 */
const SHOT_RATIOS = [0.1, 0.22, 0.34, 0.46, 0.58, 0.7, 0.82, 0.94];

/** 中文字体：优先微软雅黑粗体（Windows 自带），再退黑体，最后苹方（macOS）。 */
const FONT_CANDIDATES = [
  "C:/Windows/Fonts/msyhbd.ttc",
  "C:/Windows/Fonts/msyh.ttc",
  "C:/Windows/Fonts/simhei.ttf",
  "/System/Library/Fonts/PingFang.ttc"
];

/** 封面成图宽度（竖版视频原样 1080 宽；横版按宽度缩到 1080，高度自动）。 */
const COVER_WIDTH = 1080;
/**
 * 每行最多几个字。
 *
 * 跟字号绑死：156px 字号下 6 个字约 936px，两侧各留 70 多 px；
 * 7 个就 1092px 顶破画面了。**改字号必须同步改这个数**。
 */
const MAX_CHARS_PER_LINE = 6;

export type VideoCoverInput = {
  videoUrl: string;
  /** 调 AI 写标题要用（按用户解析模型配置） */
  userId: string;
  /** 文件名前缀，不含扩展名 */
  name: string;
  /** 写标题的素材：内容标题 + 正文 */
  title?: string | null;
  body?: string | null;
  /** 第几版。决定截图位置与标题角度；不传按 0 算。 */
  variant?: number;
};

export type VideoCoverResult = {
  url: string;
  /** 实际画上去的标题（已换行） */
  title: string;
  variant: number;
  atSeconds: number;
};

/** 从封面 URL 里读出版本号（`...-c3.jpg` → 3）；不是这个命名规则返回 null。 */
export function coverVariantOf(url: string | null | undefined): number | null {
  const hit = /-c(\d+)\.jpg$/i.exec(url || "");
  return hit ? Number(hit[1]) : null;
}

/** 生成一版封面。成功返回 { url, title }；连截图都拿不到时返回 null。 */
export async function generateVideoCover(input: VideoCoverInput): Promise<VideoCoverResult | null> {
  const source = localVideoPath(input.videoUrl);
  if (!source || !existsSync(source)) return null;

  const variant = Number.isFinite(input.variant) ? Math.max(0, Math.floor(input.variant as number)) : 0;
  const duration = (await probeDuration(source)) ?? 0;
  const ratio = SHOT_RATIOS[variant % SHOT_RATIOS.length];
  // 至少留 0.3s，避免拖到片尾黑帧
  const atSeconds = duration > 1 ? Math.min(Math.max(0.3, duration * ratio), duration - 0.3) : 0.5;

  const safeName = input.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const fileName = `${safeName}-c${variant}.jpg`;
  const target = join(COVER_DIR, fileName);

  const material = [input.title, input.body].filter((part) => !!part && !!part.trim()).join("\n");
  const rawTitle = (await writeTitle(input.userId, material, variant)) || fallbackTitle(material, variant);
  const title = wrapTitle(rawTitle);

  try {
    await mkdir(COVER_DIR, { recursive: true });
    await renderFrameWithTitle(source, atSeconds, title, target);
    return { url: `/uploads/covers/${fileName}`, title, variant, atSeconds };
  } catch (error) {
    // drawtext 挂了（字体缺失/滤镜不支持）：退化成无水印抽帧，至少别让封面空着。
    // 打一行日志，别让「字没压上」变成无声故障（这次就踩过：转义写错被静默降级）。
    console.warn(
      `[video-cover] 压标题失败，退化为纯抽帧：${error instanceof Error ? error.message : String(error)}`
    );
    const poster = await extractVideoPoster(input.videoUrl, `${safeName}-c${variant}`);
    if (!poster) return null;
    return { url: poster, title, variant, atSeconds };
  }
}

/**
 * 调模型写一句封面标题。
 *
 * 刻意不写「请生成标题」这种开放式指令：模型很容易输出「标题：xxx」或带书名号的整句。
 * 这里给的是窄任务 + 硬约束（字数/标点/不解释），并自行清洗返回值。
 */
async function writeTitle(userId: string, material: string, variant: number): Promise<string> {
  const text = material.replace(/\s+/g, " ").trim().slice(0, 1200);
  if (!text) return "";
  try {
    const { content } = await chatComplete({
      userId,
      temperature: variant === 0 ? 0.8 : 1.05,
      maxTokens: 64,
      timeoutMs: 25_000,
      messages: [
        {
          role: "system",
          content:
            "你是短视频封面文案。只输出标题本身：简体中文，8~12 个字，口语化、有画面感，" +
            "抓住配文里最打动人的一个点。不要引号、不要书名号、不要标点结尾、不要 emoji、不要解释。"
        },
        {
          role: "user",
          content:
            `配文：\n${text}\n\n` +
            (variant > 0 ? `这是第 ${variant + 1} 版，请换一个完全不同的角度和措辞。\n` : "") +
            "直接给标题："
        }
      ]
    });
    return sanitizeTitle(content);
  } catch {
    return "";
  }
}

/** 清洗模型输出：去掉「标题：」「《》」引号、换行、结尾标点，并限长。 */
function sanitizeTitle(raw: string): string {
  let text = (raw || "").trim();
  text = text.split("\n").map((line) => line.trim()).filter(Boolean)[0] || "";
  text = text.replace(/^(封面标题|标题|文案)[:：]\s*/, "");
  text = text.replace(/^[「『《"'“”‘’]+|[」』》"'“”‘’]+$/g, "");
  text = text.replace(/[。！？!?；;，,、\s]+$/g, "");
  text = text.replace(/[*#`>_~]/g, "");
  const chars = Array.from(text);
  if (chars.length > 16) text = chars.slice(0, 16).join("");
  return text.trim();
}

/**
 * 兜底标题：模型不可用时从素材里挑一句。
 *
 * 按标点切句 → 优先挑 5~14 字、含实义的一句；一句都没有就把标题截断。
 * 用 variant 轮换，保证「换一版」时标题也确实不一样。
 */
function fallbackTitle(material: string, variant = 0): string {
  const plain = material.replace(/[*#`>_~]/g, " ").replace(/\s+/g, " ").trim();
  if (!plain) return "精彩片段";
  const clauses = plain
    .split(/[。！？；：\n]|——|--|、|，/)
    .map((part) => part.trim())
    .filter((part) => {
      const len = Array.from(part).length;
      return len >= 5 && len <= 14;
    });
  if (clauses.length) return clauses[variant % clauses.length];
  const chars = Array.from(plain);
  return chars.slice(0, 12).join("") || "精彩片段";
}

/** 标题按字数折行：≤8 字一行；9~16 字对半分成两行（避免出现「8 个字 + 1 个字」的孤字）；超出截断。 */
function wrapTitle(title: string, maxChars = MAX_CHARS_PER_LINE): string {
  const chars = Array.from(title.trim());
  if (!chars.length) return "精彩片段";
  if (chars.length <= maxChars) return chars.join("");
  if (chars.length <= maxChars * 2) {
    const half = Math.ceil(chars.length / 2);
    return `${chars.slice(0, half).join("")}\n${chars.slice(half).join("")}`;
  }
  return `${chars.slice(0, maxChars).join("")}\n${chars.slice(maxChars, maxChars * 2 - 1).join("")}…`;
}

/**
 * ffmpeg 滤镜参数里的路径值。
 *
 * 只把 `:` 转义成 `\:` 是**不够**的（实测 ffmpeg 8.1 直接报
 * `No option name near '/Windows/Fonts/...'`，滤镜图解析失败）：值必须用单引号包起来，
 * 引号内再转义 `:`。`drawtext=fontfile='C\:/Windows/Fonts/msyhbd.ttc'` 才通过。
 */
function escapeFilterValue(value: string): string {
  const escaped = value
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
  return `'${escaped}'`;
}

function pickFont(): string | null {
  return FONT_CANDIDATES.find((file) => existsSync(file)) ?? null;
}

/**
 * 抽一帧 + 压标题，产出 jpg。
 *
 * drawtext 用 `textfile` 传标题（不拼 `text=`），这样中文、换行、标点都不需要再转义；
 * 描边 + 阴影是为了让黄字压在任何画面上都读得清（亮背景上尤其明显）。
 */
async function renderFrameWithTitle(
  source: string,
  atSeconds: number,
  title: string,
  target: string
): Promise<void> {
  const font = pickFont();
  const filters = [`scale=${COVER_WIDTH}:-2`];

  if (font && title.trim()) {
    const textFile = join(tmpdir(), `om-cover-title-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    await writeFile(textFile, title, "utf8");
    try {
      filters.push(
        [
          "drawtext=fontfile=" + escapeFilterValue(font),
          "textfile=" + escapeFilterValue(textFile),
          "fontcolor=0xFFD400",
          "fontsize=156",
          "line_spacing=45",
          // 多行标题必须显式居中：drawtext 默认按左对齐排多行，
          // 只靠 x=(w-text_w)/2 只会把「整块」居中，长短不一的第二行看起来是歪的。
          "text_align=center",
          "borderw=18",
          "bordercolor=black@0.62",
          "shadowx=0",
          "shadowy=10",
          "shadowcolor=black@0.35",
          "x=(w-text_w)/2",
          "y=(h-text_h)/2"
        ].join(":")
      );
      await runFfmpeg(source, atSeconds, filters.join(","), target);
    } finally {
      await rm(textFile, { force: true }).catch(() => undefined);
    }
    return;
  }

  await runFfmpeg(source, atSeconds, filters.join(","), target);
}

function runFfmpeg(source: string, atSeconds: number, vf: string, target: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const args = [
      "-y",
      "-v",
      "error",
      "-ss",
      atSeconds.toFixed(2),
      "-i",
      source,
      "-frames:v",
      "1",
      "-vf",
      vf,
      "-q:v",
      "3",
      target
    ];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`封面截图失败（ffmpeg exit ${code}）：${stderr.trim().slice(0, 300)}`));
    });
  });
}
