import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { DEFAULT_TTS_PROVIDER, resolveTtsProvider } from "@/lib/tts";
import { parseTargetSeconds, pickBgm, resolveRenderEngine, runVideoPipeline, type VideoPlanDraft } from "@/lib/video/pipeline";
import { parseLookFromForm, parseNewsItems } from "@/lib/video/plan-params";
import { renderViaOpenClaw } from "@/lib/video/legacy-openclaw";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

/**
 * 一键生成视频 —— **出片阶段**（带 planToken 时跳过规划直接渲染）。
 *
 * 本路由同时服务三条入口的出片：
 *   1. 「一键生成视频」面板 —— 规划走 gen-video/plan
 *   2. 「文章转视频」面板   —— 规划走 gen-article-video/plan
 *   3. 热点卡片直接出片     —— 不带 planToken，走旧的直出分支
 *
 * 三者的出片过程完全一致（素材已在规划阶段定好），所以只认 token 不认来源。
 * 逻辑本身不因新增入口而改动。
 */
const maxUploadBytes = 30 * 1024 * 1024;
const allowedImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/**
 * SSE 心跳间隔（毫秒）。
 *
 * 出片是几十秒起步的长任务，而 SSE 只在有进展时才发事件；中间那段纯渲染时间
 * 完全静默，反向代理会当成空闲连接掐掉。参照 messages/route.ts 的 15s ping。
 */
const HEARTBEAT_MS = 15_000;

