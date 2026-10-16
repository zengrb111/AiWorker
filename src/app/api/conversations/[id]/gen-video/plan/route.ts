/**
 * 一键生成视频 —— **规划阶段**（只出方案，不渲染）。
 *
 * 需求原文：「让系统先理解图片与文字素材，再根据素材情况生成针对性的视频方案，
 * 向用户提出建议，用户选择后再开始生成视频」。
 *
 * 改造前这个链路是不存在的：识图、旁白、配音、DSH 分镜全藏在 `runVideoPipeline`
 * 里，由「点击开始生成」触发，用户在 2~5 分钟的渲染开始之前看不到任何方案，
 * 分镜结果只变成一行进度文本混在几十条进度里。
 *
 * 现在把它拆成两次请求：
 *   ① POST …/gen-video/plan   —— 跑识图 → 风格推断 → 旁白 → 配音 → DSH 分镜，
 *                                 把结果落库成 VideoPlan，返回**结构化方案摘要**
 *   ② POST …/gen-video        —— 带上 planToken，跳过规划直接渲染
 *
 * 规划阶段要 1~2 分钟（主要是配音与 DSH），这是因为分镜的时间轴骨架
 * `beats` 来自 TTS 的句级时间戳，不跑配音就没有真实时间点。这一取舍已与产品确认。
 */
import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { DEFAULT_TTS_PROVIDER, resolveTtsProvider } from "@/lib/tts";
import { parseTargetSeconds, runVideoPlanStage, type VideoPlanDraft } from "@/lib/video/pipeline";
import { LOOK_OPTIONS, parseLookFromForm, parseNewsItems } from "@/lib/video/plan-params";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const maxUploadBytes = 30 * 1024 * 1024;
const allowedImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const conversation = await prisma.conversation.findFirst({
    where: { id: context.params.id, userId: user.id },
  });
  if (!conversation) return jsonError("对话不存在。", 404);

  const form = await request.formData();
  const imageFiles = (form.getAll("image") || []).filter(
    (entry): entry is File => entry instanceof File && entry.size > 0
  );
  if (!imageFiles.length) return jsonError("请至少上传一张参考图。");

  const requirement = String(form.get("requirement") ?? "").trim();
  const ttsProvider = resolveTtsProvider(form.get("ttsProvider"), DEFAULT_TTS_PROVIDER);
  // 空 = 自动（由识图结果推断）。未知 key 交给 resolveTheme() 回落，不报错阻断。
  const theme = String(form.get("theme") ?? "").trim() || undefined;
  const look = parseLookFromForm(form);

  // token 同时是素材目录与配音目录的标识；渲染阶段必须复用同一个 token 才能找到配音。
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const uploadsRoot = join(process.cwd(), "public", "uploads", "gen-video-refs", token);
  await mkdir(uploadsRoot, { recursive: true });

  const savedImagePaths: string[] = [];
  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const extension = extname(file.name).toLowerCase();
    if (!allowedImageExtensions.has(extension)) continue;
    if (file.size > maxUploadBytes) continue;
    const target = join(uploadsRoot, `ref-${i}${extension}`);
    await writeFile(target, Buffer.from(await file.arrayBuffer()));
    savedImagePaths.push(target);
  }
  if (!savedImagePaths.length) return jsonError("参考图格式不支持，请上传 JPG / PNG / WebP。");

  const newsItems = parseNewsItems(form);
  const stage = await runVideoPlanStage({
    mode: "generate",
    token,
    newsItems,
    materials: savedImagePaths,
    requirement,
    targetSeconds: parseTargetSeconds(requirement),
    userId: user.id,
    ttsProvider,
    theme,
    look,
    onProgress: (text) => console.log(`[gen-video-plan ${token}] ${text}`),
  });

  if (!stage.ok) {
    // 缺模型配置必须把结构化分类传出去：前端据此弹「去系统配置」入口，
    // 而不是只显示一句用户无法行动的错误文案。
    // 约定 HTTP 400 + body 带 { kind, capability }，与前端 isModelConfigError 对齐。
    if (stage.modelConfig) {
      return jsonError(stage.error, 400, {
        kind: stage.modelConfig.kind,
        capability: stage.modelConfig.capability,
      });
    }
    return jsonError(stage.error, 500);
  }

  const draft = stage.draft;
  await prisma.videoPlan.create({
    data: {
      token,
      userId: user.id,
      conversationId: conversation.id,
      status: "PLANNED",
      requirement,
      draftJson: JSON.stringify(draft),
      materialsJson: JSON.stringify(savedImagePaths),
    },
  });

  return jsonOk({
    planToken: token,
    requirement,
    title: draft.title,
    narration: draft.narration,
    theme: draft.theme,
    themeReason: draft.themeReason,
    captionStyle: draft.captionStyle,
    summary: draft.summary,
    /** 素材理解结果：让用户看到 AI 到底认出了什么，才谈得上「针对性」。 */
    insights: draft.insights
      .filter((i) => i.caption)
      .map((i, k) => ({
        index: k + 1,
        caption: i.caption,
        mood: i.mood,
        subject: i.subject,
        dominantColor: i.dominantColor,
      })),
    audioSeconds: draft.audioSeconds,
    diagnostics: draft.diagnostics,
    /** 文案依据的新闻事实：让用户能核对「这份旁白到底基于什么」。 */
    newsItems: draft.newsItems,
    /** 可选项清单随接口下发，前端不再手抄一份映射表。 */
    options: LOOK_OPTIONS,
  });
}

/** 取回已保存的方案（刷新页面 / 关掉面板后继续生成）。 */
export async function GET(_request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const plan = await prisma.videoPlan.findFirst({
    where: { token: new URL(_request.url).searchParams.get("token") ?? "", userId: user.id },
  });
  if (!plan) return jsonError("方案不存在或已过期，请重新生成方案。", 404);
  const draft = JSON.parse(plan.draftJson) as VideoPlanDraft;
  return jsonOk({
    planToken: plan.token,
    requirement: plan.requirement,
    title: draft.title,
    narration: draft.narration,
    theme: draft.theme,
    themeReason: draft.themeReason,
    captionStyle: draft.captionStyle,
    summary: draft.summary,
    insights: draft.insights
      .filter((i) => i.caption)
      .map((i, k) => ({
        index: k + 1,
        caption: i.caption,
        mood: i.mood,
        subject: i.subject,
        dominantColor: i.dominantColor,
      })),
    audioSeconds: draft.audioSeconds,
    status: plan.status,
    diagnostics: draft.diagnostics,
    /** 文案依据的新闻事实：让用户能核对「这份旁白到底基于什么」。 */
    newsItems: draft.newsItems,
    options: LOOK_OPTIONS,
  });
}

