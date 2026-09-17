/**
 * Scene media generator — searches free stock footage first, then falls back
 * to AI-generated images from pollinations.ai.
 *
 * Strategy per scene:
 *   1. Try free stock sources (Wikimedia Commons → NASA → Archive.org)
 *      using the scene's search_keywords
 *   2. If no stock match found, fall back to AI image generation (pollinations.ai)
 *      using the scene's visual_prompt
 *
 * All sources are completely free, no API key required.
 * Images are saved to the Remotion composer's public/generated/ directory
 * so Remotion's staticFile() can resolve them during rendering.
 */

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { searchStockMedia, downloadStockImage } from "./stock-footage";

type SceneCut = {
  id?: string;
  visual_prompt?: string;
  search_keywords?: string;
  backgroundImage?: string;
  source?: string;
  [key: string]: unknown;
};

type SceneImageResult = {
  generated: number;
  skipped: number;
  stockUsed: number;
  aiGenerated: number;
};

/**
 * Download an AI-generated image from pollinations.ai and save to a local file.
 */
async function downloadAIImage(
  prompt: string,
  outputPath: string,
  width: number,
  height: number,
  seed: number
): Promise<boolean> {
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&seed=${seed}&nologo=true&model=flux`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(60000), // 60s timeout per image
    });

    if (!response.ok) {
      return false;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1000) {
      return false;
    }

    writeFileSync(outputPath, buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate scene images for all cuts in the Remotion props.
 * Tries free stock media first, falls back to AI generation.
 * Fills cut.backgroundImage with the relative path for Remotion's staticFile().
 *
 * @param props - The Remotion props object (mutated in place)
 * @param composerPublicDir - Path to remotion-composer/public/
 * @param onProgress - Callback for progress updates
 * @returns Number of images generated/skipped + breakdown by source
 */
export async function generateSceneImages(
  props: Record<string, unknown>,
  composerPublicDir: string,
  onProgress?: (text: string) => void
): Promise<SceneImageResult> {
  const cuts = props.cuts as SceneCut[] | undefined;
  if (!cuts || !Array.isArray(cuts)) {
    return { generated: 0, skipped: 0, stockUsed: 0, aiGenerated: 0 };
  }

  // Create output directory
  const generatedDir = join(composerPublicDir, "generated", "scenes");
  if (!existsSync(generatedDir)) {
    mkdirSync(generatedDir, { recursive: true });
  }

  let generated = 0;
  let skipped = 0;
  let stockUsed = 0;
  let aiGenerated = 0;
  const timestamp = Date.now();

  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i];
    const visualPrompt = cut.visual_prompt;
    const searchKeywords = cut.search_keywords;

    if (!visualPrompt || typeof visualPrompt !== "string" || visualPrompt.trim().length === 0) {
      skipped++;
      continue;
    }

    const sceneId = cut.id || `scene-${i + 1}`;
    const fileName = `${sceneId}-${timestamp}.jpg`;
    const filePath = join(generatedDir, fileName);

    // --- Step 1: Try free stock media (Wikimedia / NASA / Archive.org) ---
    if (searchKeywords && searchKeywords.trim().length > 0) {
      onProgress?.(
        `  搜索免费素材 ${i + 1}/${cuts.length}: ${searchKeywords.slice(0, 40)}...`
      );

      const stockResult = await searchStockMedia(searchKeywords);

      if (stockResult) {
        onProgress?.(`  · 找到素材 (${stockResult.source}): ${stockResult.title.slice(0, 30)}`);

        const downloaded = await downloadStockImage(stockResult.url, filePath);
        if (downloaded) {
          cut.backgroundImage = `generated/scenes/${fileName}`;
          cut.source = stockResult.source; // Record which source provided the image
          generated++;
          stockUsed++;
          onProgress?.(`  ✓ 素材 ${i + 1} 下载完成 (${stockResult.source})`);
          continue;
        }
        onProgress?.(`  · 素材下载失败，回退到 AI 生成`);
      } else {
        onProgress?.(`  · 未找到匹配素材，使用 AI 生成`);
      }
    }

    // --- Step 2: Fallback to AI image generation (pollinations.ai) ---
    onProgress?.(`  生成画面 ${i + 1}/${cuts.length}: ${visualPrompt.slice(0, 40)}...`);

    const success = await downloadAIImage(
      visualPrompt,
      filePath,
      1920,
      1080,
      // pollinations rejects very large seeds (Date.now() ~1.7e12) with 500
      Math.floor(Math.random() * 900000) + i
    );

    if (success) {
      cut.backgroundImage = `generated/scenes/${fileName}`;
      cut.source = "ai_generated";
      generated++;
      aiGenerated++;
      onProgress?.(`  ✓ 画面 ${i + 1} 生成完成 (AI)`);
    } else {
      skipped++;
      onProgress?.(`  ✗ 画面 ${i + 1} 生成失败（跳过）`);
    }
  }

  return { generated, skipped, stockUsed, aiGenerated };
}
