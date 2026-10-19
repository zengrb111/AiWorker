/**
 * 文章转视频 —— **规划阶段**（只出方案，不渲染）。
 *
 * 与「一键生成视频」的规划路由（gen-video/plan）结构一致，差别只在素材怎么来：
 * 那边是用户上传的图片，这边是「一篇文章」。文章先被理解、抽数据、画成图表 PNG，
 * 然后**把图表 PNG 当作普通图片素材**塞进同一条管线。
 *
 * 为什么不新建出片路由：gen-video 已经实现了「带 planToken → 查 VideoPlan →
 * resume 渲染」，第二阶段直接复用，本文件只负责产出方案与落库。
 *
 * 耗时构成（用户会等 1~2 分钟，与既有规划阶段同量级）：
 *   理解文章 1 次 LLM → 溯源校验（纯程序，毫秒级）→ 联网补充 0/1 次 →
 *   画图表 4~6 张 canvas → 之后的配音与分镜由管线完成。
 */
import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { DEFAULT_TTS_PROVIDER, resolveTtsProvider } from "@/lib/tts";
import {
  ModelConfigError,
  snapshotUserConfig,
  type ResolvedModelConfig,
} from "@/lib/model-credentials";
import {
  parseTargetSeconds,
  runVideoPlanStage,
  type VideoPlanDraft,
} from "@/lib/video/pipeline";
import { LOOK_OPTIONS, parseLookFromForm } from "@/lib/video/plan-params";
import { buildStoryChrome } from "@/lib/video/chart-overlays";
import {
  ARTICLE_DOCUMENT_EXTENSIONS,
  ArticleSourceError,
  articleFromText,
  articleFromUpload,
  articleFromUrl,
  type ArticleSource,
} from "@/lib/article-source";
import { FetchPageError } from "@/lib/fetch-web-page";
import { buildArticleVideoAssets } from "@/lib/article";
import { ARTICLE_CHART_KIND_LABELS } from "@/lib/article/types";
import { echoPlanToConversation } from "@/lib/video/plan-echo";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

export const runtime = "nodejs";

