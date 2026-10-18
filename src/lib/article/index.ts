/**
 * 「文章转视频」编排门面。
 *
 * 一句话：把一篇文章变成「可直接进管线的素材 + 一段讲清素材的创作要求」。
 * 上层（面板路由 / CLI）只需要调这一个函数，其余链路完全复用既有的视频管线。
 *
 * 流程（每一步都通过 onProgress 如实上报，用户能看到卡在哪）：
 *   1. 文章理解（1 次 LLM）      → 摘要 / 要点 / 数据点 / 图表方案
 *   2. 溯源闸门（纯程序）         → 编造的数字不许出现在画面上
 *   3. 按需联网（0 或 1 次搜索）  → 文章数据确实不够时才补
 *   4. 绘制图表（canvas）         → 6 类 1080×1920 PNG
 *   5. 下载原文配图（可选）
 *   6. 组装 requirement          → 让旁白与分镜知道「有几张图、每张是什么」
 *
 * 不 import prisma：本文件必须能被 scripts/aiworker-video.mts 安全复用。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedModelConfig } from "../model-credentials";
import { ARTICLE_CHART_KIND_LABELS, type ArticlePlanExtension } from "./types";
import type { ArticleSource } from "../article-source";
import { buildArticleAnalysis, verifyChartSpecs, type SearchEvidence } from "./analyze";
import { supplementFromSearch } from "./search-supplement";
import { renderCharts } from "./chart-render";
import type { InjectableChart } from "../video/chart-overlays";
import { generateArticleNarration } from "../narration";

/** generate 模式的素材前缀，与 pipeline MODE_SPEC.generate.prefix 保持一致。 */
const WORK_PREFIX = "gen-video";
const MAX_INLINE_IMAGES = 3;
/** vision 对小于 512 字节的图片直接判失败，低于 1KB 的下载也没意义，直接丢。 */
const MIN_IMAGE_BYTES = 1024;

export type ArticleVideoAssets = {
  /** 组装好的创作要求，会同时喂给旁白生成与 DSH 分镜。 */
  requirement: string;
  /** 作为「文案依据」传给旁白生成 —— 创作要求只说怎么做，不含讲什么。 */
  newsItems: Array<{ title: string; snippet: string; isPrimary: boolean }>;
  /** 图表 PNG 在前、原文配图在后 —— 顺序很重要，见 buildRequirement 的说明。 */
  materials: string[];
  extension: ArticlePlanExtension;
  /**
   * 图表的**结构化数据**（已过溯源闸门）。
   *
   * 为什么必须往管线里再传一份：`extension.charts` 只有 PNG 路径与人话摘要，
   * 渲染层拿不到 items/series，只能把图表当静态图片用。
   * 这一份才是喂给 Remotion 原生图表图层的输入（见 video/chart-overlays.ts）。
   */
  chartSpecs: InjectableChart[];
  /**
   * 基于**文章原文**生成的旁白与标题（可为 null）。
   *
   * 有了它，管线就不会再走 `generateNarrationScript` 那条「只看二手摘要」的路径 ——
   * 那是「对文章理解不精准」的直接原因（见 generateArticleNarration 的注释）。
   * 为 null 时管线自动退回原路径，出片不受影响。
   */
  narrationText: string | null;
  videoTitle: string;
  /** 素材目录（= token 工作目录），渲染阶段靠它找到配音。 */
  workDir: string;
};

export function articleWorkDir(token: string): string {
  return join(process.cwd(), "public", "uploads", `${WORK_PREFIX}-work`, token);
}

/**
 * 组装创作要求。
 *
 * 这里必须写清「第 1..N 张是数据图表」：当用户没配 vision 模型时，管线不会识图，
 * 分镜会退化成按素材顺序轮播。不点名的话，轮播顺序和旁白内容就可能对不上。
 */
