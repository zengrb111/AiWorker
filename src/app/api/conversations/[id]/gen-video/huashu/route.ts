/**
 * 图生视频（huashu-motion 链路）—— 一次性直出。
 *
 * 与 gen-video（平台自己的 Remotion 管线）的区别：
 * - 这里不跑识图/旁白/分镜，也不写 Storyboard JSON；
 * - 素材来自「产品网站（om grab 抓真实截图/logo/配色）」+「参考图（可选）」；
 * - 片子由 DSH 里的 huashu-motion 技能写成 HTML+GSAP，再由 om render 出 MP4；
 * - 出片后可以在 Studio 里点画面改（见 /api/video-motion/[token]/*）。
 *
 * 约束（产品定的）：竖版 1080×1920、成片 ≤20s、网站与参考图至少有一个。
 */
import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { runDshRender } from "@/lib/dsh";
import {
  buildFilmPrompt,
  huashuAvailable,
  probeDuration,
  projectDirFor,
  publishVideo,
  omCheck,
  omGrab,
  omInit,
  omRender,
  summarizeMaterials,
  trimToSeconds
} from "@/lib/video/huashu";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const maxUploadBytes = 30 * 1024 * 1024;
const allowedImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** 成片硬上限：产品要求 20 秒。留 0.3s 容差（渲染器按帧对齐，常差一两帧）。 */
const MAX_SECONDS = 20.3;

/** DSH 写片是重任务（读技能文档 + 反复 check），比现有的确定性渲染更慢。 */
const FILM_TIMEOUT_MS = Number(process.env.HUASHU_FILM_TIMEOUT_MS ?? 1_800_000);

const HEARTBEAT_MS = 15_000;