function sseEncode(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * 生成视频时用于回显「本次输入」的素材：参考图与创作要求。
 *
 * 为什么放进消息正文而不是新增字段：Message.content 本身就是 Markdown，
 * 而 renderMarkdown（src/lib/markdown.ts:29-40）已支持整行 `![alt](url)` 图片，
 * 且只放行以 `/` 或 http(s) 开头的同源/外链 URL。所以把参考图按
 * `/uploads/gen-video-refs/{token}/ref-N.ext` 写成 Markdown 图片即可直接显示，
 * 前端零改动；同时这份内容天然随消息落库，刷新页面后依然在。
 */
type VideoInputContext = {
  /** 参考图的可访问 URL（不是落盘绝对路径——那个只有服务端能读）。 */
  referenceImages: string[];
  /** 用户填写的创作要求/提示词，可空。 */
  requirement: string;
};

function formatProgressMessage(
  input: VideoInputContext,
  progress: string[],
  videoUrl?: string,
  error?: string,
  narration?: string,
  title?: string
): string {
  const lines = ["## 一键生成视频", "", ...progress.map((item) => `- ${item}`)];
  // 参考图不再写进这条进度消息：会话里已经有一条「参考图 + 提示词」回显
  // （前端 .video-request-echo 的缩略图网格），风格与生成刚开始时一致。
  // 这里再放一套 Markdown 大图会变成两种风格并存，故只保留进度与成片。
  if (input.requirement) {
    // 走引用块：保留原样换行，且 renderMarkdown 会对文本做 HTML 转义。
    lines.push("", "### 创作要求", "", ...input.requirement.split(/\r?\n/).map((l) => `> ${l}`));
  }
  if (title) lines.push("", "## 视频标题", `> ${title}`);
  if (narration) lines.push("", "## 旁白文案", `> ${narration}`);
  if (videoUrl) lines.push("", "## 视频生成完成", `视频成片：${videoUrl}`);
  if (error) lines.push("", "## 视频生成失败", error);
  return lines.join("\n");
}

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const conversation = await prisma.conversation.findFirst({ where: { id: context.params.id, userId: user.id } });
  if (!conversation) return jsonError("对话不存在。", 404);

  const form = await request.formData();
  const imageFiles = (form.getAll("image") || []).filter(
    (entry): entry is File => entry instanceof File && entry.size > 0
  );
  const requirement = String(form.get("requirement") ?? "").trim();
  // 用户在对话框里选择的语音引擎（qwen / zhipu）；非法值回落到全局默认（千问）。
  const ttsProvider = resolveTtsProvider(form.get("ttsProvider"), DEFAULT_TTS_PROVIDER);
  // 视频风格。空 = 自动（由识图结果推断）。不校验 key 是否存在：
  // 未知主题由 remotion 侧 resolveTheme() 回落到默认，报错反而阻断出片。
  const theme = String(form.get("theme") ?? "").trim() || undefined;
  // 外观覆盖（外挂特效 / 统一运镜 / 字幕样式），与 plan 路由同一份解析规则。
  const look = parseLookFromForm(form);

  // ---- 两条入口 ----
  //
  // A) 带 planToken：用户已在「方案确认」环节看过这份规划，跳过识图/旁白/配音/分镜，
  //    直接渲染。这样确认方案与出片之间不会重复跑一次 1~2 分钟的规划。
  // B) 不带 planToken：旧的直接出片路径。后台定时出片（content-ingest）等无人场景
  //    仍走这里，行为与改造前完全一致。
  const planToken = String(form.get("planToken") ?? "").trim();
  const savedPlan = planToken
    ? await prisma.videoPlan.findFirst({ where: { token: planToken, userId: user.id } })
    : null;
  if (planToken && !savedPlan) return jsonError("方案不存在或已过期，请重新生成方案。", 404);

  let savedImagePaths: string[];
  let referenceImageUrls: string[];
  let token: string;

  if (savedPlan) {
    // 复用规划阶段落盘的素材与配音：token 必须一致，否则配音文件找不到。
    token = savedPlan.token;
    savedImagePaths = JSON.parse(savedPlan.materialsJson) as string[];
    referenceImageUrls = savedImagePaths.map((p) =>
      `/uploads/gen-video-refs/${token}/${basename(p)}`
    );
  } else {
    if (!imageFiles.length) return jsonError("请至少上传一张参考图。");
    token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    // 参考图落在 public/uploads 下，两条引擎都直接读本机绝对路径；
    // 不再需要往 ~/.openclaw/workspace/remotion-refs/ 复制一份（旧路径的媒体白名单限制）。
    const uploadsRoot = join(process.cwd(), "public", "uploads", "gen-video-refs", token);
    await mkdir(uploadsRoot, { recursive: true });

    savedImagePaths = [];
    // 参考图的对外可访问 URL。落盘路径是本机绝对路径，只有服务端能读；
    // 前端要回显必须用 /uploads/... 形式。两者在同一次循环里 push，索引天然对齐。
    referenceImageUrls = [];
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      const extension = extname(file.name).toLowerCase();
      if (!allowedImageExtensions.has(extension)) continue;
      if (file.size > maxUploadBytes) continue;
      const target = join(uploadsRoot, `ref-${i}${extension}`);
      await writeFile(target, Buffer.from(await file.arrayBuffer()));
      savedImagePaths.push(target);
      referenceImageUrls.push(`/uploads/gen-video-refs/${token}/ref-${i}${extension}`);
    }
    if (!savedImagePaths.length) return jsonError("参考图格式不支持，请上传 JPG / PNG / WebP。");
  }

  // 本次输入的回显上下文，全程传给 formatProgressMessage（占位 / 进度 / 完成 / 失败四处共用）。
  const inputContext: VideoInputContext = { referenceImages: referenceImageUrls, requirement };

  const engine = resolveRenderEngine();
  const task = await prisma.openClawTask.create({
    data: { userId: user.id, type: "gen-video", prompt: requirement.slice(0, 200), status: "RUNNING" },
  });
  const progress = [
    savedPlan
      ? "已接收你确认的方案，正在准备 Remotion 视频创作任务…"
      : "已接收参考图，正在准备 Remotion 视频创作任务…",
  ];
  const progressMessage = await prisma.message.create({
    data: { conversationId: conversation.id, role: "ASSISTANT", content: formatProgressMessage(inputContext, progress) },
  });
  let progressWrite = Promise.resolve();
  const stream = new ReadableStream({
    async start(controller) {
      // 客户端断开 / 流已关闭后，controller.enqueue/close 会抛
      // "Invalid state: Controller is already closed"。出片是重任务，渲染期间
      // 用户关页面、切网络都会让连接先断，这个错误不该把整条出片判成失败。
      // 统一走 safeEnqueue：断开后只是不再往下推事件，服务端仍把片渲染完并入库。
      let streamClosed = false;
      const safeEnqueue = (event: unknown) => {
        if (streamClosed) return;
        try {
          controller.enqueue(sseEncode(event));
        } catch {
          streamClosed = true;
        }
      };

      // 心跳：渲染期间没有任何事件下发，靠定时 ping 让连接保持存活
      const heartbeat = setInterval(() => safeEnqueue({ type: "ping", at: Date.now() }), HEARTBEAT_MS);

      const sendProgress = (text: string) => {
        if (!text.trim()) return;
        progress.push(text);
        progressWrite = progressWrite.then(() =>
          prisma.message
            .update({ where: { id: progressMessage.id }, data: { content: formatProgressMessage(inputContext, progress) } })
            .then(() => undefined)
        );
        safeEnqueue({ type: "delta", text: `${text}\n` });
      };
      try {
        // 出片全流程收敛到编排层：旁白 → 配音 → 分镜(DeepSeek/兜底) → Remotion 渲染
        // → 混音 → 字幕 → 片头 → 封面。参数与顺序与改造前一致。
        const result = await runVideoPipeline({
          mode: "generate",
          token,
          materials: savedImagePaths,
          requirement,
          // 视频时长由旁白 TTS 时长决定；这里给的是「配文阶段」的目标时长。
          // 一键生成视频默认 10 秒（与规划接口保持一致），创作要求里写了时长以要求为准。
          targetSeconds: parseTargetSeconds(requirement, 10),
          // 新闻事实：从 prepare 阶段原样带过来，让旁白基于真实新闻内容写稿
          newsItems: savedPlan ? undefined : parseNewsItems(form),
          ttsProvider,
          theme,
          look,
          bgmPath: pickBgm(),
          // 归属用户：配音 / 分镜 / 识图都按该用户「系统配置」里的模型服务来调用
          userId: user.id,
          // 用户已确认的方案：带上来就跳过识图/旁白/配音/分镜，直接渲染
          resume: savedPlan ? (JSON.parse(savedPlan.draftJson) as VideoPlanDraft) : undefined,
          renderOverride: engine === "openclaw" ? renderViaOpenClaw : undefined,
          onProgress: sendProgress,
        });

        if (!result.ok) {
          // 缺模型配置：把结构化分类挂到错误对象上，随 SSE 的 error 事件下发，
          // 前端据此弹「去系统配置」入口。不带 planToken 的直接出片路径
          // 会重新生成文案，所以这条路径同样可能因未配置 chat 而失败。
          if (result.modelConfig) {
            const configError = new Error(result.error || "视频生成失败。") as Error & {
              modelConfig?: { kind: string; capability: string | null };
            };
            configError.modelConfig = result.modelConfig;
            throw configError;
          }
          throw new Error(result.error || "视频生成失败。");
        }

        // 方案已出片，标记为 RENDERED（刷新后前端据此不再重复出片）
        if (savedPlan) {
          await prisma.videoPlan
            .update({ where: { id: savedPlan.id }, data: { status: "RENDERED" } })
            .catch(() => undefined);
        }

        const finalUrl = result.videoUrl ?? null;
        const coverUrl = result.coverUrl ?? null;
        const narrationText = result.narration;
        const videoTitle = result.title;

        // ---- 落库 ----
        await progressWrite;
        // 出片完成后，这条消息只留「视频链接 + 预览」：不再重复堆进度步骤与输入回显
        // （参考图 / 提示词已在会话里单独回显，不需要在结果里再抄一遍）。
        const finalContent = finalUrl
          ? ["## 视频已生成", videoTitle ? `**${videoTitle}**` : "", `视频成片：${finalUrl}`]
              .filter(Boolean)
              .join("\n\n")
          : formatProgressMessage(inputContext, progress, undefined, undefined, narrationText || undefined, videoTitle || undefined);
        const finalMessage = await prisma.message.update({
          where: { id: progressMessage.id },
          data: { content: finalContent },
        });
        let saved: { id: string; title: string; category: string; videoUrl: string; coverImageUrl?: string } | undefined;
        if (finalUrl) {
          const item = await prisma.contentItem.create({
            data: {
              userId: user.id,
              title: videoTitle || `一键生成视频-${token}`,
              body: narrationText,
              category: "视频",
              videoUrl: finalUrl,
              coverImageUrl: coverUrl,
              // 参考图一并入库：内容库的「主图」区按 inlineImagesJson 平铺展示
              // （platform-client.tsx 的 parseInlineImages 已通用），
              // 这样出片后仍能回看「这条视频是用哪几张图做出来的」。
              inlineImagesJson: JSON.stringify(referenceImageUrls),
              sourceConversationId: conversation.id,
            },
          });
          saved = {
            id: item.id,
            title: item.title,
            category: item.category ?? "视频",
            videoUrl: finalUrl,
            coverImageUrl: coverUrl ?? undefined,
          };
        }
        await prisma.openClawTask.update({
          where: { id: task.id },
          data: {
            status: "SUCCEEDED",
            resultJson: JSON.stringify({
              videoUrl: finalUrl,
              title: videoTitle || null,
              coverUrl,
              narration: narrationText || null,
              messageId: finalMessage.id,
              contentId: saved?.id ?? null,
              // 排查用：实际走了哪条引擎、分镜是否兜底、后期每一步的成败
              engine: result.engineUsed,
              storyboardFallback: result.diagnostics.storyboardFallback,
              dshAvailable: result.diagnostics.dshAvailable,
              postSteps: result.diagnostics.postSteps,
            }),
          },
        });
        safeEnqueue({
          type: "final",
          videoUrl: finalUrl,
          title: videoTitle || null,
          coverUrl,
          narration: narrationText || null,
          contentSaved: saved,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "视频生成失败。";
        await progressWrite.catch(() => undefined);
        await prisma.message
          .update({
            where: { id: progressMessage.id },
            data: { content: formatProgressMessage(inputContext, progress, undefined, message) },
          })
          .catch(() => undefined);
        await prisma.openClawTask.update({ where: { id: task.id }, data: { status: "FAILED", error: message } });
        safeEnqueue({
          type: "error",
          error: message,
          // 缺模型配置时带上 kind/capability，前端才能弹「去系统配置」入口
          modelConfig: (error as { modelConfig?: { kind: string; capability: string | null } })
            ?.modelConfig,
        });

      } finally {
        // 必须清掉心跳：流 close 之后继续 enqueue 会抛错
        clearInterval(heartbeat);
        streamClosed = true;
        try {
          controller.close();
        } catch {
          // 客户端已断开，流已被关闭
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
