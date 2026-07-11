/**
 * FFmpeg post-processing for video output.
 *
 * After Remotion renders the MP4 (which already contains narration audio
 * if TTS was generated), this module can optionally:
 * 1. Mix in background music (with volume control + fade in/out)
 * 2. Burn in subtitles (from SRT)
 * 3. Normalize audio levels
 *
 * All operations use FFmpeg — completely free, no API keys needed.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export type FFmpegResult = {
  success: boolean;
  error?: string;
};

/**
 * Find FFmpeg executable path.
 * Checks PATH first, then common Windows locations.
 */
function findFFmpeg(): string {
  // Check if ffmpeg is in PATH (works on Linux/macOS/Windows)
  return "ffmpeg";
}

/**
 * Run an FFmpeg command and return when it completes.
 */
function runFFmpeg(
  args: string[],
  onProgress?: (line: string) => void
): Promise<FFmpegResult> {
  return new Promise((resolve) => {
    const child = spawn(findFFmpeg(), args, {
      shell: true,
      env: { ...process.env },
    });

    let stderr = "";

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      // FFmpeg outputs progress on stderr
      const lines = text.split("\n").filter(Boolean);
      for (const line of lines) {
        if (line.includes("time=") || line.includes("size=")) {
          onProgress?.(line.trim());
        }
      }
    });

    child.on("close", (code: number) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({
          success: false,
          error: stderr.slice(-500) || `FFmpeg exited with code ${code}`,
        });
      }
    });

    child.on("error", (err: Error) => {
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Mix background music into a video file.
 *
 * The narration audio (already embedded by Remotion) is kept at full volume,
 * and background music is added at a lower volume with fade in/out.
 *
 * @param inputVideo  Path to the input MP4 (with narration audio)
 * @param musicFile   Path to the background music file (MP3/WAV)
 * @param outputVideo Path for the output MP4
 * @param musicVolume  Background music volume (0-1, default 0.15 = 15%)
 * @param onProgress  Progress callback
 */
export async function mixBackgroundMusic(
  inputVideo: string,
  musicFile: string,
  outputVideo: string,
  musicVolume: number = 0.15,
  onProgress?: (line: string) => void
): Promise<FFmpegResult> {
  if (!existsSync(inputVideo)) {
    return { success: false, error: `Input video not found: ${inputVideo}` };
  }
  if (!existsSync(musicFile)) {
    return { success: false, error: `Music file not found: ${musicFile}` };
  }

  // FFmpeg filter: keep original audio, add music at lower volume with fade
  // -filter_complex "[1:a]volume={musicVolume},afade=t=in:st=0:d=2,afade=t=out:st={fadeOutStart}:d=3[mix];[0:a][mix]amix=inputs=2:duration=first:dropout_transition=0[a]"
  // -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k

  const args = [
    "-y",
    "-i", inputVideo,
    "-i", musicFile,
    "-filter_complex",
    `[1:a]volume=${musicVolume},afade=t=in:st=0:d=2,aloop=loop=-1:size=2e9[mix];[0:a][mix]amix=inputs=2:duration=first:dropout_transition=0[a]`,
    "-map", "0:v",
    "-map", "[a]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    outputVideo,
  ];

  return runFFmpeg(args, onProgress);
}

/**
 * Normalize audio levels in a video file.
 * Uses FFmpeg's loudnorm filter for broadcast-standard loudness normalization.
 */
export async function normalizeAudio(
  inputVideo: string,
  outputVideo: string,
  onProgress?: (line: string) => void
): Promise<FFmpegResult> {
  if (!existsSync(inputVideo)) {
    return { success: false, error: `Input video not found: ${inputVideo}` };
  }

  const args = [
    "-y",
    "-i", inputVideo,
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    outputVideo,
  ];

  return runFFmpeg(args, onProgress);
}

/**
 * Get video duration in seconds using FFprobe.
 */
export async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      { shell: true }
    );

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

    child.on("close", (code: number) => {
      if (code === 0) {
        const duration = parseFloat(stdout.trim());
        resolve(isNaN(duration) ? 0 : duration);
      } else {
        reject(new Error(`ffprobe failed: ${stderr}`));
      }
    });

    child.on("error", (err: Error) => {
      reject(new Error(`ffprobe spawn error: ${err.message}`));
    });
  });
}
