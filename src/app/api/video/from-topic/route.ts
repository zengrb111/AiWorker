/**
 * POST /api/video/from-topic —— 让网关里的 agent 把「选题」交回平台出片。
 *
 * 存在理由（2026-11-07 实测对比）：
 * 同一台机器、同一套 huashu-motion，两条链路的产物差一倍——
 *   平台流水线：index.html 81KB / 989 行、60 处 OM.sfx 音效、有 treatment.md 与真实素材目录；
 *   agent 自己折腾：index.html 23KB / 466 行、0 处音效、没 treatment.md。
 * 差在「prompt 由谁写」：代码写死的 buildFilmPrompt 每条硬约束都在，agent 读规范再转述必然丢细节
 * （连任务提示词本身都把文件路径丢了）。
 *
 * 所以接口只收「讲什么」，写片、渲染、入库、封面色、Studio 标记全部走平台那条已经调好的链。
 *
 * 鉴权：Bearer 平台 Agent 令牌（同 /api/scheduled-jobs/agent、/api/content/ingest/video）。
 * 语义：**异步**。立刻返回，5~15 分钟出片后由平台直接推微信 —— agent 等不起这么久。
 *
 * body:
 *   {
 *     userId | phone | sessionKey,     // 归属账号，必须显式给
 *     topic: "标题\n要点…",            // 必填，要讲的内容
 *     title?,                          // 视频/内容库标题，缺省取 topic 首行
 *     targetSeconds?,                  // 目标时长，默认 30
 *     siteUrl?,                        // 产品网站（可选）
 *     images?: string[],               // 参考图，见下
 *     imageDir?,                       // 只传文件名时的基准目录（绝对路径）
 *     conversationName?                // 进度会话名（可选）
 *   }
 *
 * images 的每一项支持三种形态：
 *   1. 远程地址：`https://example.com/a.png`
 *   2. 平台站内：`/uploads/xxx.png`、`/videos/xxx.mp4` 抽帧得到的图
 *   3. **本地磁盘绝对路径**：`C:/Users/.../workspace/ocr/frame-01.png`
 *      （agent 自己截的图、OCR 出来的图就走这条；只允许平台 public、
 *        huashu-motion 仓库、OpenClaw workspace 三个白名单目录）
 * 也可以把纯文件名放 images、目录放 imageDir，由平台拼绝对路径。
 */
import { NextRequest } from "next/server";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { getAgentToken, isValidAgentToken } from "@/lib/platform-config";
import { resolveOwnerFromBody } from "@/lib/ingest-owner";
import { startVideoFromTopic } from "@/lib/scheduler";
import { assertPathAllowed } from "@/lib/video/agent-studio-paths";
import type { HuashuImageInput } from "@/lib/video/huashu-generate";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** 参考图最多 6 张：再多 DSH 也放不下，反而稀释注意力。 */
const MAX_IMAGES = 6;
const ALLOWED_IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

type Body = {
  userId?: string;
  phone?: string;
  sessionKey?: string;
  topic?: string;
  title?: string;
  targetSeconds?: number | null;
  siteUrl?: string;
  images?: string[];
  imageDir?: string;
  conversationName?: string;
};

function extractToken(request: NextRequest): string {
  const header = request.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return (request.headers.get("x-platform-token") || "").trim();
}

/**
 * 把 agent 传来的一个参考图路径解析成 huashu 能吃的形态。
 *
 * 为什么本地路径要在接口层就读成 Buffer：`materializeImages` 只认
 * 「远程 URL / 平台站内路径 / 现成的 data」，本地磁盘路径会被它静默跳过，
 * 结果用户以为传了图、片子里一张都没有。
 */
async function toImageInput(raw: string, imageDir: string | null): Promise<HuashuImageInput> {
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return { url: value };
  // 平台站内路径：materializeImages 会直接去 public 下读实体，不用再走 HTTP。
  if (value.startsWith("/uploads/") || value.startsWith("/videos/")) return { url: value };

  const abs = isAbsolute(value) ? value : imageDir ? join(imageDir, value) : "";
  if (!abs) {
    throw new Error(
      `参考图「${value}」只给了文件名，请同时传 imageDir（这些文件所在目录的绝对路径）。`
    );
  }

  assertPathAllowed(abs, "参考图");
  const ext = extname(abs).toLowerCase();
  if (!ALLOWED_IMAGE_EXT.has(ext)) {
    throw new Error(`参考图只支持 jpg / png / webp：${value}`);
  }
  const data = await readFile(abs);
  if (data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`参考图超过 30MB：${value}`);
  }
  return { filename: basename(abs), data };
}

export async function POST(request: NextRequest) {
  const expected = getAgentToken();
  if (!expected) {
    return jsonError("服务端未配置平台 Agent 令牌（系统配置 → 平台 Agent 令牌），该接口未启用。", 503);
  }
  if (!isValidAgentToken(extractToken(request))) {
    return jsonError("令牌无效。", 401);
  }

  const body = await readJson<Body>(request);
  const hasOwner = Boolean(
    (body?.userId || "").trim() || (body?.sessionKey || "").trim() || (body?.phone || "").trim()
  );
  if (!hasOwner) {
    return jsonError("缺少归属账号：请传 userId / sessionKey / phone 之一。");
  }
  const owner = await resolveOwnerFromBody({
    userId: body?.userId,
    phone: body?.phone,
    sessionKey: body?.sessionKey
  });
  if (!owner.ok) return jsonError(owner.error, owner.status);

  const topic = (body?.topic || "").trim();
  if (!topic) return jsonError("缺少 topic（要讲的选题内容）。");
  if (topic.length > 4000) return jsonError("topic 太长（上限 4000 字），请只给要讲的核心内容。");

  const imageDir = (body?.imageDir || "").trim() || null;
  let images: HuashuImageInput[] = [];
  const rawImages = Array.isArray(body?.images)
    ? body.images.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  if (rawImages.length > MAX_IMAGES) {
    return jsonError(`参考图最多 ${MAX_IMAGES} 张，现在给了 ${rawImages.length} 张。`);
  }
  if (rawImages.length) {
    try {
      images = await Promise.all(rawImages.map((item) => toImageInput(item, imageDir)));
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "参考图读取失败。", 400);
    }
  }

  try {
    const started = await startVideoFromTopic({
      userId: owner.user.id,
      topic,
      title: body?.title,
      targetSeconds: body?.targetSeconds ?? 30,
      siteUrl: body?.siteUrl,
      images,
      conversationName: body?.conversationName
    });
    return jsonOk({
      status: "RUNNING",
      conversationId: started.conversationId,
      title: started.title,
      imageCount: images.length,
      message: started.message
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "启动出片失败。", 500);
  }
}
