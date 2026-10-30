/**
 * POST /api/content/[id]/video-cover —— 给视频条目重新生成一张封面。
 *
 * 每次调用都会**换一版**：截图的视频位置按版本号轮换，标题也重新按配文写一句
 * （模型不可用时从配文里换一句兜底），并把新封面写回 `ContentItem.coverImageUrl`，
 * 内容库列表卡片与详情页立刻同步。
 *
 * 只对「有 videoUrl 的条目」有意义；图文条目的封面走 `/regenerate-image`。
 */
import { unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { coverVariantOf, generateVideoCover } from "@/lib/video/cover";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const COVER_DIR = join(process.cwd(), "public", "uploads", "covers");

/** 从 `/videos/huashu-<token>-v<N>.mp4` 取文件名前缀；取不到就用条目 id。 */
function coverNameOf(videoUrl: string, id: string): string {
  const hit = /\/videos\/(huashu-[A-Za-z0-9-]+-v\d+)\.mp4$/.exec(videoUrl);
  return hit ? hit[1] : `content-${id}`;
}

/** 只删同一个视频的旧版封面文件，且必须在 covers 目录内（防越权删文件）。 */
async function removeOldCover(url: string | null, keep: string): Promise<void> {
  if (!url || !url.startsWith("/uploads/covers/")) return;
  const name = basename(url);
  if (name === keep || !/^[\w.-]+\.jpg$/i.test(name)) return;
  await unlink(join(COVER_DIR, name)).catch(() => undefined);
}

export async function POST(_request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const item = await prisma.contentItem.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!item) return jsonError("内容不存在。", 404);
  if (!item.videoUrl) return jsonError("这条内容不是视频，没有可截图的成片。", 400);

  // 版本号递增：当前封面是 -c3.jpg 就出 -c4；老封面（不带 -cN）从 1 开始。
  const current = coverVariantOf(item.coverImageUrl);
  const variant = current === null ? 1 : current + 1;

  const cover = await generateVideoCover({
    videoUrl: item.videoUrl,
    userId: user.id,
    name: coverNameOf(item.videoUrl, item.id),
    title: item.title,
    body: item.body,
    variant
  }).catch(() => null);
  if (!cover) return jsonError("封面生成失败：拿不到成片文件或截图失败。", 500);

  const updated = await prisma.contentItem.update({
    where: { id: item.id },
    data: { coverImageUrl: cover.url }
  });
  await removeOldCover(item.coverImageUrl, basename(cover.url));

  return jsonOk({
    contentItem: updated,
    coverImageUrl: cover.url,
    coverTitle: cover.title,
    variant: cover.variant
  });
}
