import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { openClawClient } from "@/lib/openclaw";
import { loadUserKbContext, retrieveReferenceChunks } from "@/lib/kb-hot-topics";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 「热点 → 一键生成视频」的准备接口。
 *
 * 以某条热点为主题，联网检索最新资讯并结合当前用户的知识库产品知识，整理出一份可直接
 * 用于短视频生成的创作要求，并把关联的真实新闻配图下载到本地，作为「一键生成视频」面板
 * 的预填参考图。出片环节仍走既有 gen-video 路由，本接口只负责"准备"。
 *
 * 返回：{ requirement, images: [{ url, name }] }（url 为 public 下的同源相对路径）。
 */

type PrepareBody = {
  topic?: string;
};

/** 准备阶段是长任务（agent 联网检索 + 整理），超时可配置。 */
const PREPARE_TIMEOUT_MS = Number(process.env.OPENCLAW_VIDEO_PREPARE_TIMEOUT_MS ?? 180_000);
/** 单张远程配图的下载超时与大小上限（第三方新闻图可能又大又慢）。 */
const IMAGE_FETCH_TIMEOUT_MS = Number(process.env.OPENCLAW_VIDEO_PREPARE_IMAGE_TIMEOUT_MS ?? 15_000);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 6;

/** 远程图 URL 常带 query，扩展名不可靠，统一按响应 content-type 归一。 */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

/** 从 agent 的自由文本里提取 { requirement, imageUrls }，多级容错。 */
function parsePrepared(text: string): { requirement: string; imageUrls: string[] } {
  const raw = (text ?? "").trim();
  if (!raw) return { requirement: "", imageUrls: [] };
  const unfenced = raw.replace(/```json\s*([\s\S]*?)```/i, "$1").replace(/```/g, "").trim();
  const candidates: string[] = [unfenced];
  const brace = unfenced.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as { requirement?: unknown; imageUrls?: unknown; images?: unknown };
      const requirement = typeof obj.requirement === "string" ? obj.requirement.trim() : "";
      const list = Array.isArray(obj.imageUrls) ? obj.imageUrls : Array.isArray(obj.images) ? obj.images : [];
      const imageUrls = (list as unknown[])
        .map((item) => (typeof item === "string" ? item.trim() : typeof item === "object" && item && typeof (item as { url?: unknown }).url === "string" ? (item as { url: string }).url.trim() : ""))
        .filter((u) => /^https?:\/\//i.test(u));
      if (requirement) return { requirement, imageUrls };
    } catch {
      // 尝试下一个候选片段
    }
  }
  return { requirement: "", imageUrls: [] };
}

/**
 * 下载单张远程配图到本地，返回同源可访问 URL；失败返回 null（跳过该图，不阻断整体）。
 */
async function downloadPreparedImage(
  imageUrl: string,
  dirAbs: string,
  webPrefix: string,
  index: number
): Promise<{ url: string; name: string } | null> {
  try {
    const resp = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ChuangxingyunAIWorker/1.0)" },
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const mime = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (mime && !mime.startsWith("image/")) return null;
    const ext = MIME_TO_EXT[mime] ?? "jpg";
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 1024 || buffer.length > MAX_IMAGE_BYTES) return null;
    const name = `ref-${index}.${ext}`;
    await writeFile(join(dirAbs, name), buffer);
    return { url: `${webPrefix}/${name}`, name };
  } catch {
    return null;
  }
}

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: context.params.id, userId: user.id },
  });
  if (!conversation) {
    return jsonError("对话不存在。", 404);
  }

  const body = await readJson<PrepareBody>(request);
  const topic = (body.topic ?? "").trim();
  if (!topic) {
    return jsonError("请提供热点主题。");
  }

  // 当前用户的知识库产品知识：让创作要求贴合用户实际产品（无知识库/失败时为空，不阻断）。
  let kbText = "";
  try {
    const kbCtx = await loadUserKbContext(user.id);
    if (kbCtx) {
      kbText = await retrieveReferenceChunks(
        [topic, "产品卖点 账号人设 品牌定位 用户痛点"],
        kbCtx,
        5,
      );
    }
  } catch {
    kbText = "";
  }

  const prompt = [
    "你是一名短视频编导。请围绕下面这个热点主题，联网检索该主题的最新资讯，并结合给定的产品知识，产出一条竖版短视频的创作方案。",
    "",
    `【热点主题】${topic}`,
    kbText ? `\n【可参考的产品知识】\n${kbText}` : "",
    "",
    "请完成两件事：",
    "1) 整理创作要求：写明主题切入角度、旁白文案方向、分镜与节奏、画面与风格、时长建议、结尾引导，具体可执行。",
    "2) 挑选 3~6 张与该主题高度相关的真实新闻配图（http/https 直链，优先新闻原文配图），用作视频参考图。",
    "",
    "只输出一个 JSON 代码块，不要任何其它说明文字：",
    "```json",
    '{"requirement":"（创作要求全文）","imageUrls":["https://...1.jpg","https://...2.jpg"]}',
    "```",
  ]
    .filter(Boolean)
    .join("\n");

  let agentText = "";
  let taskError: string | null = null;
  try {
    const result = await openClawClient.sendTaskStream({ message: prompt, prompt, userId: user.id }, () => {}, PREPARE_TIMEOUT_MS);
    agentText = result.content ?? "";
  } catch (error) {
    taskError = error instanceof Error ? error.message : "未知错误";
  }

  const prepared = parsePrepared(agentText);
  if (!prepared.requirement) {
    // 记录原始返回，便于排查 agent 是否按 JSON 格式输出。
    console.error("[gen-video/prepare] agent 未返回可用 requirement，原始内容：", agentText.slice(0, 600) || "(空)");
    return jsonError(
      taskError
        ? `短视频创作要求整理失败：${taskError}`
        : "未能根据该热点整理出有效的短视频创作要求，请稍后重试。",
    );
  }

  // 并发下载配图；个别失败仅跳过，不阻断。全部失败也照常返回（用户可自行上传）。
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const dirAbs = join(process.cwd(), "public", "uploads", "gen-video-prep", token);
  await mkdir(dirAbs, { recursive: true });
  const webPrefix = `/uploads/gen-video-prep/${token}`;
  const settled = await Promise.allSettled(
    prepared.imageUrls.slice(0, MAX_IMAGES).map((imageUrl, index) => downloadPreparedImage(imageUrl, dirAbs, webPrefix, index)),
  );
  const images = settled
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((v): v is { url: string; name: string } => Boolean(v));

  return jsonOk({ requirement: prepared.requirement, images });
}