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
import { FFMPEG, probeDuration, runTool } from "./ffmpeg";
import { resolvePythonPath } from "./python";
import { resolveCapabilityConfig, type ResolvedModelConfig } from "./model-credentials";

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
  /** 实际生效的引擎（可能是降级后的，用于界面提示） */
  engine?: TtsEngine;
  /**
   * 首选引擎失败、降级到本引擎时的原因。
   *
   * 早先这个原因只在「所有通道都失败」时才随异常抛出，降级成功时被静默丢弃，
   * 于是界面只能显示「所选引擎不可用」，用户完全无法判断是缺 key、限流还是参数错。
   */
  fallbackReason?: string;
};

/**
 * 云端语音合成引擎。用户在「一键生成视频」对话框里选择：
 * - qwen：千问 TTS（**默认**，英文支持更好，音色自然）
 * - zhipu：智谱 glm-tts（中文自然，可作为中文旁白的备选）
 * 选中的引擎失败时会自动回退到另一家云 TTS，再退到本地通道，保证不断音。
 */
export type TtsProvider = "qwen" | "zhipu";

/** 实际产音的通道：两家云 TTS + 两个本地兜底。 */
export type TtsEngine = "zhipu" | "qwen" | "edge" | "sapi";

export const TTS_ENGINE_LABELS: Record<TtsEngine, string> = {
  zhipu: "智谱 GLM-TTS",
  qwen: "千问 TTS",
  edge: "Edge TTS",
  sapi: "本机语音",
};

/**
 * 把环境变量/请求参数解析成合法引擎名；非法值一律回落到 fallback。
 *
 * fallback 默认 qwen —— 未显式选择时的全局默认。
 */
export function resolveTtsProvider(raw: unknown, fallback: TtsProvider = "qwen"): TtsProvider {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return value === "qwen" ? "qwen" : value === "zhipu" ? "zhipu" : fallback;
}

/**
 * 全局默认引擎：千问 TTS。
 *
 * 可用环境变量 TTS_PROVIDER=zhipu 临时切回智谱（不需要改代码）。
 * 降级链不变 —— 千问不可用时仍会自动回退到智谱，再退到本地 edge-tts / SAPI。
 */
export const DEFAULT_TTS_PROVIDER: TtsProvider = resolveTtsProvider(process.env.TTS_PROVIDER, "qwen");

/** edge-tts 运行所需的 Python（与 DSH 共用解析逻辑，见 src/lib/python.ts）。 */
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
/** edge-tts 单次合成的硬超时（毫秒）。
 *
 * 为什么要这个：edge-tts 是「本地进程 + 远端 WebSocket」，一旦微软侧握手被拒
 * 或网络半开，进程既不报错也不退出，会一直挂到用户以为界面卡死
 * （实测降级到 SAPI 前白白等了 76 秒）。超时后主动 kill，保证降级链能继续往下走。
 * 超时按文本长度放宽：中文约 4 字/秒，长文本来就慢。
 */
const EDGE_TIMEOUT_BASE_MS = 45_000;
const EDGE_TIMEOUT_PER_CHAR_MS = 120;

/**
 * 把 edge-tts 的原始报错翻译成人能直接照做的提示。
 *
 * 实测踩坑：edge-tts 7.2.x 的 Sec-MS-GEC 令牌算法已被微软废弃，握手一律 403，
 * 报的是 `WSServerHandshakeError: 403, message='Invalid response status'`，
 * 从字面完全看不出「升级 pip 包就能好」。更坑的是本机有两套 Python
 * （托管 3.13 / PATH 3.12），`pip install -U` 装的那个和项目实际用的可能不是同一个，
 * 于是「明明升级过了还是 403」。所以这里必须把解释器路径一起打出来。
 */
