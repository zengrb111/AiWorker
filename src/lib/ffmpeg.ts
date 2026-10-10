import { spawn } from "node:child_process";

/** ffmpeg 可执行文件，可用环境变量 FFMPEG_BIN 覆盖（默认取 PATH 中的 ffmpeg）。 */
export const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
/** ffprobe 可执行文件，可用环境变量 FFPROBE_BIN 覆盖。 */
export const FFPROBE = process.env.FFPROBE_BIN || "ffprobe";

export interface RunToolResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 通用子进程执行封装：运行 ffmpeg / ffprobe 并收集输出。
 * 超时后强杀，避免个别卡死的转码把请求拖死。
 */
export function runTool(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; onStderr?: (line: string) => void } = {},
): Promise<RunToolResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => {
      const s = c.toString();
      stderr += s;
      if (opts.onStderr) for (const line of s.split(/\r?\n/)) if (line.trim()) opts.onStderr(line);
    });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr + err.message });
    });
  });
}

/** 视频/音频时长（秒），无法探测时返回 0。 */
export async function probeDuration(path: string): Promise<number> {
  const r = await runTool(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const n = parseFloat(r.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/** 是否含音轨。 */
export async function hasAudioStream(path: string): Promise<boolean> {
  const r = await runTool(FFPROBE, [
    "-v", "error",
    "-select_streams", "a",
    "-show_entries", "stream=codec_type",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  return r.stdout.trim().length > 0;
}

/** 视频分辨率。 */
export async function probeVideoSize(path: string): Promise<{ width: number; height: number }> {
  const r = await runTool(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0",
    path,
  ]);
  const [w, h] = r.stdout.trim().split(",").map(Number);
  return { width: w || 0, height: h || 0 };
}
