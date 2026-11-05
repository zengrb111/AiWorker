import { NextRequest } from "next/server";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { resolveOwnerFromBody } from "@/lib/ingest-owner";
import { getIngestToken, isValidAgentToken } from "@/lib/platform-config";
import { ingestVideoContent, type IngestVideoInput } from "@/lib/content-ingest-video";

/**
 * POST /api/content/ingest/video —— 龙虾把**已出片的视频**保存进内容库。
 *
 * 鉴权走 Bearer 平台 Agent 令牌（与 /api/content/ingest 同源），不用登录态：
 * 龙虾跑在 OpenClaw 网关侧，没有 Web 会话。
 *
 * 两种请求体：
 *   A) multipart/form-data —— 传文件本体
 *      file: <视频二进制>        （必填，字段名固定 file）
 *      title / body / category / coverImageUrl / contentId
 *      userId | sessionKey | phone （归属账号，强烈建议显式带 userId）
 *
 *   B) application/json —— 传视频位置
 *      { "userId": "...", "videoUrl": "/videos/xxx.mp4" 或 "https://...",
 *        "title": "...", "body": "..." }
 *      也可改用 "filePath": "/opt/huashu-motion/.../out/xxx.mp4"（同机绝对路径，受白名单限制）
 *
 * 【Studio 模式】片子是龙虾用 DSH 调 huashu-motion 出的、要能进 Studio 改时，
 *   额外带 "studio": true 和 "projectDir": "<om 项目根目录绝对路径>"，
 *   可选 token / productName / siteUrl / targetSeconds / duration / copyProject。
 *   平台会按 /videos/huashu-<token>-v1.mp4 落盘并登记 VideoMotionProject
 *   （source=DSH_HUASHU, status=READY），前端「去 Studio 修改」按钮才会出现。
 *
 * 归属账号（内容库按账号隔离）：userId > sessionKey 里的账号 id > phone；
 * 显式指定却查不到账号会直接报错，绝不静默落到别人库里。
 *
 * 成功返回 { contentId, title, videoUrl, coverImageUrl, category, created, reused, origin, studio }。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function extractToken(request: NextRequest): string {
  const header = request.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return (request.headers.get("x-ingest-token") || "").trim();
}

/** formData 里的字段统一取字符串；空串归一成 undefined。 */
function field(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** multipart 里布尔值只能以字符串传，兼容 true / 1 / yes。 */
function boolField(form: FormData, key: string): boolean | undefined {
  const raw = field(form, key)?.toLowerCase();
  if (!raw) return undefined;
  return raw === "true" || raw === "1" || raw === "yes";
}

function numField(form: FormData, key: string): number | undefined {
  const raw = field(form, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** JSON 里 studio 也可能是字符串 "true"（脚本拼 JSON 时常这么写）。 */
function normalizeStudio(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "1", "yes"].includes(value.trim().toLowerCase());
  return undefined;
}

function isJsonRequest(request: NextRequest): boolean {
  return (request.headers.get("content-type") || "").toLowerCase().includes("application/json");
}

async function parseMultipart(request: NextRequest): Promise<IngestVideoInput & {
  userId?: string;
  sessionKey?: string;
  phone?: string;
}> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new Error("multipart 请求体解析失败，请确认用 -F 传文件且 Content-Type 正确。");
  }
  const entry = form.get("file");
  const file = entry instanceof File ? entry : null;
  if (!file || file.size === 0) {
    throw new Error("缺少视频文件：请用 -F \"file=@/path/to/video.mp4\" 上传。");
  }
  return {
    upload: { name: file.name || "video.mp4", data: Buffer.from(await file.arrayBuffer()) },
    title: field(form, "title"),
    body: field(form, "body"),
    category: field(form, "category"),
    coverImageUrl: field(form, "coverImageUrl"),
    contentId: field(form, "contentId"),
    studio: boolField(form, "studio"),
    projectDir: field(form, "projectDir"),
    token: field(form, "token"),
    copyProject: boolField(form, "copyProject"),
    productName: field(form, "productName"),
    siteUrl: field(form, "siteUrl"),
    targetSeconds: numField(form, "targetSeconds"),
    duration: numField(form, "duration"),
    userId: field(form, "userId"),
    sessionKey: field(form, "sessionKey"),
    phone: field(form, "phone")
  };
}

async function parseJson(request: NextRequest): Promise<IngestVideoInput & {
  userId?: string;
  sessionKey?: string;
  phone?: string;
}> {
  const body = await readJson<
    IngestVideoInput & { userId?: string; sessionKey?: string; phone?: string; studio?: unknown }
  >(request);
  // studio 允许 "true" 字符串，统一归一成布尔，避免龙虾脚本拼 JSON 时静默失效。
  return { ...body, studio: normalizeStudio(body.studio) };
}

export async function POST(request: NextRequest) {
  const expected = getIngestToken();
  if (!expected) {
    return jsonError("服务端未配置平台 Agent 令牌（系统配置 → 平台 Agent 令牌），视频入库接口未启用。", 503);
  }
  if (!isValidAgentToken(extractToken(request))) {
    return jsonError("入库令牌无效。", 401);
  }

  let payload: IngestVideoInput & { userId?: string; sessionKey?: string; phone?: string };
  try {
    payload = isJsonRequest(request) ? await parseJson(request) : await parseMultipart(request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "请求体解析失败。");
  }

  // 归属账号：显式指定却查不到时直接报错，防内容串到别的账号。
  const owner = await resolveOwnerFromBody(payload);
  if (!owner.ok) return jsonError(owner.error, owner.status);

  try {
    const result = await ingestVideoContent(owner.user.id, payload);
    return jsonOk({ account: owner.user.phone, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "视频入库失败。";
    console.error("[content/ingest/video] 入库失败：", error);
    return jsonError(message);
  }
}