function buildRequirement(input: {
  article: ArticleSource;
  analysis: { title: string; summary: string; keyPoints: string[] };
  charts: ArticlePlanExtension["charts"];
  imageCount: number;
  targetSeconds: number;
  extra?: string;
}): string {
  const { article, analysis, charts, imageCount, targetSeconds } = input;
  const chartLines = charts.length
    ? charts
        .map((chart, index) => {
          const kind = ARTICLE_CHART_KIND_LABELS[chart.kind] ?? chart.kind;
          const suffix = chart.downgraded ? "（数据未通过溯源校验，此图不含数值）" : "";
          return `第${index + 1}张：${kind}「${chart.title}」${chart.dataSummary ? ` · ${chart.dataSummary}` : ""}${suffix}`;
        })
        .join("\n")
    : "（本次没有生成图表）";

  return [
    `把下面这篇文章做成一条竖屏口播短视频，目标口播 ${targetSeconds} 秒左右讲清核心。`,
    "",
    `文章标题：${analysis.title}`,
    `文章来源：${article.sourceUrl ?? article.originLabel}`,
    analysis.summary ? `内容摘要：${analysis.summary}` : "",
    "",
    "必须讲到的要点：",
    analysis.keyPoints.length ? analysis.keyPoints.map((point, i) => `${i + 1}. ${point}`).join("\n") : "（无）",
    "",
    `【素材说明】共 ${charts.length + imageCount} 张图片，其中前 ${charts.length} 张是程序绘制的数据图表，依次是：`,
    chartLines,
    imageCount > 0 ? `其余 ${imageCount} 张是文章原文配图，作为辅助画面。` : "",
    "",
    "【硬性要求】",
    "1. 旁白只讲文章里的内容，不要引入任何外部信息，也不要复述图表标题。",
    "2. 图上的数字都已核实过，可以照着念；原文没有的数字绝对不许出现在旁白里。",
    "3. 优先把数据图表用在提到对应数字的那句旁白上，不要让同一张图连续出现两次。",
    "4. 语气像真人讲给朋友听，不要播音腔，不要开场套话。",
    input.extra ? `\n【用户额外要求】\n${input.extra}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** 下载原文配图到本地。远端直链不能直接进 materials —— normalizeMaterials 会 existsSync 过滤掉。 */
async function downloadInlineImages(
  urls: string[],
  outDir: string
): Promise<{ saved: string[]; failed: number }> {
  const saved: string[] = [];
  let failed = 0;
  await mkdir(outDir, { recursive: true });

  for (const [index, url] of urls.slice(0, MAX_INLINE_IMAGES).entries()) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AiWorker/1.0)", Referer: url },
      });
      clearTimeout(timer);
      if (!res.ok) {
        failed += 1;
        continue;
      }
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      if (!contentType.startsWith("image/")) {
        failed += 1;
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength < MIN_IMAGE_BYTES || buffer.byteLength > 12 * 1024 * 1024) {
        failed += 1;
        continue;
      }
      const extension = contentType.includes("png") ? ".png" : contentType.includes("webp") ? ".webp" : ".jpg";
      const target = join(outDir, `article-${index}${extension}`);
      await writeFile(target, buffer);
      saved.push(target);
    } catch {
      failed += 1;
    }
  }

  return { saved, failed };
}

export async function buildArticleVideoAssets(input: {
  userId: string;
  token: string;
  article: ArticleSource;
  targetSeconds: number;
  requirement?: string;
  themeKey?: string;
  allowSearch: boolean;
  /** 用户能力配置的一次性快照，避免长任务期间配置变更导致前后不一致。 */
  config: ResolvedModelConfig;
  /**
   * 「联网搜索」能力的配置。为 null 表示用户还没配搜索服务 —— 此时不搜索，
   * 因为 searchWeb 会退到内置热榜，对补文章数据毫无用处。
   */
  searchConfig?: ResolvedModelConfig | null;
  onProgress?: (text: string) => void;
}): Promise<ArticleVideoAssets> {
  const notify = input.onProgress ?? (() => undefined);
  const notices: string[] = [];
  const workDir = articleWorkDir(input.token);

  notify("正在理解文章内容…");
  const analysis = await buildArticleAnalysis({
    userId: input.userId,
    config: input.config,
    article: input.article,
    targetSeconds: input.targetSeconds,
    requirement: input.requirement,
  });
  notices.push(...analysis.notices);

  let dataPoints = analysis.dataPoints;
  let evidence: SearchEvidence = [];
  let searchUsed = false;
  let dataGaps = analysis.dataGaps;

  // 只在「文章确实缺数据」且「用户允许联网」时才搜，且全程只搜一次。
  const needsSearch = input.allowSearch && (dataGaps.length > 0 || dataPoints.length < 3);
  // 取成局部常量，TS 才能把「非空」这个条件传递到下面的分支里。
  const searchConfig = input.searchConfig ?? null;
  if (needsSearch && searchConfig) {
    notify("正在联网补充数据…");
    const result = await supplementFromSearch({
      userId: input.userId,
      config: searchConfig,
      topic: analysis.title,
      gaps: dataGaps.length ? dataGaps : [`${analysis.title}的关键数据`],
    });
    if (result.ok) {
      searchUsed = true;
      evidence = result.evidence;
      dataPoints = [...dataPoints, ...result.dataPoints];
      if (result.reason) notices.push(result.reason);
      // 搜到了数据就把「缺口」清掉：已补齐的缺口不该继续显示为缺失。
      dataGaps = dataPoints.length >= 3 ? [] : dataGaps;
    } else {
      notices.push(result.reason);
    }
  } else if (needsSearch) {
    // needsSearch 为真却落到这里，说明 searchConfig 为空。
    // 没有联网搜索服务时 searchWeb 会退到内置热榜 —— 那是热点新闻榜，对
    // 「补这篇文章的数据」毫无帮助，只会白等一次网络往返。直接说清原因。
    notices.push(
      "文章里的数据不够，但你尚未配置联网搜索服务，本次没有联网补充" +
        "（如需补充，请在「系统配置」里为「联网搜索」添加 Tavily 或博查）。"
    );
  } else if (!input.allowSearch && dataGaps.length > 0) {
    notices.push(`有 ${dataGaps.length} 处数据文章里没写清楚，未联网搜索，仅使用文章原有数据。`);
  } else if (input.allowSearch) {
    notices.push("文章里的数据已经够用，没有触发联网搜索。");
  }

  notify("正在核实每个数字的出处…");
  const verified = verifyChartSpecs({
    charts: analysis.charts,
    dataPoints,
    articleText: input.article.text,
    evidence,
  });
  notices.push(...verified.notices);

  notify("正在绘制数据图表…");
  const chartsOutDir = join(workDir, "charts");
  const rendered = await renderCharts({
    charts: verified.charts,
    themeKey: input.themeKey,
    outDir: chartsOutDir,
    webBase: `/uploads/${WORK_PREFIX}-work/${input.token}/charts`,
    sourceLabel: input.article.originLabel,
  });
  notices.push(...rendered.notices);

  // 原文配图下载失败只记一条告警，不阻断 —— 它只是补充画面。
  let inlineImages: string[] = [];
  if (input.article.rawImages.length) {
    const refsDir = join(workDir, "article-refs");
    const downloaded = await downloadInlineImages(input.article.rawImages, refsDir);
    inlineImages = downloaded.saved;
    if (downloaded.failed > 0) {
      notices.push(`有 ${downloaded.failed} 张原文配图下载失败，已跳过。`);
    }
  }

  const charts: ArticlePlanExtension["charts"] = rendered.charts.map((chart) => ({
    id: chart.id,
    kind: chart.kind,
    title: chart.title,
    imagePath: chart.imagePath,
    webPath: chart.webPath,
    dataSummary: chart.dataSummary,
    sourceRefs: chart.sourceRefs,
    verified: chart.verified,
    downgraded: chart.downgraded,
    downgradeReason: chart.downgradeReason,
  }));

  if (!charts.length) {
    notices.push("文章里没有可用的数据，已直接交给旁白模型按文章内容自由发挥。");
  }

  // 结构化图表数据（已溯源）交给管线；PNG 仍作为素材保留 —— 两者不是二选一：
  // PNG 是「截图级」的兜底画面，结构化数据是「动态图表」的素材。
  const chartSpecs: InjectableChart[] = verified.charts.map((chart) => ({
    id: chart.id,
    kind: chart.kind,
    title: chart.title,
    payload: chart.payload as unknown as Record<string, unknown>,
    downgraded: chart.downgraded,
  }));

  /*
   * 旁白：直接读原文写。
   *
   * 放在图表绘制之后，这样旁白 prompt 里能带上「哪些数字是核实过的」，
   * 写出来的句子会主动去念这些数字，和画面上的图表对得上。
   *
   * 失败**不阻断**：返回 null，管线会自动退回 generateNarrationScript
   * （只看摘要那条老路），行为与改造前完全一致。
   */
  notify("正在根据文章原文撰写解说词…");
  let narrationText: string | null = null;
  let videoTitle = "";
  try {
    const script = await generateArticleNarration({
      articleText: input.article.text,
      title: analysis.title,
      summary: analysis.summary,
      keyPoints: analysis.keyPoints,
      chartLines: charts.map(
        (chart) =>
          `${chart.title}${chart.dataSummary ? ` · ${chart.dataSummary}` : ""}` +
          `${chart.downgraded ? "（数据未通过溯源校验，此图不含数值）" : ""}`
      ),
      targetSeconds: input.targetSeconds,
      requirement: input.requirement,
      userId: input.userId,
    });
    if (script) {
      narrationText = script.fullText;
      videoTitle = script.title;
      notify(`解说词已就绪（${script.segments.length} 句）`);
    } else {
      notices.push("未能根据原文生成解说词，已退回按摘要创作。");
    }
  } catch (error) {
    notices.push(`根据原文生成解说词失败（${(error as Error).message}），已退回按摘要创作。`);
  }

  const requirement = buildRequirement({
    article: input.article,
    analysis,
    charts,
    imageCount: inlineImages.length,
    targetSeconds: input.targetSeconds,
    extra: input.requirement,
  });

  return {
    requirement,
    newsItems: [
      {
        title: analysis.title,
        snippet: [analysis.summary, ...analysis.keyPoints].filter(Boolean).join(" "),
        isPrimary: true,
      },
    ],
    // 顺序即优先级：图表必须在最前，否则 vision 未配置时轮播会先播原文配图。
    materials: [...charts.map((chart) => chart.imagePath), ...inlineImages],
    chartSpecs,
    narrationText,
    videoTitle,
    extension: {
      sourceType: input.article.origin,
      sourceLabel: input.article.originLabel,
      sourceUrl: input.article.sourceUrl,
      title: analysis.title,
      summary: analysis.summary,
      keyPoints: analysis.keyPoints,
      charts,
      searchUsed,
      dataGaps,
      notices,
    },
    workDir,
  };
}