/** SSE 事件编码：`data: {...}\n\n`，与项目其他流式路由保持一致。 */
function sseEncode(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

/** 规划阶段心跳间隔：文章理解 / 配音 / DSH 分镜可能几十秒没有新事件，靠 ping 保活。 */
const PLAN_HEARTBEAT_MS = 15_000;

type SourceType = "url" | "document" | "paste";

/** 组装给前端的方案摘要。图表清单要能看出「每张图画了什么、数据哪来的」。 */
function toPlanResponse(draft: VideoPlanDraft, planToken: string) {
  return {
    planToken,
    requirement: draft.article ? draft.article.title : draft.title,
    title: draft.title,
    narration: draft.narration,
    theme: draft.theme,
    themeReason: draft.themeReason,
    captionStyle: draft.captionStyle,
    summary: draft.summary,
    insights: draft.insights
      .filter((insight) => insight.caption)
      .map((insight, index) => ({
        index: index + 1,
        caption: insight.caption,
        mood: insight.mood,
        subject: insight.subject,
        dominantColor: insight.dominantColor,
      })),
    audioSeconds: draft.audioSeconds,
    diagnostics: draft.diagnostics,
    /**
     * 文案依据。文章转视频这里放的是「文章标题 + 摘要 + 要点」合成的一条，
     * 让方案面板能告诉用户「这份旁白到底基于什么」——
     * 缺这个字段前端会直接崩（方案面板要渲染 newsItems.length）。
     */
    newsItems: draft.newsItems ?? [],
    options: LOOK_OPTIONS,
    article: draft.article
      ? {
          ...draft.article,
          charts: draft.article.charts.map((chart) => ({
            ...chart,
            kindLabel: ARTICLE_CHART_KIND_LABELS[chart.kind] ?? chart.kind,
          })),
        }
      : null,
  };
}

/** 三种来源统一在这里解析，对外只抛可展示的中文错误。 */
async function resolveArticle(form: FormData): Promise<ArticleSource> {
  const sourceType = String(form.get("sourceType") ?? "").trim() as SourceType;

  if (sourceType === "url") {
    const url = String(form.get("url") ?? "").trim();
    if (!url) throw new ArticleSourceError("请填写文章链接。");
    return articleFromUrl(url);
  }

  if (sourceType === "document") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new ArticleSourceError("请选择要上传的文档。");
    }
    const extension = extname(file.name).toLowerCase();
    if (!ARTICLE_DOCUMENT_EXTENSIONS.includes(extension)) {
      throw new ArticleSourceError(
        `不支持的文档格式「${extension || "未知"}」，请上传 docx / pdf / txt / md。`
      );
    }
    return articleFromUpload(Buffer.from(await file.arrayBuffer()), file.name);
  }

  if (sourceType === "paste") {
    const text = String(form.get("text") ?? "");
    if (!text.trim()) throw new ArticleSourceError("请粘贴文章正文。");
    return articleFromText(text);
  }

  throw new ArticleSourceError("请选择文章来源：文章链接 / 上传文档 / 粘贴正文。");
}

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const conversation = await prisma.conversation.findFirst({
    where: { id: context.params.id, userId: user.id },
  });
  if (!conversation) return jsonError("对话不存在。", 404);

  const form = await request.formData();

  // ---- 1. 先取模型配置快照 ----
  // 规划要跑 1~2 分钟，必须一次性拿全配置，不能中途再读（用户可能在别处改配置）。
  let snapshot: Record<string, ResolvedModelConfig | null>;
  try {
    snapshot = await snapshotUserConfig(user.id);
  } catch (error) {
    if (error instanceof ModelConfigError) {
      return jsonError(error.message, 400, { kind: error.kind, capability: error.capability });
    }
    throw error;
  }
  const chatConfig = snapshot.chat;
  if (!chatConfig) {
    return jsonError(
      "尚未配置「对话」所需的模型服务，请前往「系统配置」添加模型服务并填写 API Key。",
      400,
      { kind: "no_assignment", capability: "chat" }
    );
  }
  const searchConfig = snapshot.search ?? null;

  // ---- 2. 解析文章来源 ----
  let article: ArticleSource;
  try {
    article = await resolveArticle(form);
  } catch (error) {
    if (error instanceof FetchPageError || error instanceof ArticleSourceError) {
      return jsonError(error.message, 400);
    }
    return jsonError(
      `读取文章失败：${error instanceof Error ? error.message : "未知错误"}`,
      500
    );
  }

  const extraRequirement = String(form.get("requirement") ?? "").trim();
  const ttsProvider = resolveTtsProvider(form.get("ttsProvider"), DEFAULT_TTS_PROVIDER);
  const theme = String(form.get("theme") ?? "").trim() || undefined;
  const look = parseLookFromForm(form);
  const allowSearch = String(form.get("allowSearch") ?? "") === "1";
  // 文章转视频默认 10 秒（与一键生成视频一致）；创作要求里写了时长以要求为准。
  const targetSeconds = parseTargetSeconds(extraRequirement, 10);

  // token 同时是素材目录与配音目录的标识；渲染阶段必须复用同一个 token 才能找到配音。
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  // ---- 可选参考图：与文章图表一起作为画面素材 ----
  // 文章模式除了数据图表，也允许用户额外附几张参考图（氛围 / 封面 / 人物等）。
  // 存到同源 uploads 目录，渲染阶段直接作为 materials 读取。
  const refFiles = (form.getAll("image") || []).filter(
    (entry): entry is File => entry instanceof File && entry.size > 0
  );
  const refImagePaths: string[] = [];
  if (refFiles.length) {
    const refDir = join(process.cwd(), "public", "uploads", "gen-article-refs", token);
    await mkdir(refDir, { recursive: true });
    let saved = 0;
    for (const file of refFiles) {
      const extension = extname(file.name).toLowerCase();
      if (![".jpg", ".jpeg", ".png", ".webp"].includes(extension)) continue;
      if (file.size > 30 * 1024 * 1024) continue;
      const target = join(refDir, `ref-${saved}${extension}`);
      await writeFile(target, Buffer.from(await file.arrayBuffer()));
      refImagePaths.push(target);
      saved++;
    }
  }

  // ---- 3~5. 文章理解 → 图表 → 配音 → 分镜：全部放进 SSE 流里，边跑边推进展 ----
  // 规划要 1~2 分钟，改成流式后用户能在会话里看到「正在做什么」，而不是盯着灰按钮干等。
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sseEncode(event));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => send({ type: "ping" }), PLAN_HEARTBEAT_MS);
      try {
        // 首条进度：让会话里立刻出现「正在生成」，避免读文章阶段空等。
        send({ type: "progress", text: "已收到文章，正在理解内容、抽取数据并生成图表…" });
        // ---- 3. 文章 → 图表素材 + 创作要求 ----
        const assets = await buildArticleVideoAssets({
          userId: user.id,
          token,
          article,
          targetSeconds,
          requirement: extraRequirement,
          themeKey: theme,
          allowSearch,
          config: chatConfig,
          searchConfig,
          onProgress: (text) => send({ type: "progress", text }),
        });

        console.log(
          `[gen-article-video-plan ${token}] 图表 ${assets.extension.charts.length} 张` +
            `（已溯源 ${assets.extension.charts.filter((c) => c.verified).length}，` +
            `降级 ${assets.extension.charts.filter((c) => c.downgraded).length}）· ` +
            `素材 ${assets.materials.length} 个 · 联网 ${assets.extension.searchUsed ? "已用" : "未用"}`
        );

        // ---- 4. 交给既有管线做风格推断 / 旁白 / 配音 / 分镜 ----
        const stage = await runVideoPlanStage({
          mode: "generate",
          token,
          newsItems: assets.newsItems,
          // 图表 PNG + 可选参考图，一起作为画面素材
          materials: [...assets.materials, ...refImagePaths],
          requirement: assets.requirement,
          targetSeconds,
          userId: user.id,
          // 基于原文写的解说词（assets 内部已处理失败退回），给了管线就不会再走
          // generateNarrationScript 那条「只看二手摘要」的路径。
          ...(assets.narrationText ? { narrationText: assets.narrationText } : {}),
          ...(assets.videoTitle ? { title: assets.videoTitle } : {}),
          ttsProvider,
          theme,
          look,
          // 文章图表的结构化数据：管线会把它翻成 Remotion 原生动态图表图层。
          chartSpecs: assets.chartSpecs,
          // 常驻页面装饰：顶部彩条 + 文章标题页眉 + 来源页脚 + 进度线。
          storyChrome: buildStoryChrome({
            title: assets.extension.title,
            sourceLabel: assets.extension.sourceUrl ?? assets.extension.sourceLabel,
          }),
          workDir: assets.workDir,
          onProgress: (text) => send({ type: "progress", text }),
        });

        if (!stage.ok) {
          send({
            type: "error",
            error: stage.error,
            modelConfig: stage.modelConfig
              ? { kind: stage.modelConfig.kind, capability: stage.modelConfig.capability }
              : null,
          });
          return;
        }

        // ---- 5. 落库：文章扩展与规划结果存在同一份 draftJson 里 ----
        const draft: VideoPlanDraft = { ...stage.draft, article: assets.extension };
        await prisma.videoPlan.create({
          data: {
            token,
            userId: user.id,
            conversationId: conversation.id,
            status: "PLANNED",
            requirement: extraRequirement || assets.requirement.slice(0, 200),
            draftJson: JSON.stringify(draft),
            materialsJson: JSON.stringify([...assets.materials, ...refImagePaths]),
          },
        });

        // 把方案回显进对话流（落一条 assistant 消息），并随 done 事件把文本给前端即时展示。
        const planEcho = await echoPlanToConversation(conversation.id, draft);

        send({ type: "done", data: { ...toPlanResponse(draft, token), planEcho } });
      } catch (error) {
        if (error instanceof ModelConfigError) {
          send({
            type: "error",
            error: error.message,
            modelConfig: { kind: error.kind, capability: error.capability },
          });
        } else if (error instanceof FetchPageError || error instanceof ArticleSourceError) {
          send({ type: "error", error: error.message });
        } else {
          send({
            type: "error",
            error: `文章分析失败：${error instanceof Error ? error.message : "未知错误"}`,
          });
        }
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** 取回已保存的方案（刷新页面 / 关掉面板后继续生成）。 */
export async function GET(request: Request) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const plan = await prisma.videoPlan.findFirst({
    where: { token: new URL(request.url).searchParams.get("token") ?? "", userId: user.id },
  });
  if (!plan) return jsonError("方案不存在或已过期，请重新生成方案。", 404);
  const draft = JSON.parse(plan.draftJson) as VideoPlanDraft;
  return jsonOk({ ...toPlanResponse(draft, plan.token), status: plan.status });
}