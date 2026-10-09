import { readFile } from "node:fs/promises";
import path from "node:path";
import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { LOCAL_IMAGES_DIR } from "@/lib/image-gen";
import { buildZipStore, type ZipFile } from "@/lib/zip-store";

/** 把单张图片 URL 解析成本地/远程字节。 */
async function fetchImageBytes(url: string): Promise<Buffer | null> {
  if (url.startsWith("/uploads/covers/")) {
    const filename = path.basename(url);
    if (!/^[\w-]+\.(png|jpg|jpeg|svg|webp)$/i.test(filename)) return null;
    try {
      return await readFile(path.join(LOCAL_IMAGES_DIR, filename));
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }
  return null;
}

/** GET /api/content/[id]/images-zip — 把内容的「主图」打包成 zip 下载。 */
export async function GET(_request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const contentItem = await prisma.contentItem.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!contentItem) {
    return jsonError("内容不存在。", 404);
  }

  // 主图来源：优先 inlineImagesJson（仿写多图），否则回退到单张封面
  let images: string[] = [];
  try {
    const parsed = JSON.parse(contentItem.inlineImagesJson || "[]");
    if (Array.isArray(parsed)) images = parsed.filter((x) => typeof x === "string");
  } catch {
    images = [];
  }
  if (images.length === 0 && contentItem.coverImageUrl) {
    images = [contentItem.coverImageUrl];
  }
  if (images.length === 0) {
    return jsonError("该内容还没有可下载的主图。", 404);
  }

  const files: ZipFile[] = [];
  for (let i = 0; i < images.length; i++) {
    const bytes = await fetchImageBytes(images[i]);
    if (!bytes) continue;
    const ext = /\.svg$/i.test(images[i]) ? "svg" : /\.png$/i.test(images[i]) ? "png" : "jpg";
    files.push({ name: `${String(i + 1).padStart(2, "0")}-主图.${ext}`, data: bytes });
  }
  if (files.length === 0) {
    return jsonError("主图下载失败，请重试。", 502);
  }

  const zip = buildZipStore(files);
  const safeTitle = (contentItem.title || "content").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  const encodedName = encodeURIComponent(`${safeTitle}_主图.zip`);

  return new Response(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="master-images.zip"; filename*=UTF-8''${encodedName}`
    }
  });
}
