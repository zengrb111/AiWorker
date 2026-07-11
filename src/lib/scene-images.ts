/**
 * Scene image generator — downloads AI-generated images from pollinations.ai
 * for each video scene's visual_prompt, then fills the cut.backgroundImage field.
 *
 * pollinations.ai is completely free, no API key required.
 * Images are saved to the Remotion composer's public/generated/ directory
 * so Remotion's staticFile() can resolve them during rendering.
 */

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type SceneCut = {
  id?: string;
  visual_prompt?: string;
  backgroundImage?: string;
  source?: string;
  [key: string]: unknown;
};

type SceneImageResult = {
  generated: number;
  skipped: number;
};

/**
 * Download an image from pollinations.ai and save to a local file.
 */
async function downloadImage(
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
      // Too small — probably an error response
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
 * Fills cut.backgroundImage with the relative path for Remotion's staticFile().
 *
 * @param props - The Remotion props object (mutated in place)
 * @param composerPublicDir - Path to remotion-composer/public/
 * @param onProgress - Callback for progress updates
 * @returns Number of images generated and skipped
 */
export async function generateSceneImages(
  props: Record<string, unknown>,
  composerPublicDir: string,
  onProgress?: (text: string) => void
): Promise<SceneImageResult> {
  const cuts = props.cuts as SceneCut[] | undefined;
  if (!cuts || !Array.isArray(cuts)) {
    return { generated: 0, skipped: 0 };
  }

  // Create output directory
  const generatedDir = join(composerPublicDir, "generated", "scenes");
  if (!existsSync(generatedDir)) {
    mkdirSync(generatedDir, { recursive: true });
  }

  let generated = 0;
  let skipped = 0;
  const timestamp = Date.now();

  // Generate images sequentially (pollinations.ai rate limits)
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i];
    const visualPrompt = cut.visual_prompt;

    if (!visualPrompt || typeof visualPrompt !== "string" || visualPrompt.trim().length === 0) {
      skipped++;
      continue;
    }

    const sceneId = cut.id || `scene-${i + 1}`;
    const fileName = `${sceneId}-${timestamp}.jpg`;
    const filePath = join(generatedDir, fileName);

    onProgress?.(`  生成画面 ${i + 1}/${cuts.length}: ${visualPrompt.slice(0, 40)}...`);

    const success = await downloadImage(
      visualPrompt,
      filePath,
      1920,
      1080,
      timestamp + i
    );

    if (success) {
      // Set backgroundImage so Remotion renders the image as a background layer
      // with the text/chart component overlaid on top
      cut.backgroundImage = `generated/scenes/${fileName}`;
      generated++;
      onProgress?.(`  ✓ 画面 ${i + 1} 生成完成`);
    } else {
      skipped++;
      onProgress?.(`  ✗ 画面 ${i + 1} 生成失败（跳过）`);
    }
  }

  return { generated, skipped };
}
