/**
 * huashu-motion 出片的核心流程（手动弹窗与定时任务共用）。
 *
 * 之前这段逻辑写在 `/api/conversations/[id]/gen-video/huashu` 路由里，
 * 只能由用户点按钮触发。定时任务要「到点自动出一条视频初稿」，就必须把它抽出来：
 * 路由只做鉴权 + SSE 转发，真正的出片逻辑在这里。
 *
 * 流程：建目录 → 落参考图 → om init → om grab 抓产品站素材 → DSH 写片
 *      → om check → om render → 20s 校验/裁剪 → 发布 + 落库 + 写会话消息。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { prisma } from "@/lib/prisma";
import { runDshRender } from "@/lib/dsh";
import { extractVideoPoster } from "@/lib/video/poster";
import {
  buildFilmPrompt,
  omCheck,
  omGrab,
  omInit,
  omRender,
  projectDirFor,
  probeDuration,
  publishVideo,
  summarizeMaterials,
  trimToSeconds
} from "./huashu";

/** 成片硬上限：产品要求 20 秒。留 0.3s 容差（渲染器按帧对齐，常差一两帧）。 */
const MAX_SECONDS = 20.3;

/**
 * DSH 写片是重任务（读技能文档 + 反复 check），比确定性渲染慢得多。
 *
 * 实测：aimemory.cafe 抓素材 35s + DSH 写片 19~25 分钟 + 渲染 50s。
 * 定时任务没人盯着，超时直接判失败、这一版就白跑了，所以放宽到 45 分钟。
 */
const FILM_TIMEOUT_MS = Number(process.env.HUASHU_FILM_TIMEOUT_MS ?? 2_700_000);

/**
 * 给 promise 套硬超时：DSH 桥接进程可能活着但模型调用不再返回（实测会话文件 30 分钟不增长），
 * 自带超时等的是子进程 exit，这种情况要 45 分钟才收场。定时任务没人盯，必须早点失败。
 */
function withHardTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

export type HuashuImageInput =
  | { data: Buffer; filename: string }
  | { url: string };

export type HuashuGenerateOptions = {
  userId: string;
  conversationId: string;
  /** 创作需求；同时作为产品名称/内容库标题 */
  requirement: string;
  siteUrl?: string | null;
  images?: HuashuImageInput[];
  /** 复用已有进度消息（定时任务里同一条一直更新，避免刷屏） */
  progressMessageId?: string | null;
  /** 进度标题，默认「一键生成视频」；定时任务用「定时视频」 */
  progressTitle?: string;
  /** 内容库标题，默认取 requirement */
  title?: string;
  /** 进度回调（SSE / 日志），同步或异步都可以 */
  onProgress?: (text: string) => void | Promise<void>;
  /** 进度消息开头追加的说明行（定时任务用来说明选题结果） */
  prefixLines?: string[];
  /**
   * 允许「没有任何素材」也出片。
   *
   * 手动弹窗要求网站/参考图至少一个（产品约束）；定时任务里提示词本身就是主输入，
   * 没素材时让 DSH 按选题自己设计画面，比直接判失败更有用。
   */
  allowNoMaterials?: boolean;
  /**
   * 是否把 Studio 改片过程写进会话。
   * 手动出片的会话里不展示（用户只要成片，不要被「正在看帧/已改完」刷屏）；
   * 定时视频任务需要知道这条初稿改了什么，置 true。
   */
  progressInChat?: boolean;
};

export type HuashuGenerateResult = {
  projectId: string;
  projectToken: string;
  videoUrl: string;
  duration: number | null;
  contentId: string;
  messageId: string;
};

function progressBody(title: string, lines: string[], requirement: string): string {
  return [
    `## ${title}`,
    "",
    ...lines.map((line) => `- ${line}`),
    "",
    "### 创作需求",
    "",
    ...requirement.split(/\r?\n/).map((line) => `> ${line}`)
  ].join("\n");
}

