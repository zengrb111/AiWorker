/**
 * Free TTS module using edge-tts (Microsoft Edge browser TTS API).
 *
 * edge-tts is a free, no-API-key text-to-speech tool that uses the same
 * voices as Microsoft Edge's Read Aloud feature. It runs locally and
 * supports Chinese (zh-CN) voices.
 *
 * Chinese voices return SentenceBoundary (sentence-level timestamps).
 * English voices return WordBoundary (word-level timestamps).
 * Both are collected and used as caption data for Remotion's CaptionOverlay.
 *
 * This module:
 * 1. Synthesizes a narration MP3 from text
 * 2. Captures sentence/word-level timestamps for caption generation
 * 3. Returns both the audio file path and caption data
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type WordCaption = {
  word: string;
  startMs: number;
  endMs: number;
};

export type TTSResult = {
  audioPath: string;     // absolute path to the generated MP3
  audioPublicPath: string; // relative path for Remotion staticFile()
  durationSeconds: number;
  captions: WordCaption[];
};

const PYTHON_PATH =
  process.env.PYTHON_PATH ||
  "C:\\Users\\zengr\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe";

const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"; // female, natural, warm
const FALLBACK_VOICE = "zh-CN-YunxiNeural";    // male, young, energetic

/**
 * Generate TTS audio + word-level captions using edge-tts.
 *
 * The python script:
 * 1. Creates an edge-tts Communicate instance
 * 2. Streams synthesis to an MP3 file
 * 3. Collects WordBoundary events (offset + duration in ticks, 10ns units)
 * 4. Outputs a JSON line with word timestamps
 */
export function generateTTS(
  text: string,
  outputPath: string,
  voice: string = DEFAULT_VOICE
): Promise<TTSResult> {
  return new Promise((resolve, reject) => {
    // Python script — collects both WordBoundary and SentenceBoundary
    const script = `
import asyncio
import edge_tts
import json
import sys

async def main():
    text = sys.argv[1]
    output = sys.argv[2]
    voice = sys.argv[3]
    
    cues = []
    communicate = edge_tts.Communicate(text, voice)
    
    audio_data = b""
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_data += chunk["data"]
        elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
            # offset and duration are in 100-nanosecond units (10^-7 s)
            start_ms = int(chunk["offset"] / 10000)
            end_ms = start_ms + int(chunk["duration"] / 10000)
            cues.append({
                "word": chunk["text"],
                "startMs": start_ms,
                "endMs": end_ms,
                "boundaryType": chunk["type"],
            })
    
    with open(output, "wb") as f:
        f.write(audio_data)
    
    print(json.dumps({"cues": cues, "count": len(cues), "audioSize": len(audio_data)}, ensure_ascii=False))

asyncio.run(main())
`;

    // Write the script to a temp file
    const scriptPath = join(outputPath.replace(/\.mp3$/, "") + "_tts_script.py");
    writeFileSync(scriptPath, script, "utf-8");

    const args = [scriptPath, text, outputPath, voice];
    const child = spawn(PYTHON_PATH, args, {
      shell: false,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code: number) => {
      if (code !== 0) {
        reject(new Error(`edge-tts failed (exit ${code}): ${stderr.slice(-300)}`));
        return;
      }

      // Parse the JSON output from stdout (last line)
      const lines = stdout.trim().split("\n");
      const jsonLine = lines[lines.length - 1];

      let captions: WordCaption[] = [];
      try {
        const parsed = JSON.parse(jsonLine);
        captions = (parsed.cues || []).map((w: { word: string; startMs: number; endMs: number }) => ({
          word: w.word,
          startMs: w.startMs,
          endMs: w.endMs,
        }));
      } catch {
        // If we can't parse captions, still return the audio
      }

      // Calculate duration from last word end, or fallback to estimate
      const lastWord = captions[captions.length - 1];
      const durationSeconds = lastWord
        ? lastWord.endMs / 1000 + 0.5 // add 0.5s tail
        : text.length / 4; // rough estimate: ~4 chars per second

      resolve({
        audioPath: outputPath,
        audioPublicPath: "", // will be set by caller
        durationSeconds,
        captions,
      });
    });

    child.on("error", (err: Error) => {
      reject(new Error(`edge-tts spawn error: ${err.message}`));
    });
  });
}

/**
 * Generate narration for a video script and save to public/audio/.
 * Returns the path relative to the Remotion composer's public/ directory
 * so that Remotion's staticFile() can find it.
 */
export async function generateNarration(
  narrationText: string,
  videosDir: string
): Promise<TTSResult> {
  // Save to Remotion composer's public/generated/ directory
  // so Remotion's staticFile() can find it
  const montageRoot = process.env.OPENMONTAGE_DIR || join(process.cwd(), "OpenMontage");
  const remotionPublicDir = join(montageRoot, "remotion-composer", "public", "generated");
  if (!existsSync(remotionPublicDir)) mkdirSync(remotionPublicDir, { recursive: true });

  const audioFileName = `narration-${Date.now()}.mp3`;
  const audioPath = join(remotionPublicDir, audioFileName);

  const result = await generateTTS(narrationText, audioPath);

  // Return relative path for Remotion staticFile()
  // staticFile() reads from public/ directory, so we use "generated/<filename>"
  result.audioPublicPath = `generated/${audioFileName}`;

  return result;
}