function explainEdgeFailure(stderr: string, pythonPath: string): string {
  const raw = stderr.slice(-300);
  const which = `（本次使用的解释器：${pythonPath}）`;
  if (/WSServerHandshakeError/i.test(stderr) && /\b403\b/.test(stderr)) {
    return `edge-tts 被微软服务端拒绝（403，Sec-MS-GEC 令牌过期）。${which}`
      + "用这个解释器升级即可："
      + `& "${pythonPath}" -m pip install -U edge-tts`;
  }
  if (/ModuleNotFoundError.*edge_tts/i.test(stderr) || /No module named ['"]?edge_tts/i.test(stderr)) {
    return `未安装 edge-tts。${which}安装命令：& "${pythonPath}" -m pip install edge-tts`;
  }
  return raw;
}

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
    const timeoutMs = EDGE_TIMEOUT_BASE_MS + text.length * EDGE_TIMEOUT_PER_CHAR_MS;
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

# 双保险：Python 内层 asyncio 超时先抛，TS 外层 kill 兜底（Python 卡在解释器层时内层也救不了）。
try:
    asyncio.run(asyncio.wait_for(main(), timeout=float(sys.argv[7])))
except asyncio.TimeoutError:
    print("edge-tts synthesize timeout", file=sys.stderr)
    sys.exit(2)
`;

    // Write the script to a temp file
    const scriptPath = join(outputPath.replace(/\.mp3$/, "") + "_tts_script.py");
    writeFileSync(scriptPath, script, "utf-8");

    const args = [scriptPath, text, outputPath, voice, rate, pitch, volume, String(Math.round(timeoutMs / 1000))];
    const child = spawn(PYTHON_PATH, args, {
      shell: false,
      // Windows 下 Python stdout 默认 GBK，必须显式设为 UTF-8，否则中文时间戳 JSON 会乱码。
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    // 兜底 kill：Python 侧 wait_for 只管得了 asyncio 协程，卡在解释器/导入阶段就失效。
    const killTimer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        /* 进程可能已退出 */
      }
      settled = true;
      reject(new Error(`edge-tts 超时 ${Math.round(timeoutMs / 1000)} 秒无响应（可能被网络或微软服务端阻断）`));
    }, timeoutMs + 5000);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (code !== 0) {
        reject(new Error(`edge-tts failed (exit ${code}): ${explainEdgeFailure(stderr, PYTHON_PATH)}`));
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
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
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
 * 智谱 TTS 配置（依据官方《文本转语音》文档）：
 * 所有参数都放在请求体「顶层」，不是嵌套 parameters —— 放错位置会被静默忽略。
 * 可用环境变量覆盖/关闭。
 */
const ZHIPU_TTS_ENABLED = process.env.ZHIPU_TTS_ENABLED !== "0";
const ZHIPU_TTS_MODEL = process.env.ZHIPU_TTS_MODEL || "glm-tts";
const ZHIPU_TTS_API = process.env.ZHIPU_TTS_API || "https://open.bigmodel.cn/api/paas/v4/audio/speech";
/** 音色（必填）：tongtong 彤彤(默认) / chuichui 锤锤 / xiaochen 小陈 / jam / kazi / douji / luodo */
const ZHIPU_TTS_VOICE = process.env.ZHIPU_TTS_VOICE || "xiaochen";
/** 语速 [0.5, 2]，默认 1；音量 (0, 10]，默认 1。 */
const ZHIPU_TTS_SPEED = Number(process.env.ZHIPU_TTS_SPEED || 1);
const ZHIPU_TTS_VOLUME = Number(process.env.ZHIPU_TTS_VOLUME || 1);
/** 官方未提供 sample_rate 配置项，固定按 24kHz 处理裸 PCM。 */
const ZHIPU_TTS_SAMPLE_RATE = 24000;
/** 官方限制 input 最长 1024 字符，超出需分段合成后拼接。 */
const ZHIPU_INPUT_LIMIT = 1024;

/** 按句边界把文本切成不超过 limit 字符的若干段（避免智谱 1024 上限报错）。 */
function chunkTextForTTS(text: string, limit = ZHIPU_INPUT_LIMIT): string[] {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return [""];
  if (trimmed.length <= limit) return [trimmed];
  const parts: string[] = [];
  let buf = "";
  for (const s of trimmed.split(/(?<=[。！？!?；;\n])/)) {
    if (buf && (buf + s).length > limit) {
      parts.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) parts.push(buf);
  return parts.length ? parts : [trimmed.slice(0, limit)];
}

/** 把智谱返回的裸 PCM（s16le mono）包装成标准 WAV（补 44 字节头），便于 ffmpeg/时长解析。 */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audioFormat = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28); // byteRate
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32); // blockAlign
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * 首选通道：智谱 TTS（glm-tts）。按官方文档在请求体顶层传 voice/speed/volume，
 * 返回裸 PCM（24kHz s16le mono），这里封装成 WAV并按句估算字幕（智谱不返回时间戳）。
 * input 超 1024 字符时自动分段合成再拼接。
 *
 * 端点与密钥来自当前用户「配音」能力分配的配置（apiFormat=zhipu-tts），
 * 不再读全局 env —— 否则所有用户共用一份 key。
 */
async function generateZhipuTTS(
  text: string,
  outputWavPath: string,
  credential: ResolvedModelConfig
): Promise<TTSResult> {
  const apiKey = credential.apiKey;
  if (!apiKey) throw new Error("智谱配音未配置密钥");

  const endpoint = credential.baseUrl.includes("/audio/speech")
    ? credential.baseUrl
    : `${credential.baseUrl.replace(/\/+$/, "")}/audio/speech`;

  const chunks = chunkTextForTTS(text);
  const pcmParts: Buffer[] = [];
  for (const chunk of chunks) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      // 注意：voice/speed/volume/response_format 必须放在顶层（旧文档里的嵌套 parameters 会被忽略）。
      body: JSON.stringify({
        model: credential.model || ZHIPU_TTS_MODEL,
        input: chunk,
        voice: ZHIPU_TTS_VOICE,
        speed: ZHIPU_TTS_SPEED,
        volume: ZHIPU_TTS_VOLUME,
        response_format: "pcm",
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`智谱TTS失败 HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const pcm = Buffer.from(await res.arrayBuffer());
    if (pcm.length < 100) throw new Error("智谱TTS返回空音频");
    pcmParts.push(pcm);
  }

  const pcm = Buffer.concat(pcmParts);
  writeFileSync(outputWavPath, pcmToWav(pcm, ZHIPU_TTS_SAMPLE_RATE));
  const duration = pcm.length / (ZHIPU_TTS_SAMPLE_RATE * 2); // s16le mono => *2 bytes/sample
  return { audioPath: outputWavPath, audioPublicPath: "", durationSeconds: duration, captions: buildEstimatedCaptions(text, duration) };
}