function sseEncode(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const conversation = await prisma.conversation.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!conversation) return jsonError("对话不存在。", 404);

  const availability = huashuAvailable();
  if (!availability.ok) return jsonError(availability.reason || "huashu-motion 不可用。", 500);

  const form = await request.formData();
  const siteUrl = String(form.get("siteUrl") ?? "").trim();
  const requirement = String(form.get("requirement") ?? "").trim();
  const imageFiles = (form.getAll("image") || []).filter(
    (entry): entry is File => entry instanceof File && entry.size > 0
  );

  if (!requirement) return jsonError("请填写创作需求（它会作为产品名称使用）。");
  if (siteUrl && !/^https?:\/\//i.test(siteUrl)) return jsonError("产品网站需以 http:// 或 https:// 开头。");
  if (!siteUrl && imageFiles.length === 0) return jsonError("产品网站与参考图至少填一个。");

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const dir = projectDirFor(token);
  await mkdir(join(dir, "materials"), { recursive: true });

  // 参考图先落盘：素材必须在本机，DSH 与 om 都只读本地文件。
  const imageUrls: string[] = [];
  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const extension = extname(file.name).toLowerCase();
    if (!allowedImageExtensions.has(extension)) continue;
    if (file.size > maxUploadBytes) continue;
    const target = join(dir, "materials", `ref-${i + 1}${extension}`);
    await writeFile(target, Buffer.from(await file.arrayBuffer()));
    imageUrls.push(`/uploads/huashu/${token}/materials/ref-${i + 1}${extension}`);
  }
  if (!siteUrl && imageUrls.length === 0) {
    return jsonError("参考图格式不支持，请上传 JPG / PNG / WebP。");
  }

  const project = await prisma.videoMotionProject.create({
    data: {
      token,
      userId: user.id,
      conversationId: conversation.id,
      source: siteUrl ? "PRODUCT_SITE" : "IMAGES",
      siteUrl: siteUrl || null,
      productName: requirement,
      projectDir: dir,
      status: "BUILDING"
    }
  });

  const task = await prisma.openClawTask.create({
    data: { userId: user.id, type: "gen-video-huashu", prompt: requirement.slice(0, 200), status: "RUNNING" }
  });

  const progress: string[] = [];
  const progressMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "ASSISTANT",
      content: "## 一键生成视频\n\n- 已接收素材，正在准备 huashu-motion 创作…"
    }
  });

  let progressWrite = Promise.resolve();
  const renderProgress = () =>
    ["## 一键生成视频（huashu-motion）", "", ...progress.map((item) => `- ${item}`), "", "### 创作需求", "", ...requirement.split(/\r?\n/).map((l) => `> ${l}`)].join("\n");

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sseEncode(event));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => safeEnqueue({ type: "ping", at: Date.now() }), HEARTBEAT_MS);

      const sendProgress = (text: string) => {
        if (!text.trim()) return;
        progress.push(text);
        progressWrite = progressWrite.then(() =>
          prisma.message
            .update({ where: { id: progressMessage.id }, data: { content: renderProgress() } })
            .then(() => undefined)
        );
        safeEnqueue({ type: "delta", text: `${text}\n` });
      };

      try {
        // 1) 建项目（blank 模板；方向由 DSH 按产品自选）
        sendProgress("初始化 huashu-motion 项目…");
        await omInit(dir);

        // 2) 抓产品网站真实素材
        if (siteUrl) {
          sendProgress(`抓取产品网站真实素材：${siteUrl}`);
          const grabbed = await omGrab(siteUrl, dir);
          const summary = grabbed.split(/\r?\n/).filter(Boolean).slice(0, 6).join("；");
          if (summary) sendProgress(`素材已就位：${summary}`);
        } else {
          sendProgress("未填产品网站，本片只使用参考图与创作需求。");
        }

        // 3) DSH 写片（读 SKILL.md + director.md，按技能方法创作）
        sendProgress("DSH 正在按 huashu-motion 技能写片（读产品、定方向、搭节奏），这步通常 5~15 分钟…");
        const prompt = buildFilmPrompt({
          productName: requirement,
          siteUrl: siteUrl || null,
          dir,
          imageCount: imageUrls.length,
          materialSummary: summarizeMaterials(dir)
        });
        const dsResult = await runDshRender(prompt, {
          userId: user.id,
          sessionId: `huashu-${token}`,
          timeoutMs: FILM_TIMEOUT_MS,
          // cwd 收敛到项目目录：DSH 只该改 index.html/materials，不该在仓库根乱写
          workspaceDir: dir
        });
        const dsNote = (dsResult || "").trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
        sendProgress(dsNote ? `DSH 完成：${dsNote}` : "DSH 已完成写片。");

        // 4) 自检（0 error 才继续）
        sendProgress("运行 om check 自检（结构 / 动效 / 文字遮挡）…");
        try {
          const check = await omCheck(dir);
          const checkTail = check.stdout.split(/\r?\n/).filter(Boolean).slice(-4).join("；");
          sendProgress(checkTail ? `自检结果：${checkTail}` : "自检通过。");
        } catch (checkError) {
          // 自检没过不直接丢弃十几分钟的成果：把问题如实报出来，仍然尝试出片，
          // 用户看到成片后可以在 Studio 里继续修。
          const note = checkError instanceof Error ? checkError.message : String(checkError);
          sendProgress(`自检有告警（继续出片）：${note.split(/\r?\n/).slice(0, 3).join(" ")}`);
        }

        // 5) 渲染（平台统一跑，避免与 Studio 抢 Chrome）
        sendProgress("开始渲染（1080×1920 · 30fps · 2 workers）…");
        const rendered = await omRender(dir);
        let file = rendered.file;

        // 6) 20s 硬上限
        const duration = await probeDuration(file);
        let finalDuration = duration ?? null;
        if (duration != null && duration > MAX_SECONDS) {
          sendProgress(`成片 ${duration.toFixed(1)}s 超过 20s 上限，正在裁剪…`);
          const trimmed = join(dir, "out", "trimmed-20s.mp4");
          await trimToSeconds(file, 20, trimmed);
          file = trimmed;
          finalDuration = (await probeDuration(file)) ?? 20;
        }
        if (finalDuration != null) sendProgress(`成片时长 ${finalDuration.toFixed(1)}s。`);

        // 7) 发布 + 落库
        const videoUrl = publishVideo(file, token, 1);
        const versions = [
          {
            version: 1,
            videoUrl,
            duration: finalDuration,
            createdAt: new Date().toISOString(),
            note: "首次生成"
          }
        ];
        await prisma.videoMotionProject.update({
          where: { id: project.id },
          data: { status: "READY", videoUrl, versionsJson: JSON.stringify(versions), error: null }
        });

        await progressWrite;
        const finalContent = [
          "## 视频已生成",
          `**${requirement}**`,
          `视频成片：${videoUrl}`,
          "",
          `> 想改哪一处，点「在 Studio 里修改」：在画面上点一下、写下要改什么，再回来点「同步修改」。`
        ].join("\n");
        const finalMessage = await prisma.message.update({
          where: { id: progressMessage.id },
          data: { content: finalContent }
        });

        const item = await prisma.contentItem.create({
          data: {
            userId: user.id,
            title: requirement.slice(0, 60) || `图生视频-${token}`,
            body: "",
            category: "视频",
            videoUrl,
            inlineImagesJson: JSON.stringify(imageUrls),
            sourceConversationId: conversation.id
          }
        });

        await prisma.openClawTask.update({
          where: { id: task.id },
          data: {
            status: "SUCCEEDED",
            resultJson: JSON.stringify({
              videoUrl,
              duration: finalDuration,
              messageId: finalMessage.id,
              contentId: item.id,
              projectToken: token
            })
          }
        });

        safeEnqueue({
          type: "final",
          videoUrl,
          duration: finalDuration,
          projectToken: token,
          studioUrl: null,
          contentSaved: { id: item.id, title: item.title, category: "视频", videoUrl }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "视频生成失败。";
        await progressWrite.catch(() => undefined);
        await prisma.message
          .update({ where: { id: progressMessage.id }, data: { content: `${renderProgress()}\n\n## 视频生成失败\n${message}` } })
          .catch(() => undefined);
        await prisma.videoMotionProject
          .update({ where: { id: project.id }, data: { status: "FAILED", error: message.slice(0, 1000) } })
          .catch(() => undefined);
        await prisma.openClawTask.update({ where: { id: task.id }, data: { status: "FAILED", error: message } }).catch(() => undefined);
        safeEnqueue({ type: "error", error: message });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
