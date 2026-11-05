/**
 * 手动同步：把视频项目的**当前版本**回写到内容库 / 会话里的视频消息。
 *
 * 为什么是手动：改片是「在工作副本上试」，用户可能连改几版才满意。自动回写会把
 * 已发布的内容库条目和聊天里那条视频一起刷成半成品（2026-10-26 改）。
 *
 * 两个调用方：
 * 1. 平台前端（登录用户）—— 视频面板 / 内容库详情页的「同步修改到…」按钮；
 * 2. huashu Studio（端口 4850）的服务端代理 —— 浏览器直连平台会被跨站 cookie 拦掉
 *    （Studio 走 localhost:4850，平台在 127.0.0.1:3000，属于不同 site），所以由
 *    Studio 服务端用 platform agent token 代发，见 `cli/lib/server.js` 的 /api/sync。
 *
 * body: { targets?: ("content" | "conversation")[] }，默认两个都同步。
 */
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { getAgentToken } from "@/lib/platform-config";
import { readSessionUserId } from "@/lib/session";
import { syncProjectTargets, type SyncTarget } from "@/lib/video/huashu-inbox-worker";
import { prisma } from "@/lib/prisma";
import { basename } from "node:path";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ALLOWED: SyncTarget[] = ["content", "conversation"];

/** 内部令牌（Studio 服务端代理 / 龙虾脚本）。 */
function isInternal(request: Request): boolean {
  const expected = getAgentToken();
  if (!expected) return false;
  const header = (request.headers.get("authorization") || "").trim();
  if (header === `Bearer ${expected}`) return true;
  return (request.headers.get("x-platform-token") || "").trim() === expected;
}

function normalizeTargets(raw: unknown): SyncTarget[] {
  if (!Array.isArray(raw) || raw.length === 0) return ALLOWED;
  const picked = raw.filter((item): item is SyncTarget => ALLOWED.includes(item as SyncTarget));
  return picked.length ? picked : ALLOWED;
}

export async function POST(request: Request, { params }: { params: { token: string } }) {
  const internal = isInternal(request);
  const userId = readSessionUserId();
  if (!internal && !userId) return jsonError("未登录。", 401);

  const body = await readJson<{ targets?: unknown }>(request);
  const targets = normalizeTargets(body?.targets);

  const project = await findProject(params.token);
  if (!project) return jsonError("视频项目不存在。", 404);
  if (!internal && project.userId !== userId) return jsonError("无权操作这个视频。", 403);

  try {
    // ⚠️ 一定要用 project.token（而不是路径里的 params.token）继续：
    // Studio 回调时传的是**项目目录名**，命中的可能是 projectDir 反查出来的项目。
    const result = await syncProjectTargets(project.token, targets, {
      userId: internal ? undefined : userId ?? undefined
    });
    return jsonOk({ ...result, token: project.token, targets });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "同步失败。", 500);
  }
}

/**
 * 按 token 找项目；找不到再按**项目目录名**反查。
 *
 * 为什么需要反查：huashu Studio 的「同步修改到内容库」由它的服务端代理回调平台，
 * 而它拿的 token 是 `project.root.split(sep).pop()` —— 也就是**目录名**
 * （见 huashu-motion `cli/lib/server.js::syncToPlatform`）。
 * 早期/外部建的 om 项目目录名往往不等于平台 token（如 `/opt/huashu-motion/workspace/my-video`），
 * 只按 token 查会 404，用户看到的就是「点了同步、内容库没变」。
 */
async function findProject(rawToken: string) {
  // App Router 的 params 通常已解码；再解一次要防含 % 的目录名抛 URIError。
  let want = (rawToken || "").trim();
  try {
    want = decodeURIComponent(want).trim();
  } catch {
    /* 已经是解码后的值，保持原样 */
  }
  if (!want) return null;
  const select = { id: true, token: true, userId: true, videoUrl: true, projectDir: true } as const;

  const byToken = await prisma.videoMotionProject.findFirst({ where: { token: want }, select });
  if (byToken) return byToken;

  // 目录名兜底：只认「最后一段目录名完全相等」，避免 my-video 命中 my-video-2。
  // 必须唯一命中才认 —— 多个项目共用一个目录名（如都叫 proj）时不能瞎猜，
  // 否则会把内容库同步到别人的项目上。
  const candidates = await prisma.videoMotionProject.findMany({
    where: { projectDir: { contains: want } },
    select
  });
  const matched = candidates.filter((item) => basename(item.projectDir || "") === want);
  return matched.length === 1 ? matched[0] : null;
}