/**
 * 千问 TTS（阿里云百炼）配置。英文发音显著优于智谱，故作为可选引擎。
 * 注意：DASHSCOPE_BASE_URL 在本项目历史上被指向了智谱（见 .env.local），
 * 这里不使用它，千问端点与 key 均显式读取，避免串到错误的服务商。
 *
 * 实测（2026-10-14）：只有 qwen3-tts-flash 可用，qwen-audio-3.1-tts-flash 会返回
 * 400「url error, please check url」。返回 output.audio.url（24h 有效，需二次下载），
 * 音频为 WAV 且不返回 format 字段。
 *
 * 2026-10-16 故障复盘：曾把 QWEN_TTS_API 指向百炼的「应用专属端点」
 * （llm-*.cn-beijing.maas.aliyuncs.com）。该端点会随应用实例状态一起失效，
 * 失效后返回 HTTP 400 且**响应体为空 {}** —— 连标准错误码都没有，
 * 排查时极易误判成参数写错或模型不可用。
 * 判定方法：同 key、同模型、同 payload 打官方端点能 200，就说明问题在端点不在参数。
 * 因此默认端点固定为官方域名，QWEN_TTS_API 只在确认专属实例状态正常时再覆盖。
 */
const QWEN_TTS_ENABLED = process.env.QWEN_TTS_ENABLED !== "0";
const QWEN_TTS_MODEL = process.env.QWEN_TTS_MODEL || "qwen3-tts-flash";
const QWEN_TTS_API =
  process.env.QWEN_TTS_API ||
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
/** 音色 id（下列均为实测可用）。 */
const QWEN_TTS_VOICE = process.env.QWEN_TTS_VOICE || "Cherry";
/** 语言类型：auto 让模型自行判定（中英混说更稳），也可指定 zh / en。 */
const QWEN_TTS_LANGUAGE_TYPE = process.env.QWEN_TTS_LANGUAGE_TYPE || "auto";
/** 语气风格（可选，自由文本）。 */
const QWEN_TTS_STYLE = process.env.QWEN_TTS_STYLE || "";
/** 千问单次合成文本上限（字符），超出按句切分。 */
const QWEN_INPUT_LIMIT = Number(process.env.QWEN_INPUT_LIMIT || 1000);

