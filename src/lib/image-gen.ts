/**
 * Image generation utility — uses pollinations.ai free API (no key required).
 * Returns a URL that serves an AI-generated image based on the text prompt.
 */

/**
 * Clean text for use as an image prompt:
 * - remove markdown symbols
 * - remove quotes/apostrophes (pollinations returns 500 on some of them)
 * - collapse whitespace
 */
function sanitizePrompt(text: string): string {
  return text
    .replace(/[''""]/g, "")
    .replace(/[*#`>_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect agent tool-call / reasoning narration that leaked into the message
 * content (e.g. "I'll write a post... Let me grab some grounding first.").
 * These lines are meaningless as image prompts and often break the API.
 */
function isReasoningNoise(line: string): boolean {
  return /(i'll|i will|let me|let's|ok,|sure,|bing|google|搜索结果|返回的结果|跑偏|抓到|先看|再试|grounding|actually|hmm|wait[,．.])/i.test(line);
}

function buildPromptFromContent(title: string, body: string): string {
  // Prefer the article title — it is extracted from markdown headings and is
  // clean and descriptive. Body first line is only a fallback.
  let base = sanitizePrompt(title).slice(0, 120);
  if (base.length < 8) {
    const firstLine = body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#") && !isReasoningNoise(l));
    if (firstLine) base = sanitizePrompt(firstLine).slice(0, 120);
  }
  return `${base}, digital art, professional illustration, high quality, vibrant colors`;
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
  // pollinations rejects very large seeds (e.g. Date.now() ~ 1.7e12) with 500.
  // Keep the seed small like regenerateImage does.
  const coverSeed = (Math.floor(Math.random() * 900000) + existingCount) % 1000000;
  const coverImageUrl = buildImageUrl(coverPrompt, 1200, 630, coverSeed);
  return { coverImageUrl };
}

/** Regenerate a single image URL with a new seed. */
export function regenerateImage(prompt: string, width: number, height: number): string {
  const cleanPrompt = sanitizePrompt(prompt).slice(0, 120);
  const seed = Math.floor(Math.random() * 1000000);
  return buildImageUrl(`${cleanPrompt}, digital art, professional illustration`, width, height, seed);
}

/** Extract a prompt from article content for a specific image index. */
export function extractImagePrompt(title: string, body: string, imageIndex: number): string {
  if (imageIndex === 0) {
    return buildPromptFromContent(title, body);
  }
  const paragraphs = body.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !isReasoningNoise(l));
  const paraIdx = Math.min(imageIndex, paragraphs.length - 1);
  const para = paragraphs[paraIdx] || title;
  return sanitizePrompt(para).slice(0, 120);
}
