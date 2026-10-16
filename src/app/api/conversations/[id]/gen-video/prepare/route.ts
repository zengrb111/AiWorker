import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { chatComplete, UpstreamModelError } from "@/lib/llm-client";
import { searchWeb, isBuiltinHotBoard } from "@/lib/web-search";
import { searchImages, refererFor } from "@/lib/image-search";
import { ModelConfigError, snapshotUserConfig } from "@/lib/model-credentials";
import { getDshStatus, runDshText } from "@/lib/dsh";
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
const MAX_IMAGES = 12;
/** 候选直链探测上限：多给一些候选，下载失败时自动补位，最终凑满 MAX_IMAGES 张。 */
const CANDIDATE_LIMIT = 26;

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

/**
 * 从模型输出里提取 { requirement, imageKeywords }，多级容错。
 *
 * 配图不再由模型给 URL —— 它能看到的素材链接全是榜单页（不是图片），
 * 让它"挑 URL"只会挑出一堆下载失败的页面地址。改为让它出检索词，
 * 图片直链由 image-search 去图库取。
 */
function parsePrepared(text: string): { requirement: string; imageKeywords: string[] } {
  const raw = (text ?? "").trim();
  if (!raw) return { requirement: "", imageKeywords: [] };
  const unfenced = raw.replace(/```json\s*([\s\S]*?)```/i, "$1").replace(/```/g, "").trim();
  const candidates: string[] = [unfenced];
  const brace = unfenced.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as {
        requirement?: unknown;
        imageKeywords?: unknown;
        keywords?: unknown;
        // 兼容老格式：模型仍可能输出 imageUrls，届时当作关键词来源之一
        imageUrls?: unknown;
      };
      const requirement = typeof obj.requirement === "string" ? obj.requirement.trim() : "";
      const rawList = Array.isArray(obj.imageKeywords)
        ? obj.imageKeywords
        : Array.isArray(obj.keywords)
          ? obj.keywords
          : [];
      const imageKeywords = (rawList as unknown[])
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length >= 2 && item.length <= 40)
        .slice(0, 6);
      if (requirement) return { requirement, imageKeywords };
    } catch {
      // 尝试下一个候选片段
    }
  }
  return { requirement: "", imageKeywords: [] };
}

/**
 * 降级用的纯文本 prompt：不要求联网检索，也不要求输出配图。
 *
 * 拿不到实时资讯是降级模式的固有代价，所以 prompt 里明确要求模型
 * 只基于主题与产品知识本身做创意策划，不要编造具体新闻事实与数据。
 */
function localPreparePrompt(topic: string, kbText: string): string {
  return [
    "你是一名短视频编导。请围绕下面这个主题，结合给定的产品知识，产出一条竖版短视频的创作方案。",
    "",
    `【主题】${topic}`,
    kbText ? `\n【可参考的产品知识】\n${kbText}` : "",
    "",
    "请写明：主题切入角度、旁白文案方向、分镜与节奏、画面与风格、时长建议、结尾引导，具体可执行。",
    "",
    "注意：本次无法联网检索，请只基于主题与产品知识做创意策划，",
    "不要编造具体的新闻事实、统计数据或引用来源。",
    "",
    "只输出一个 JSON 代码块，不要任何其它说明文字：",
    "```json",
    '{"requirement":"（创作要求全文）"}',
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 从模型输出里提取创作要求全文。降级场景不需要配图，所以只认 requirement 字段。 */
function parseRequirement(text: string): string {
  const raw = (text ?? "").trim();
  if (!raw) return "";
  const unfenced = raw.replace(/```json\s*([\s\S]*?)```/i, "$1").replace(/```/g, "").trim();
  const brace = unfenced.match(/\{[\s\S]*\}/);
  for (const candidate of [unfenced, brace?.[0] ?? ""]) {
    if (!candidate) continue;
    try {
      const obj = JSON.parse(candidate) as { requirement?: unknown };
      if (typeof obj.requirement === "string" && obj.requirement.trim()) return obj.requirement.trim();
    } catch {
      // 尝试下一个候选片段
    }
  }
  // 连 JSON 都没有时，把全文当创作要求用 —— 宁可给用户一段能改的文本，也不要空手而归
  return unfenced && unfenced.length > 40 ? unfenced : "";
}

/**
 * 下载单张远程配图到本地，返回同源可访问 URL；失败返回 null（跳过该图，不阻断整体）。
 */
async function downloadPreparedImage(
  imageUrl: string,
  dirAbs: string,
  webPrefix: string,
  index: number,
  referer?: string
): Promise<{ url: string; name: string } | null> {
  try {
    const resp = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ChuangxingyunAIWorker/1.0)",
        // 第三方新闻图/图库普遍有防盗链，回源 Referer 能显著提高成功率
        ...(referer ? { Referer: referer } : {})
      },
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
    "你是一名短视频编导。请围绕下面这个热点主题，结合给定的真实资讯素材与产品知识，产出一条竖版短视频的创作方案。",
    "",
    `【热点主题】${topic}`,
    kbText ? `\n【可参考的产品知识】\n${kbText}` : "",
    "",
    "请完成两件事：",
    "1) 整理创作要求：写明主题切入角度、旁白文案方向、分镜与节奏、画面与风格、时长建议、结尾引导，具体可执行。",
    "2) 给出 3~6 个配图检索词（imageKeywords），用于系统去图库检索真实新闻配图。",
    "   - 每个检索词是可独立检索到新闻现场照片的**具体名词短语**，例如「深圳 禁鸣喇叭 新规」「火箭队 雷霆 季后赛」。",
    "   - 不要输出网址、不要输出图片链接：素材里的链接都是榜单页面，不能直接当图片用。",
    "   - 从不同角度拆分（事件主体、现场画面、相关行业、数据图表等），避免全部围绕同一个词。",
    "",
    "只输出一个 JSON 代码块，不要任何其它说明文字：",
    "```json",
    '{"requirement":"（创作要求全文）","imageKeywords":["检索词1","检索词2","检索词3"]}',
    "```",
  ]
    .filter(Boolean)
    .join("\n");

  let agentText = "";
  let taskError: string | null = null;
  let failureKind: string | null = null;
  let usedBuiltinBoards = false;
  // 快照一次配置：搜索与对话用同一份用户配置。
  const snapshot = await snapshotUserConfig(user.id);
  try {
    // 第一步：真实联网搜索（失败不编造，直接走下面的 DSH 降级整理创作要求）。
    const hits = await searchWeb({ userId: user.id, query: topic, topK: 12, config: snapshot.search });
    usedBuiltinBoards = isBuiltinHotBoard(hits);
    const material = hits
      .map((hit, index) => `${index + 1}. ${hit.title}\n   链接：${hit.url}\n   摘要：${hit.snippet}`)
      .join("\n");
    const fullPrompt = [
      `【资讯素材】\n${material}`,
      "",
      prompt
    ].join("\n");

    // 第二步：交给用户配置的对话模型整理创作要求并挑选配图。
    const result = await chatComplete({
      userId: user.id,
      capability: "chat",
      config: snapshot.chat ?? undefined,
      prompt: fullPrompt,
      timeoutMs: PREPARE_TIMEOUT_MS
    });
    agentText = result.content ?? "";
  } catch (error) {
    // 存原始 message 与分类 kind：分类用于降级判断与日志，
    // 原始 message 供下面的 DSH 降级路径展示「为什么降级」。
    taskError = error instanceof Error ? error.message : "未知错误";
    failureKind =
      error instanceof UpstreamModelError || error instanceof ModelConfigError
        ? error.kind
        : "unknown";
    console.error(`[gen-video/prepare] 联网检索或模型整理失败 kind=${failureKind} ${taskError}`);
  }

  const prepared = parsePrepared(agentText);

  // ---- 降级：联网检索或模型调用不可用时，改用 DSH 纯文本整理创作要求 ----
  //
  // 这一步的本质是「把热点主题 + 产品知识整理成一份可执行的创作要求」，
  // 属于纯文本任务，DSH 完全能胜任 —— 它只是拿不到联网资讯和新闻配图。
  // 所以宁可退化成「只有创作要求、没有配图」，也不要让整条出片链路卡死：
  // 参考图可以由用户在面板里手动上传。
  if (!prepared.requirement) {
    const dsh = await getDshStatus(user.id);
    if (dsh.ok) {
      try {
        const dshText = await runDshText({
          userId: user.id,
          prompt: localPreparePrompt(topic, kbText),
          sessionId: `prepare-${topic}`
        });
        const local = parseRequirement(dshText);
        if (local) {
          console.warn("[gen-video/prepare] 联网检索或模型调用不可用，已降级为 DSH 本地整理创作要求（无联网配图）");
          return jsonOk({
            requirement: local,
            images: [],
            degraded: true,
            degradedReason: taskError ? `${taskError}（已降级为本地整理，无联网配图）` : "联网检索不可用",
          });
        }
      } catch (error) {
        // 降级是最后一道防线，它失败时必须留下可定位的痕迹 ——
        // 否则用户只会看到一条笼统错误，完全不知道真实原因。
        console.error(
          `[gen-video/prepare] DSH降级整理失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      console.warn("[gen-video/prepare] DSH 不可用：", dsh.reason);
    }
  }

  if (!prepared.requirement) {
    // 记录原始返回，便于排查模型是否按 JSON 格式输出。
    console.error("[gen-video/prepare] 模型未返回可用 requirement，原始内容：", agentText.slice(0, 600) || "(空)");
    const hint = "请在「系统配置」中检查联网搜索与对话模型的配置，或直接在本面板手动填写创作要求。";
    return jsonError(
      taskError
        ? `短视频创作要求整理失败：${taskError}。${hint}`
        : `未能根据该热点整理出有效的短视频创作要求。${hint}`,
      400,
      { kind: failureKind ?? "unknown" },
    );
  }

  // 配图：模型只给检索词，图片直链一律去图库取（模型看到的素材是榜单页，不是图片）。
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const dirAbs = join(process.cwd(), "public", "uploads", "gen-video-prep", token);
  await mkdir(dirAbs, { recursive: true });
  const webPrefix = `/uploads/gen-video-prep/${token}`;

  let candidates: Array<{ url: string; host: string; title: string; keyword: string }> = [];
  let imageSearchNote = "";
  if (prepared.imageKeywords.length > 0) {
    try {
      candidates = await searchImages(prepared.imageKeywords, CANDIDATE_LIMIT);
    } catch (error) {
      imageSearchNote = error instanceof Error ? error.message : String(error);
      console.error(`[gen-video/prepare] 图片检索失败：${imageSearchNote}`);
    }
  } else {
    imageSearchNote = "模型未给出配图检索词";
  }

  // 并发下载配图；个别失败仅跳过，由候选池补位，最终凑满 MAX_IMAGES 张。
  const settled = await Promise.allSettled(
    candidates
      .slice(0, CANDIDATE_LIMIT)
      .map((candidate, index) =>
        downloadPreparedImage(candidate.url, dirAbs, webPrefix, index, refererFor(candidate))
      )
  );
  const images = settled
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((v): v is { url: string; name: string } => Boolean(v))
    .slice(0, MAX_IMAGES)
    // 重新编号为 ref-0..ref-N，避免候选用尽后文件名出现空洞（如 ref-13）。
    .map((image, index) => ({ url: image.url, name: `ref-${index}.${image.name.split(".").pop() || "jpg"}` }));

  // 数据来源如实回传：内置公开热榜是零 key 的公开榜单，不等于用户付费搜出来的结果，
  // 界面上据此给一句轻提示，避免用户以为已经用上了自己的搜索服务。
  return jsonOk({
    requirement: prepared.requirement,
    images,
    sourceKind: usedBuiltinBoards ? "builtin-hot-boards" : "user-search-service",
    ...(imageSearchNote ? { imageSearchNote } : {})
  });
}