/** 千问 TTS 可选音色（实测可用，勿加入未验证的 id）。 */
export const QWEN_TTS_VOICE_OPTIONS = [
  { id: "Cherry", label: "Cherry（自然亲和，女声）" },
  { id: "Serena", label: "Serena（柔和女声）" },
  { id: "Chelsie", label: "Chelsie（活泼年轻，女声）" },
  { id: "Sunny", label: "Sunny（明亮女声）" },
  { id: "Nofish", label: "Nofish（自然解说，女声）" },
  { id: "Jennifer", label: "Jennifer（女声）" },
  { id: "Ethan", label: "Ethan（温暖男声）" },
  { id: "Dylan", label: "Dylan（年轻男声）" },
  { id: "Elias", label: "Elias（男声）" },
  { id: "Marcus", label: "Marcus（男声）" },
  { id: "Roy", label: "Roy（男声）" },
];

/**
 * 千问 TTS 通道：POST 拿JSON（output.audio.url），再GET 下载音频落盘。
 * 与智谱不同，千问返回的是真实音频文件（wav/mp3），时长用 ffprobe 精确探测。
 * 千问不返回时间戳，字幕按句估算（与智谱一致）。
 */
async function generateQwenTTS(
  text: string,
  outputDir: string,
  baseName: string,
  credential: ResolvedModelConfig
): Promise<TTSResult> {
  const apiKey = credential.apiKey;
  if (!apiKey) throw new Error("千问配音未配置密钥");

  const base = credential.baseUrl.replace(/\/+$/, "").replace(/\/compatible-mode\/v1$/, "");
  const endpoint = credential.baseUrl.includes("/multimodal-generation/generation")
    ? credential.baseUrl
    : `${base}/api/v1/services/aigc/multimodal-generation/generation`;

  const chunks = chunkTextForTTS(text, QWEN_INPUT_LIMIT);
  const parts: string[] = [];
  for (const chunk of chunks) {
    const input: Record<string, unknown> = {
      text: chunk,
      voice: QWEN_TTS_VOICE,
      language_type: QWEN_TTS_LANGUAGE_TYPE,
    };
    if (QWEN_TTS_STYLE) input.style = QWEN_TTS_STYLE;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: credential.model || QWEN_TTS_MODEL, input }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`千问TTS失败 HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const json = (await res.json().catch(() => null)) as
      | { output?: { audio?: { url?: string; format?: string } } }
      | null;
    const url = json?.output?.audio?.url;
    if (!url) {
      throw new Error(`千问TTS未返回音频地址：${JSON.stringify(json ?? {}).slice(0, 200)}`);
    }

    // 音频 url 有效期 24h，必须立即下载到本地。
    const audioRes = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!audioRes.ok) throw new Error(`千问音频下载失败 HTTP ${audioRes.status}`);
    const ext = normalizeAudioExt(json?.output?.audio?.format);
    const filePath = join(outputDir, `${baseName}-${parts.length + 1}.${ext}`);
    writeFileSync(filePath, Buffer.from(await audioRes.arrayBuffer()));
    parts.push(filePath);
  }

  // 多段：交给 ffmpeg 顺序拼接为单文件，避免后续混流拿不到完整旁白。
  const finalPath =
    parts.length === 1 ? parts[0] : await concatAudioParts(parts, join(outputDir, `${baseName}.wav`));
  const duration = (await probeDuration(finalPath)) || text.length / 4;
  return {
    audioPath: finalPath,
    audioPublicPath: "",
    durationSeconds: duration,
    captions: buildEstimatedCaptions(text, duration),
    engine: "qwen",
  };
}

/** 把千问返回的 format 规整成安全扩展名（默认 wav）。 */
function normalizeAudioExt(format: string | undefined): string {
  const raw = (format || "wav").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["wav", "mp3", "m4a", "aac", "flac", "ogg", "pcm"].includes(raw)) return raw;
  return "wav";
}

/** 顺序拼接多个音频片段为一个文件（统一转 WAV，ffmpeg 最稳）。 */
async function concatAudioParts(parts: string[], outputPath: string): Promise<string> {
  const listPath = `${outputPath}.txt`;
  writeFileSync(
    listPath,
    parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
    "utf-8"
  );
  const r = await runTool(
    FFMPEG,
    ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:a", "pcm_s16le", outputPath],
    { timeoutMs: 120_000 }
  );
  try {
    unlinkSync(listPath);
  } catch {
    /* 忽略清理失败 */
  }
  if (!r.ok || !existsSync(outputPath)) {
    // 拼接失败则退回第一段，至少保证有配音。
    return parts[0];
  }
  return outputPath;
}

/** 限流（429 / rate limit）属瞬时故障，退避重试远优于直接降级到本机语音。 */
function isRateLimited(message: string): boolean {
  return /rate limit|429|too many requests|限流|请求过于频繁/i.test(message);
}

/** 带限流退避重试的执行器：命中限流时等待后重试，仍失败才交给上层降级。 */
async function runWithRateLimitRetry<T>(run: () => Promise<T>, retries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await run();
    } catch (e) {
      lastError = e;
      const message = e instanceof Error ? e.message : String(e);
      if (!isRateLimited(message) || attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** 依次尝试：用户配置的云配音 → edge-tts → 本机 SAPI。任一成功即返回。 */
async function synthesizeWithFallback(
  text: string,
  outDir: string,
  baseName: string,
  provider: TtsProvider = DEFAULT_TTS_PROVIDER,
  credential: ResolvedModelConfig | null = null
): Promise<TTSResult> {
  const errors: string[] = [];
  const cloud: Array<{ engine: TtsEngine; run: () => Promise<TTSResult> }> = [];
  // 只有该用户确实配置了对应接口形态的云配音，才把它放进候选链；
  // 没配置就直接走本地通道（edge-tts / SAPI），保证没云端 key 也能出片。
  if (credential?.apiFormat === "zhipu-tts") {
    cloud.push({
      engine: "zhipu",
      run: () =>
        runWithRateLimitRetry(async () => ({
          ...(await generateZhipuTTS(text, join(outDir, `${baseName}.wav`), credential)),
          engine: "zhipu" as const,
        })),
    });
  }
  if (credential?.apiFormat === "dashscope-tts") {
    cloud.push({
      engine: "qwen",
      run: () => runWithRateLimitRetry(() => generateQwenTTS(text, outDir, baseName, credential)),
    });
  }
  if (!cloud.length) {
    errors.push("cloud:未在系统配置中指定云端配音模型");
  }

  // 用户选中的先试，另一家紧随其后做兜底。
  const ordered = [...cloud].sort((a, b) => {
    const rank = (e: TtsEngine) => (e === provider ? 0 : 1);
    return rank(a.engine) - rank(b.engine);
  });

  for (const channel of ordered) {
    try {
      const result = await channel.run();
      // errors 非空说明前面的通道（含用户选中的首选引擎）失败过 —— 把原因带出去，
      // 否则调用方只看到 engine 变了，却永远不知道最初为什么失败。
      return errors.length ? { ...result, fallbackReason: errors.join(" | ") } : result;
    } catch (e) {
      errors.push(`${channel.engine}:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    const edge = await generateTTS(text, join(outDir, `${baseName}.mp3`));
    return errors.length ? { ...edge, engine: "edge" as const, fallbackReason: errors.join(" | ") } : { ...edge, engine: "edge" as const };
  } catch (e) {
    errors.push(`edge:${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const sapi = await synthesizeWithWindowsSapi(text, join(outDir, `${baseName}.wav`));
    return {
      ...sapi,
      engine: "sapi" as const,
      fallbackReason: errors.length ? errors.join(" | ") : undefined,
    };
  } catch (e) {
    errors.push(`sapi:${e instanceof Error ? e.message : String(e)}`);
  }
  throw new Error(`所有TTS通道均失败：${errors.join(" | ")}`);
}

/**
 * 「一键生成视频」用：把旁白文本合成为音频，输出到指定目录。
 *
 * 云端配音的端点与密钥来自当前用户在「系统配置 → 模型配置」里为「配音」指定的服务
 * （apiFormat 决定走智谱还是千问）；未配置时自动回退到本地 edge-tts / SAPI，
 * 保证没有云端 key 也能出片。结果的 engine 字段标明实际生效的通道。
 * 调用方负责容错：全部通道失败时应降级为「无配音」版本，不阻断出片。
 */
export async function synthesizeNarration(
  text: string,
  outDir: string,
  voice: string = DEFAULT_VOICE,
  provider: TtsProvider = DEFAULT_TTS_PROVIDER,
  options: { userId?: string; config?: ResolvedModelConfig | null } = {}
): Promise<TTSResult> {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  let credential: ResolvedModelConfig | null = null;
  if (options.config !== undefined) {
    credential = options.config;
  } else if (options.userId) {
    credential = await resolveCapabilityConfig(options.userId, "tts").catch(() => null);
  }
  return synthesizeWithFallback(text, outDir, `narration-${Date.now()}`, provider, credential);
}
