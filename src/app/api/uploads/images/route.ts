/**
 * POST /api/uploads/images —— 图片「随手传」。
 *
 * 两个用途共用一个口：
 * - 默认：定时任务参考图，存 public/uploads/scheduled/，原图落盘。
 * - scope=article：作品正文里 Ctrl+V 粘贴 / 拖入的图片，存 public/uploads/articles/，
 *   并自动压到 1MB 内（微信公众号 media/uploadimg 单图上限 1MB，粘贴的 PNG 截图动辄几 MB）。
 *
 * 只收图片（jpg/png/webp），单张 ≤10MB，一次最多 6 张。
 * nginx 已配 location ^~ /uploads/ 直出磁盘，新增子目录无需改配置。
 */
import { jsonError, jsonOk } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

export const dynamic = "force-dynamic";

const MAX_FILES = 6;
const MAX_BYTES = 10 * 1024 * 1024;
/** 微信 media/uploadimg 限制 1MB，留 74KB 余量给 multipart 开销。 */
const MAX_ARTICLE_BYTES = 950 * 1024;
const ALLOWED = new Map([
  [".jpg", "jpg"],
  [".jpeg", "jpg"],
  [".png", "png"],
  [".webp", "webp"]
]);
const MIME_EXT = new Map([
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"]
]);

/** 粘贴出来的 File 常常叫 image.png / blob / 干脆没名字，按 MIME 兜一层。 */
function resolveExt(file: File): string | null {
  return ALLOWED.get(extname(file.name || "").toLowerCase()) ?? MIME_EXT.get((file.type || "").toLowerCase()) ?? null;
}

/** 文件头校验，别让改了扩展名的非图片落进 public。 */
function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return true;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  return buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
}

/**
 * 正文图统一转 JPEG：等比缩到最长边 1600 内，逐步降质 / 缩尺寸直到 ≤950KB。
 * 先铺白底，否则透明 PNG 转 JPEG 会变黑块。解码失败（如某些 webp）就回退原图。
 */
async function compressForArticle(raw: Buffer): Promise<Buffer | null> {
  try {
    const img = await loadImage(raw);
    let scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    for (let attempt = 0; attempt < 4; attempt++) {
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const out = await canvas.encode("jpeg", [85, 75, 65, 55][attempt]);
      if (out.length <= MAX_ARTICLE_BYTES) return Buffer.from(out);
      scale *= 0.75;
    }
  } catch (error) {
    console.warn("[uploads/images] 图片压缩失败，回退原图：", error);
  }
  return null;
}

export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const form = await request.formData();
  const isArticle = String(form.get("scope") || "").trim() === "article";
  const files = form.getAll("file").filter(
    (entry): entry is File => entry instanceof File && entry.size > 0
  );
  if (!files.length) return jsonError("没有收到文件。");
  if (files.length > MAX_FILES) return jsonError(`一次最多上传 ${MAX_FILES} 张。`);

  const dir = join(process.cwd(), "public", "uploads", isArticle ? "articles" : "scheduled");
  await mkdir(dir, { recursive: true });

  const urls: string[] = [];
  for (const file of files) {
    const ext = resolveExt(file);
    if (!ext) return jsonError("只支持 JPG / PNG / WebP。");
    if (file.size > MAX_BYTES) return jsonError(`单张不能超过 ${MAX_BYTES / 1024 / 1024}MB。`);

    const raw = Buffer.from(await file.arrayBuffer());
    if (!looksLikeImage(raw)) return jsonError("文件内容不是有效的图片。");

    let data: Uint8Array = raw;
    let finalExt = ext;
    if (isArticle) {
      const compressed = await compressForArticle(raw);
      // 原图已小且压完反而更大时保留原图；否则统一用 JPEG。
      if (compressed && (raw.length > MAX_ARTICLE_BYTES || compressed.length < raw.length)) {
        data = compressed;
        finalExt = "jpg";
      }
    }

    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${finalExt}`;
    await writeFile(join(dir, name), data);
    urls.push(`/uploads/${isArticle ? "articles" : "scheduled"}/${name}`);
  }

  return jsonOk({ urls });
}