/** 把参考图落到项目 materials/：本地上传的文件、/uploads 路径、外部 URL 都支持。 */
async function materializeImages(
  dir: string,
  token: string,
  images: HuashuImageInput[]
): Promise<string[]> {
  const saved: string[] = [];
  for (const [index, image] of images.entries()) {
    const slot = `ref-${index + 1}`;
    try {
      if ("data" in image) {
        const ext = extname(image.filename).toLowerCase();
        if (!ALLOWED_IMAGE_EXTENSIONS.has(ext) || image.data.byteLength > MAX_IMAGE_BYTES) continue;
        const file = join(dir, "materials", `${slot}${ext}`);
        await writeFile(file, image.data);
        saved.push(`/uploads/huashu/${token}/materials/${slot}${ext}`);
        continue;
      }

      const url = image.url.trim();
      if (!url) continue;
      if (url.startsWith("/uploads/") || url.startsWith("/videos/")) {
        // 平台自己的文件：直接读 public 下的实体，避免再走一次 HTTP
        const source = join(process.cwd(), "public", url);
        const ext = extname(source).toLowerCase();
        if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) continue;
        const data = await readFile(source);
        if (data.byteLength > MAX_IMAGE_BYTES) continue;
        await writeFile(join(dir, "materials", `${slot}${ext}`), data);
        saved.push(`/uploads/huashu/${token}/materials/${slot}${ext}`);
        continue;
      }
      if (!/^https?:\/\//i.test(url)) continue;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      const ext = contentType.includes("png")
        ? ".png"
        : contentType.includes("webp")
          ? ".webp"
          : ".jpg";
      const data = Buffer.from(await res.arrayBuffer());
      if (data.byteLength > MAX_IMAGE_BYTES) continue;
      await writeFile(join(dir, "materials", `${slot}${ext}`), data);
      saved.push(`/uploads/huashu/${token}/materials/${slot}${ext}`);
    } catch (error) {
      console.error("[huashu-generate] 参考图落盘失败（跳过）：", error);
    }
  }
  return saved;
}

/**
 * 跑一次完整出片。失败会抛错，调用方决定怎么展示（路由转 SSE error / 任务记 FAILED）。
 */
