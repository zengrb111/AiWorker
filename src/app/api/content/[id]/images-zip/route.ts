import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { LOCAL_IMAGES_DIR } from "@/lib/image-gen";
import { buildZipStore, type ZipFile } from "@/lib/zip-store";

/** 把单张远程图片 URL 解析成字节。 */
async function fetchRemoteBytes(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * 把本地 SVG 光栅化成 JPG（项目无图片库，用本机 headless Chrome，复用 scripts/svg-to-jpg.mjs）。
 * 失败返回 null，由调用方回退。
 */
async function rasterizeSvgToJpg(svgAbsPath: string): Promise<Buffer | null> {
  const outJpg = path.join(os.tmpdir(), `rewrite-${randomUUID()}.jpg`);
  const script = path.join(process.cwd(), "scripts", "svg-to-jpg.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, svgAbsPath, outJpg, "2"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", async () => {
      try {
        const last = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .reverse()
          .find((l) => l.startsWith("{"));
        const parsed = last ? JSON.parse(last) : null;
        if (parsed?.ok) {
          const buf = await readFile(outJpg);
          try {
            await import("node:fs/promises").then((f) => f.unlink(outJpg));
          } catch {
            /* ignore */
          }
          resolve(buf);
        } else {
          if (stderr.trim()) console.error("[images-zip] svg-to-jpg:", stderr.trim().slice(0, 200));
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
    child.on("error", () => resolve(null));
  });
}

/** GET /api/content/[id]/images-zip — 把内容的「主图」打包成 zip 下载（JPG）。 */
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
    const url = images[i];
    let data: Buffer | null = null;
    let ext = "jpg";

    if (url.startsWith("/uploads/covers/")) {
      const filename = path.basename(url);
      const isSvg = /\.svg$/i.test(filename);
      if (!isSvg && !/^[\w-]+\.(png|jpg|jpeg|webp)$/i.test(filename)) continue;
      const abs = path.join(LOCAL_IMAGES_DIR, filename);
      if (isSvg) {
        data = await rasterizeSvgToJpg(abs); // 光栅成 JPG，保留圆角
        ext = "jpg";
      } else {
        data = await readFile(abs).catch(() => null);
      }
    } else if (/^https?:\/\//i.test(url)) {
      data = await fetchRemoteBytes(url);
    }

    if (!data) continue;
    files.push({ name: `${String(i + 1).padStart(2, "0")}-主图.${ext}`, data });
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
