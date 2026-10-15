import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import {
  classifyGatewayError,
  friendlyGatewayError,
  openClawClient,
  type GatewayFailureKind,
} from "@/lib/openclaw";
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
    "2) 挑选与该主题高度相关的真实新闻配图（http/https 直链），用作视频参考图。",
    "   - 数量：尽量给出 10~14 张，宁多勿少（部分链接可能失效，系统会自动过滤）。",
    "   - 来源：尽量覆盖多个不同的新闻站点/媒体，不要全部来自同一家。",
    "   - 内容：优先选正文内容图（现场照片、示意图、数据图），避免站点 logo、二维码、广告位、小图标。",
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
  let gatewayKind: GatewayFailureKind | null = null;
  try {
    const result = await openClawClient.sendTaskStream({ message: prompt, prompt, userId: user.id }, () => {}, PREPARE_TIMEOUT_MS);
    agentText = result.content ?? "";
  } catch (error) {
    // 存原始 message 与分类 kind：分类用于降级判断与日志，
    // 原始 message 供下面的 DSH 降级路径展示「为什么降级」。
    taskError = error instanceof Error ? error.message : "未知错误";
    gatewayKind = classifyGatewayError(error).kind;
    if (process.env.NODE_ENV !== "production") {
      console.error(`[gen-video/prepare] 网关调用失败 kind=${gatewayKind} ${taskError}`);
    }
  }

  const prepared = parsePrepared(agentText);

  // ---- 降级：OpenClaw 网关不可用时，改用 DSH 纯文本整理创作要求 ----
  //
  // 网关是独立进程（默认 localhost:18789），没启动是常态而非异常。
  // 而这一步的本质是「把热点主题 + 产品知识整理成一份可执行的创作要求」，
  // 属于纯文本任务，DSH 完全能胜任 —— 它只是拿不到联网资讯和新闻配图。
  // 所以宁可退化成「只有创作要求、没有配图」，也不要让整条出片链路卡死：
  // 参考图可以由用户在面板里手动上传。
  if (!prepared.requirement) {
    const dsh = await getDshStatus();
    if (dsh.ok) {
      try {
        const dshText = await runDshText({ prompt: localPreparePrompt(topic, kbText), sessionId: `prepare-${topic}` });
        const local = parseRequirement(dshText);
        if (local) {
          console.warn("[gen-video/prepare] OpenClaw 不可用，已降级为 DSH 本地整理创作要求（无联网配图）");
          return jsonOk({
            requirement: local,
            images: [],
            degraded: true,
            // 同样走友好文案：降级提示会直接展示给用户，不能带技术细节或空串
            degradedReason: taskError ? friendlyGatewayError(taskError) : "联网检索不可用",
          });
        }
      } catch (error) {
        // 降级是最后一道防线，它失败时必须留下可定位的痕迹 ——
        // 否则用户只会看到「网关不可用」这条错误文案，完全不知道真实原因。
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
    // 记录原始返回，便于排查 agent 是否按 JSON 格式输出。
    console.error("[gen-video/prepare] agent 未返回可用 requirement，原始内容：", agentText.slice(0, 600) || "(空)");
    const gatewayHint = "请启动 OpenClaw 网关（默认 http://localhost:18789），或直接在本面板手动填写创作要求。";
    // 走 friendlyGatewayError 转换：此前直接拼原始 message，
    // 会把「OpenClaw Gateway 连接失败：」这种空串尾巴暴露给用户。
    const friendly = taskError ? friendlyGatewayError(taskError) : "";
    return jsonError(
      taskError
        ? `短视频创作要求整理失败：${friendly}。${gatewayHint}`
        : `未能根据该热点整理出有效的短视频创作要求。${gatewayHint}`,
      400,
      { kind: gatewayKind ?? "unknown" },
    );
  }

  // 并发下载配图；个别失败仅跳过，由候选池补位，最终凑满 MAX_IMAGES 张。
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const dirAbs = join(process.cwd(), "public", "uploads", "gen-video-prep", token);
  await mkdir(dirAbs, { recursive: true });
  const webPrefix = `/uploads/gen-video-prep/${token}`;
  const settled = await Promise.allSettled(
    prepared.imageUrls.slice(0, CANDIDATE_LIMIT).map((imageUrl, index) => downloadPreparedImage(imageUrl, dirAbs, webPrefix, index)),
  );
  const images = settled
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((v): v is { url: string; name: string } => Boolean(v))
    .slice(0, MAX_IMAGES)
    // 重新编号为 ref-0..ref-N，避免候选用尽后文件名出现空洞（如 ref-13）。
    .map((image, index) => ({ url: image.url, name: `ref-${index}.${image.name.split(".").pop() || "jpg"}` }));

  return jsonOk({ requirement: prepared.requirement, images });
}