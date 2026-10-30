import { readFile, unlink, writeFile } from "node:fs/promises";
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
 * 批量把本地 SVG 光栅化成 JPG。
 *
 * 关键：**只启动一次 Chrome**，在同一页面里逐张导航截图。
 * 早先是「每张各起一次 Chrome」，8 张要 29 秒；批量后 6-8 秒。
 * 失败由调用方回退（跳过该张，不影响其它张）。
 */
async function rasterizeSvgBatch(
  jobs: { src: string; out: string; scale?: number }[]
): Promise<{ ok: boolean; detail?: string }[]> {
  if (jobs.length === 0) return [];

  const jobsFile = path.join(os.tmpdir(), `svg-jobs-${randomUUID()}.json`);
  const script = path.join(process.cwd(), "scripts", "svg-to-jpg.mjs");
  try {
    await writeFile(jobsFile, JSON.stringify(jobs), "utf8");
  } catch {
    return jobs.map(() => ({ ok: false, detail: "任务文件写入失败" }));
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--batch", jobsFile], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const done = (results: { ok: boolean; detail?: string }[]) => {
      unlink(jobsFile).catch(() => {});
      resolve(results);
    };

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", () => {
      const last = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .reverse()
        .find((l) => l.startsWith("{"));
      let parsed: { ok?: boolean; results?: { ok?: boolean; detail?: string }[]; detail?: string } | null = null;
      try {
        parsed = last ? JSON.parse(last) : null;
      } catch {
        parsed = null;
      }
      if (parsed?.ok && Array.isArray(parsed.results) && parsed.results.length === jobs.length) {
        done(parsed.results.map((r) => ({ ok: Boolean(r?.ok), detail: r?.detail })));
        return;
      }
      if (stderr.trim()) console.error("[images-zip] svg-to-jpg:", stderr.trim().slice(0, 300));
      const detail = parsed?.detail || "批量光栅化失败";
      done(jobs.map(() => ({ ok: false, detail })));
    });
    child.on("error", () => done(jobs.map(() => ({ ok: false, detail: "无法启动光栅化进程" }))));
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

  // 先把图片来源分类：SVG 走一次 Chrome 会话批量光栅化，其余直接取字节
  const dataByIndex = new Map<number, { data: Buffer; ext: string }>();
  const svgJobs: { index: number; src: string; out: string }[] = [];

  for (let i = 0; i < images.length; i++) {
    const url = images[i];
    if (url.startsWith("/uploads/covers/")) {
      const filename = path.basename(url);
      const isSvg = /\.svg$/i.test(filename);
      if (!isSvg && !/^[\w-]+\.(png|jpg|jpeg|webp)$/i.test(filename)) continue;
      const abs = path.join(LOCAL_IMAGES_DIR, filename);
      if (isSvg) {
        svgJobs.push({ index: i, src: abs, out: path.join(os.tmpdir(), `rewrite-${randomUUID()}.jpg`) });
      } else {
        const data = await readFile(abs).catch(() => null);
        if (data) dataByIndex.set(i, { data, ext: filename.split(".").pop()!.toLowerCase() });
      }
    } else if (/^https?:\/\//i.test(url)) {
      const data = await fetchRemoteBytes(url);
      if (data) dataByIndex.set(i, { data, ext: "jpg" });
    }
  }

  // 一次 Chrome 会话渲染全部 SVG（原来每张各起一个 Chrome，8 张要 29s）
  if (svgJobs.length > 0) {
    const results = await rasterizeSvgBatch(svgJobs.map((j) => ({ src: j.src, out: j.out, scale: 2 })));
    for (let k = 0; k < svgJobs.length; k++) {
      const job = svgJobs[k];
      if (results[k]?.ok) {
        const data = await readFile(job.out).catch(() => null);
        if (data) dataByIndex.set(job.index, { data, ext: "jpg" });
      }
      await unlink(job.out).catch(() => {});
    }
  }

  const files: ZipFile[] = [];
  for (let i = 0; i < images.length; i++) {
    const hit = dataByIndex.get(i);
    if (!hit) continue;
    files.push({ name: `${String(i + 1).padStart(2, "0")}-主图.${hit.ext}`, data: hit.data });
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
