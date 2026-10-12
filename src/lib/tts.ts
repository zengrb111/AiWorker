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

import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
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

/** edge-tts 运行所需的 Python：优先 PYTHON_PATH，其次托管 venv（已装 edge-tts），最后 base。 */
function resolvePythonPath(): string {
  const candidates = [
    process.env.PYTHON_PATH,
    "C:\\Users\\zengr\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe",
    "C:\\Users\\zengr\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe",
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) || candidates[0] || "python";
}

const PYTHON_PATH = resolvePythonPath();

// 默认音色与韵律：偏自然、温暖、略放慢，避免默认 +0% 语速带来的“生硬/赶”感。
// 均可用环境变量覆盖：TTS_VOICE / TTS_RATE / TTS_PITCH / TTS_VOLUME。
const DEFAULT_VOICE = process.env.TTS_VOICE || "zh-CN-XiaoxiaoNeural"; // female, natural, warm
const FALLBACK_VOICE = "zh-CN-YunxiNeural";    // male, young, energetic
const DEFAULT_RATE = process.env.TTS_RATE || "-8%";   // 略微放慢，口播更从容
const DEFAULT_PITCH = process.env.TTS_PITCH || "+0Hz";
const DEFAULT_VOLUME = process.env.TTS_VOLUME || "+0%";

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
  voice: string = DEFAULT_VOICE,
  prosody: { rate?: string; pitch?: string; volume?: string } = {}
): Promise<TTSResult> {
  return new Promise((resolve, reject) => {
    const rate = prosody.rate ?? DEFAULT_RATE;
    const pitch = prosody.pitch ?? DEFAULT_PITCH;
    const volume = prosody.volume ?? DEFAULT_VOLUME;
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
    rate = sys.argv[4]
    pitch = sys.argv[5]
    volume = sys.argv[6]

    cues = []
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
    
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

    const args = [scriptPath, text, outputPath, voice, rate, pitch, volume];
    const child = spawn(PYTHON_PATH, args, {
      shell: false,
      // Windows 下 Python stdout 默认 GBK，必须显式设为 UTF-8，否则中文时间戳 JSON 会乱码。
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
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

/** 解析标准 PCM WAV 的时长（秒）；SAPI 输出为标准 WAV，可直接读 byteRate/data 块。 */
function readWavDurationSeconds(wavPath: string): number | null {
  try {
    const buf = readFileSync(wavPath);
    if (buf.length < 44) return null;
    const byteRate = buf.readUInt32LE(28); // fmt 块中的 byteRate
    if (!byteRate) return null;
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const id = buf.toString("ascii", pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (id === "data") return size / byteRate;
      pos += 8 + size + (size % 2);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 备用通道无边界事件时，按句拆分 + 按字数比例分配总时长，生成粗粒度字幕，
 * 保证降级后视频仍有可用的逐句字幕（与中文 edge-tts 的句级行为一致）。
 */
function buildEstimatedCaptions(text: string, totalSeconds: number): WordCaption[] {
  const sentences = text
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sentences.length) return [];
  const weights = sentences.map((s) => Math.max(1, s.replace(/[\s，。！？!?；;、,.]/g, "").length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const totalMs = Math.max(1, Math.round(totalSeconds * 1000));
  const captions: WordCaption[] = [];
  let cursor = 0;
  sentences.forEach((s, i) => {
    const dur = Math.max(300, Math.round((weights[i] / totalWeight) * totalMs));
    const start = cursor;
    const end = Math.min(totalMs, start + dur);
    captions.push({ word: s, startMs: start, endMs: end });
    cursor = end;
  });
  return captions;
}

/**
 * 备用 TTS 通道：本地 Windows SAPI（微软惠惠 zh-CN，离线可用、免 key、永不 403）。
 * 仅在 edge-tts 失败时兜底，保证视频不会变成「无配音」。
 */
function synthesizeWithWindowsSapi(text: string, outputWavPath: string): Promise<TTSResult> {
  return new Promise((resolve, reject) => {
    const stem = outputWavPath.replace(/\.wav$/i, "");
    const textFile = `${stem}_sapi.txt`;
    const scriptFile = `${stem}_sapi.ps1`;
    writeFileSync(textFile, text, "utf-8");
    const ps = [
      "param([string]$TextPath, [string]$OutWav, [string]$Voice)",
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.Speech",
      "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "if ($Voice) { try { $synth.SelectVoice($Voice) } catch {} }",
      "$synth.SetOutputToWaveFile($OutWav)",
      "$synth.Speak((Get-Content -LiteralPath $TextPath -Raw -Encoding UTF8))",
      "$synth.SetOutputToNull()",
      "$synth.Dispose()",
    ].join("\r\n");
    writeFileSync(scriptFile, ps, "utf-8");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptFile, "-TextPath", textFile, "-OutWav", outputWavPath, "-Voice", "Microsoft Huihui Desktop"],
      { env: { ...process.env } }
    );
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err: Error) => reject(new Error(`SAPI spawn error: ${err.message}`)));
    child.on("close", (code: number) => {
      for (const f of [textFile, scriptFile]) {
        try {
          unlinkSync(f);
        } catch {
          /* 忽略清理失败 */
        }
      }
      if (code !== 0 || !existsSync(outputWavPath)) {
        reject(new Error(`SAPI failed (exit ${code}): ${stderr.slice(-300)}`));
        return;
      }
      const duration = readWavDurationSeconds(outputWavPath) ?? text.length / 4;
      resolve({ audioPath: outputWavPath, audioPublicPath: "", durationSeconds: duration, captions: buildEstimatedCaptions(text, duration) });
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

  let result: TTSResult;
  try {
    result = await generateTTS(narrationText, audioPath);
  } catch {
    // edge-tts 失败（如微软端点 403）→ 降级本地 SAPI，保证仍有配音。
    result = await synthesizeWithWindowsSapi(narrationText, audioPath.replace(/\.mp3$/i, ".wav"));
  }

  // Return relative path for Remotion staticFile()
  // staticFile() reads from public/ directory, so we use "generated/<filename>"
  result.audioPublicPath = `generated/${basename(result.audioPath)}`;

  return result;
}

/**
 * 「一键生成视频」用：把旁白文本合成为 mp3（默认女声晓晓），输出到指定目录。
 * 返回绝对路径、时长与句级时间戳（captions 可直接生成字幕）。
 * 调用方负责容错：失败应降级为「无配音」版本，不阻断出片。
 */
export async function synthesizeNarration(
  text: string,
  outDir: string,
  voice: string = DEFAULT_VOICE
): Promise<TTSResult> {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const audioPath = join(outDir, `narration-${Date.now()}.mp3`);
  try {
    return await generateTTS(text, audioPath, voice);
  } catch {
    // edge-tts 失败（如微软端点 403）→ 降级本地 SAPI（微软惠惠 zh-CN），保证视频仍有配音。
    return await synthesizeWithWindowsSapi(text, audioPath.replace(/\.mp3$/i, ".wav"));
  }
}
