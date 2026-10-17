/**
 * 视频 CLI 进度查询 —— 前端轮询用。
 *
 * 方案 C：OpenClaw spawn 的 CLI 是**独立进程**，不经 Next.js，
 * 因此进度不能靠 SSE 推送，只能由 CLI 写 progress.json、前端轮询读取。
 *
 * 协议见 scripts/aiworker-video.mts 的 ProgressWriter：
 *   { token, stage, percent, message, updatedAt, terminal }
 */
import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type ProgressPayload = {
  token: string;
  stage: string;
  percent: number;
  message: string;
  updatedAt: string;
  terminal: boolean;
};

export async function GET(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const conversation = await prisma.conversation.findFirst({
    where: { id: context.params.id, userId: user.id },
  });
  if (!conversation) return jsonError("对话不存在。", 404);

  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!token) return jsonError("缺少 token。", 400);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(token)) {
    return jsonError("token 格式不合法。", 400);
  }

  const progressPath = join(
    process.cwd(),
    "public",
    "uploads",
    "gen-video-work",
    token,
    "progress.json"
  );
  if (!existsSync(progressPath)) {
    // token 不存在或 CLI 还没开始写盘 —— 前端据此继续等待，不当成错误。
    return jsonOk({ status: "pending" as const });
  }

  let payload: ProgressPayload;
  try {
    payload = JSON.parse(readFileSync(progressPath, "utf8")) as ProgressPayload;
  } catch {
    return jsonError("进度文件损坏，无法读取。", 500);
  }

  // 终态时附上成品 URL（若已回收）。
  let videoUrl: string | null = null;
  if (payload.terminal && payload.stage === "done") {
    const { existsSync: has } = await import("node:fs");
    const finalVideo = join(
      process.cwd(),
      "public",
      "uploads",
      "gen-video-out",
      token,
      "video.mp4"
    );
    if (has(finalVideo)) videoUrl = `/uploads/gen-video-out/${token}/video.mp4`;
  }

  return jsonOk({
    status: "ok" as const,
    stage: payload.stage,
    percent: payload.percent,
    message: payload.message,
    updatedAt: payload.updatedAt,
    terminal: payload.terminal,
    videoUrl,
  });
}