export async function runHuashuGeneration(
  options: HuashuGenerateOptions
): Promise<HuashuGenerateResult> {
  const {
    userId,
    conversationId,
    requirement,
    siteUrl = null,
    images = [],
    progressMessageId = null,
    progressTitle = "一键生成视频",
    title,
    onProgress,
    prefixLines = [],
    progressInChat = false
  } = options;

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const dir = projectDirFor(token);
  await mkdir(join(dir, "materials"), { recursive: true });

  const imageUrls = await materializeImages(dir, token, images);
  if (!siteUrl && imageUrls.length === 0 && !options.allowNoMaterials) {
    throw new Error("产品网站与参考图至少填一个。");
  }

  const project = await prisma.videoMotionProject.create({
    data: {
      token,
      userId,
      conversationId,
      source: siteUrl ? "PRODUCT_SITE" : "IMAGES",
      siteUrl: siteUrl || null,
      productName: requirement,
      projectDir: dir,
      status: "BUILDING",
      progressInChat
    }
  });

  const task = await prisma.openClawTask.create({
    data: { userId, type: "gen-video-huashu", prompt: requirement.slice(0, 200), status: "RUNNING" }
  });

  const lines: string[] = [...prefixLines];
  let messageId = progressMessageId;
  if (messageId) {
    await prisma.message
      .update({
        where: { id: messageId },
        data: { content: progressBody(progressTitle, [...prefixLines, "已接收素材，正在排版…"], requirement) }
      })
      .catch(() => undefined);
  } else {
    const created = await prisma.message.create({
      data: {
        conversationId,
        role: "ASSISTANT",
        content: progressBody(progressTitle, ["已接收素材，正在排版…"], requirement)
      }
    });
    messageId = created.id;
  }

  let progressWrite = Promise.resolve();
  const report = (text: string) => {
    if (!text.trim()) return;
    lines.push(text);
    const body = progressBody(progressTitle, lines, requirement);
    progressWrite = progressWrite.then(() =>
      prisma.message.update({ where: { id: messageId! }, data: { content: body } }).then(() => undefined)
    );
    void onProgress?.(text);
  };

  try {
    report("初始化 huashu-motion 项目…");
    await omInit(dir);

    if (siteUrl) {
      report(`抓取产品网站真实素材：${siteUrl}`);
      const grabbed = await omGrab(siteUrl, dir);
      const summary = grabbed.split(/\r?\n/).filter(Boolean).slice(0, 6).join("；");
      if (summary) report(`素材已就位：${summary}`);
    } else {
      report("未填产品网站，本片只使用参考图与创作需求。");
    }

    report("DSH 正在按 huashu-motion 技能写片（读产品、定方向、搭节奏），这步通常 5~15 分钟…");
    const prompt = buildFilmPrompt({
      productName: requirement,
      siteUrl,
      dir,
      imageCount: imageUrls.length,
      materialSummary: summarizeMaterials(dir)
    });
    const dsResult = await withHardTimeout(
      runDshRender(prompt, {
        userId,
        sessionId: `huashu-${token}`,
        timeoutMs: FILM_TIMEOUT_MS,
        // cwd 收敛到项目目录：DSH 只该改 index.html/materials
        workspaceDir: dir
      }),
      FILM_TIMEOUT_MS + 120_000,
      `DSH 写片超时（${Math.round((FILM_TIMEOUT_MS + 120_000) / 60000)} 分钟无产出）`
    );
    const dsNote = (dsResult || "").trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
    report(dsNote ? `DSH 完成：${dsNote}` : "DSH 已完成写片。");

    report("运行 om check 自检（结构 / 动效 / 文字遮挡）…");
    try {
      const check = await omCheck(dir);
      const checkTail = check.stdout.split(/\r?\n/).filter(Boolean).slice(-4).join("；");
      report(checkTail ? `自检结果：${checkTail}` : "自检通过。");
    } catch (checkError) {
      // 自检没过不丢成果：把问题报出来，仍然出片，之后可以在 Studio 里修
      const note = checkError instanceof Error ? checkError.message : String(checkError);
      report(`自检有告警（继续出片）：${note.split(/\r?\n/).slice(0, 3).join(" ")}`);
    }

    report("开始渲染（1080×1920 · 30fps · 2 workers）…");
    const rendered = await omRender(dir);
    let file = rendered.file;

    const duration = await probeDuration(file);
    let finalDuration = duration ?? null;
    if (duration != null && duration > MAX_SECONDS) {
      report(`成片 ${duration.toFixed(1)}s 超过 20s 上限，正在裁剪…`);
      const trimmed = join(dir, "out", "trimmed-20s.mp4");
      await trimToSeconds(file, 20, trimmed);
      file = trimmed;
      finalDuration = (await probeDuration(file)) ?? 20;
    }
    if (finalDuration != null) report(`成片时长 ${finalDuration.toFixed(1)}s。`);

    const videoUrl = publishVideo(file, token, 1);
    await prisma.videoMotionProject.update({
      where: { id: project.id },
      data: {
        status: "READY",
        videoUrl,
        versionsJson: JSON.stringify([
          {
            version: 1,
            videoUrl,
            duration: finalDuration,
            createdAt: new Date().toISOString(),
            note: "首次生成"
          }
        ]),
        error: null
      }
    });

    await progressWrite;
    const finalContent = [
      "## 视频已生成",
      `**${requirement}**`,
      `视频成片：${videoUrl}`,
      "",
      "> 想改哪一处，点「在 Studio 里修改」：在画面上点一下、写下要改什么，提交后会自动改片出新版。"
    ].join("\n");
    await prisma.message
      .update({ where: { id: messageId! }, data: { content: finalContent } })
      .catch(() => undefined);

    const item = await prisma.contentItem.create({
      data: {
        userId,
        title: (title || requirement).slice(0, 60) || `图生视频-${token}`,
        body: "",
        category: "视频",
        videoUrl,
        inlineImagesJson: JSON.stringify(imageUrls),
        sourceConversationId: conversationId
      }
    });

    // 抽首帧当内容库封面：视频条目以前只能显示通用占位图
    const poster = await extractVideoPoster(videoUrl, `huashu-${token}-v1`);
    if (poster) {
      await prisma.contentItem
        .update({ where: { id: item.id }, data: { coverImageUrl: poster } })
        .catch(() => undefined);
    }

    await prisma.openClawTask.update({
      where: { id: task.id },
      data: {
        status: "SUCCEEDED",
        resultJson: JSON.stringify({
          videoUrl,
          duration: finalDuration,
          messageId,
          contentId: item.id,
          projectToken: token
        })
      }
    });

    return {
      projectId: project.id,
      projectToken: token,
      videoUrl,
      duration: finalDuration,
      contentId: item.id,
      messageId: messageId!
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "视频生成失败。";
    await progressWrite.catch(() => undefined);
    await prisma.message
      .update({
        where: { id: messageId! },
        data: { content: `${progressBody(progressTitle, lines, requirement)}\n\n## 视频生成失败\n${message}` }
      })
      .catch(() => undefined);
    await prisma.videoMotionProject
      .update({ where: { id: project.id }, data: { status: "FAILED", error: message.slice(0, 1000) } })
      .catch(() => undefined);
    await prisma.openClawTask
      .update({ where: { id: task.id }, data: { status: "FAILED", error: message } })
      .catch(() => undefined);
    throw error;
  }
}
