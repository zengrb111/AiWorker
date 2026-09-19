import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { regenerateImageWithFallback, extractImagePrompt, deleteLocalImage, coverPlatformOf, coverSizeOf } from "@/lib/image-gen";

type RegenBody = {
  imageType?: "cover" | "inline";
  imageIndex?: number;
};

/** POST /api/content/[id]/regenerate-image — regenerate a single image for a content item. */
export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const body = await readJson<RegenBody>(request);
  const imageType = body.imageType ?? "cover";
  const imageIndex = body.imageIndex ?? 0;

  const contentItem = await prisma.contentItem.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!contentItem) {
    return jsonError("内容不存在。", 404);
  }

  // 封面按内容所属平台出图：小红书 3:4 竖版、公众号 16:10 横版，
  // 并且 prompt 与首次生成时保持同一套平台调性，重绘风格才不会漂移。
  const platform = coverPlatformOf(contentItem.category);
  const prompt = extractImagePrompt(contentItem.title, contentItem.body, imageIndex, platform);

  if (imageType === "cover") {
    const { width, height } = coverSizeOf(platform);
    const coverImageUrl = await regenerateImageWithFallback(prompt, width, height);
    // Clean up the old locally stored cover (no-op for remote URLs).
    deleteLocalImage(contentItem.coverImageUrl);
    const updated = await prisma.contentItem.update({
      where: { id: contentItem.id },
      data: { coverImageUrl }
    });
    return jsonOk({ contentItem: updated, imageUrl: coverImageUrl });
  }

  // Regenerate an inline image
  let inlineImages: string[] = [];
  try {
    const parsed = JSON.parse(contentItem.inlineImagesJson || "[]");
    if (Array.isArray(parsed)) {
      inlineImages = parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    inlineImages = [];
  }

  // Extend array if needed
  while (inlineImages.length <= imageIndex) {
    inlineImages.push("");
  }

  const oldUrl = inlineImages[imageIndex];
  const newUrl = await regenerateImageWithFallback(prompt, 1200, 800);
  deleteLocalImage(oldUrl);
  inlineImages[imageIndex] = newUrl;

  const updated = await prisma.contentItem.update({
    where: { id: contentItem.id },
    data: { inlineImagesJson: JSON.stringify(inlineImages) }
  });

  return jsonOk({ contentItem: updated, imageUrl: newUrl });
}
