/**
 * 视频封面（poster）抽取。
 *
 * 内容库列表对图文用 coverImageUrl 当封面，视频条目以前没有这张图，只能显示通用占位图，
 * 一眼看不出是哪个片子。这里用 ffmpeg 抽一帧存成 jpg，写回 ContentItem.coverImageUrl，
 * 列表 / 详情页 / 推送（心灵驿站 poster）都能直接用。
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = join(process.cwd(), "public", "uploads", "covers");

/** /videos/xxx.mp4 或 /uploads/xxx.mp4 → 本地绝对路径；远程 URL 返回 null。 */
export function localVideoPath(videoUrl: string | null | undefined): string | null {
  if (!videoUrl) return null;
  if (videoUrl.startsWith("/videos/") || videoUrl.startsWith("/uploads/")) {
    return join(process.cwd(), "public", videoUrl);
  }
  return null;
}

/**
 * 从视频抽一帧当封面，返回站内 URL（/uploads/covers/xxx.jpg）。
 * ffmpeg 不可用或抽帧失败返回 null（调用方保持原封面即可）。
 */
export async function extractVideoPoster(
  videoUrl: string | null | undefined,
  name: string,
  atSeconds = 0.6
): Promise<string | null> {
  const source = localVideoPath(videoUrl);
  if (!source) return null;

  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const file = `${safeName}.jpg`;
  const target = join(OUT_DIR, file);

  try {
    await mkdir(OUT_DIR, { recursive: true });
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(
        "ffmpeg",
        ["-y", "-v", "error", "-ss", String(atSeconds), "-i", source, "-frames:v", "1", "-vf", "scale=720:-1", target],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    if (!ok) return null;
    return `/uploads/covers/${file}`;
  } catch {
    return null;
  }
}
