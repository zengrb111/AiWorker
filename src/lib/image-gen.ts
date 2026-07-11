/**
 * Image generation utility — uses pollinations.ai free API (no key required).
 * Returns a URL that serves an AI-generated image based on the text prompt.
 */

function buildPromptFromContent(title: string, body: string): string {
  // Extract first meaningful sentence or use title
  const firstLine = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  const base = firstLine || title;
  // Keep prompt concise for better image quality
  const cleanBase = base.replace(/[*#`>_~]/g, "").trim().slice(0, 120);
  return `${cleanBase}, digital art, professional illustration, high quality, vibrant colors`;
}

function buildImageUrl(prompt: string, width: number, height: number, seed: number): string {
  const encoded = encodeURIComponent(prompt);
  return `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&seed=${seed}&nologo=true&model=flux`;
}

export type GeneratedImages = {
  coverImageUrl: string;
};

export function generateImageUrls(
  title: string,
  body: string,
  existingCount = 0
): GeneratedImages {
  const coverPrompt = buildPromptFromContent(title, body);
  const coverSeed = Date.now() + existingCount;
  const coverImageUrl = buildImageUrl(coverPrompt, 1200, 630, coverSeed);
  return { coverImageUrl };
}

/** Regenerate a single image URL with a new seed. */
export function regenerateImage(prompt: string, width: number, height: number): string {
  const cleanPrompt = prompt.replace(/[*#`>_~]/g, "").trim().slice(0, 120);
  const seed = Math.floor(Math.random() * 1000000);
  return buildImageUrl(`${cleanPrompt}, digital art, professional illustration`, width, height, seed);
}

/** Extract a prompt from article content for a specific image index. */
export function extractImagePrompt(title: string, body: string, imageIndex: number): string {
  if (imageIndex === 0) {
    return buildPromptFromContent(title, body);
  }
  const paragraphs = body.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const paraIdx = Math.min(imageIndex, paragraphs.length - 1);
  const para = paragraphs[paraIdx] || title;
  return para.replace(/[*#`>_~]/g, "").trim().slice(0, 120);
}
