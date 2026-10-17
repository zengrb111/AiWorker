/**
 * 视频产物回收 —— OpenClaw spawn 平台 CLI 出片后，由它把 CLI 的 JSON 输出
 * 回传到本接口完成落库。
 *
 * 方案 C 的关键边界：CLI **无数据库写权限**，只产文件 + 输出 JSON；
 * 所有数据写入（Message / ContentItem / VideoPlan）都收敛到这里，
 * 由平台掌握。这样即使 CLI 被滥用也碰不到业务表。
 *
 * 安全约束：
 *  1. 必须登录，且 conversationId 必须属于当前用户；
 *  2. videoPath / coverPath 必须位于该 token 对应的工作目录内
 *     （防路径穿越读取别人的文件）；
 *  3. token 必须在工作目录里真实存在（防伪造 token）。
 */
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

type FromCliBody = {
  token?: string;
  title?: string;
  videoPath?: string;
  coverPath?: string;
  durationSeconds?: number;
  narration?: string;
  sceneCount?: number;
};

/** 校验路径是否位于 baseDir 之内（防 `..` 穿越与绝对路径逃逸）。 */
function isInside(baseDir: string, target: string): boolean {
  if (!isAbsolute(target)) return false;
  const resolvedBase = normalize(baseDir);
  const resolvedTarget = normalize(target);
  if (resolvedTarget === resolvedBase) return false;
  return resolvedTarget.startsWith(resolvedBase + sep);
}

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const conversation = await prisma.conversation.findFirst({
    where: { id: context.params.id, userId: user.id },
  });
  if (!conversation) return jsonError("对话不存在。", 404);

  const body = await readJson<FromCliBody>(request);
  const token = (body.token ?? "").trim();
  if (!token) return jsonError("缺少 token。", 400);

  // token 只允许安全字符，避免被用来拼出越权路径。
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(token)) {
    return jsonError("token 格式不合法。", 400);
  }

  const workDir = join(process.cwd(), "public", "uploads", "gen-video-work", token);
  if (!existsSync(workDir)) {
    return jsonError("找不到该视频任务的工作目录，可能已被清理。", 404);
  }

  const videoPath = (body.videoPath ?? "").trim();
  if (!videoPath) return jsonError("缺少 videoPath。", 400);
  if (!isInside(workDir, videoPath)) {
    return jsonError("视频路径不合法（必须位于该任务的工作目录内）。", 400);
  }
  if (!existsSync(videoPath)) {
    return jsonError("视频文件不存在，可能生成失败。", 404);
  }

  const coverPath = (body.coverPath ?? "").trim();
  if (coverPath && !isInside(workDir, coverPath)) {
    return jsonError("封面路径不合法（必须位于该任务的工作目录内）。", 400);
  }

  // 产物从工作目录提升到公开可访问的成品目录，URL 才稳定可分享。
  // 直接暴露 gen-video-work 会让别人猜到 token 后就能下载，成品目录单独一层更稳。
  const outDir = join(process.cwd(), "public", "uploads", "gen-video-out", token);
  const { mkdir, copyFile } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });
  const finalVideoName = `video.mp4`;
  const finalVideoAbs = join(outDir, finalVideoName);
  await copyFile(videoPath, finalVideoAbs);

  let finalCoverAbs: string | null = null;
  if (coverPath && existsSync(coverPath)) {
    finalCoverAbs = join(outDir, "cover.jpg");
    await copyFile(coverPath, finalCoverAbs);
  }

  const videoUrl = `/uploads/gen-video-out/${token}/${finalVideoName}`;
  const coverUrl = finalCoverAbs ? `/uploads/gen-video-out/${token}/cover.jpg` : null;
  const title = (body.title ?? "").trim() || "AI 生成视频";
  const narration = (body.narration ?? "").trim();

  // ---- 落库：assistant 消息（让用户在看会话的地方看到成片）----
  const messageContent = [
    `**${title}**`,
    "",
    narration ? `口播文案：${narration}` : "",
    "",
    `视频已生成：${videoUrl}`,
    `时长：${Number(body.durationSeconds ?? 0).toFixed(1)} 秒 · 镜头数：${Number(body.sceneCount ?? 0)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "ASSISTANT",
      content: messageContent,
    },
  });

  // ---- 落库：内容库条目（复用既有内容体系，便于后续发布）----
  const contentItem = await prisma.contentItem.create({
    data: {
      userId: user.id,
      title,
      body: narration || title,
      category: "video",
      videoUrl,
      coverImageUrl: coverUrl ?? undefined,
      sourceConversationId: conversation.id,
    },
  });

  // ---- 落库：VideoPlan（若该 token 此前走过规划）----
  // CLI 不写库，所以这里补一条记录，让「方案 → 出片」的关系可追溯。
  await prisma.videoPlan
    .upsert({
      where: { token },
      create: {
        token,
        userId: user.id,
        conversationId: conversation.id,
        status: "RENDERED",
        requirement: narration.slice(0, 200) || title,
        draftJson: JSON.stringify({
          title,
          narration,
          durationSeconds: body.durationSeconds ?? 0,
          sceneCount: body.sceneCount ?? 0,
          videoUrl,
          coverUrl,
        }),
        materialsJson: "[]",
      },
      update: {
        status: "RENDERED",
        conversationId: conversation.id,
        draftJson: JSON.stringify({
          title,
          narration,
          durationSeconds: body.durationSeconds ?? 0,
          sceneCount: body.sceneCount ?? 0,
          videoUrl,
          coverUrl,
        }),
      },
    })
    .catch((error) => {
      // 方案记录不影响主流程（可能 token 冲突），只留日志。
      console.warn(
        `[gen-video/from-cli] VideoPlan 落库失败（不影响出片）：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });

  return jsonOk({
    messageId: message.id,
    contentItemId: contentItem.id,
    videoUrl,
    coverUrl,
    title,
  });
}
