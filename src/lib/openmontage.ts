import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const remakeRunner = [
  "import json, subprocess, sys",
  "from pathlib import Path",
  "from tools.analysis.video_analyzer import VideoAnalyzer",
  "from tools.video.video_stitch import VideoStitch",
  "payload = json.loads(sys.argv[1])",
  "def progress(text): print(json.dumps({'type': 'progress', 'text': text}), flush=True)",
  "workspace = Path(payload['workspace'])",
  "workspace.mkdir(parents=True, exist_ok=True)",
  "reference = payload.get('reference_path') or payload.get('reference_url')",
  "transition = 'crossfade'",
  "if reference:",
  "    progress('正在分析参考视频的节奏和转场...')",
  "    analysis = VideoAnalyzer().execute({'source': reference, 'analysis_depth': 'standard', 'max_keyframes': 12, 'output_dir': str(workspace / 'reference_analysis')})",
  "    if not analysis.success: raise RuntimeError(analysis.error or '参考视频分析失败，请改为上传参考视频。')",
  "    pacing = analysis.data.get('structure_analysis', {}).get('pacing_profile', {})",
  "    transition = 'cut' if pacing.get('cuts_per_minute', 0) >= 18 else 'crossfade'",
  "materials = [Path(path) for path in payload['materials']]",
  "progress(f'已读取 {len(materials)} 个制作素材，正在统一竖版画面...')",
  "clips = []",
  "for index, material in enumerate(materials):",
  "    if material.suffix.lower() in {'.jpg', '.jpeg', '.png', '.webp'}:",
  "        clip = workspace / f'image_{index:03d}.mp4'",
  "        subprocess.run(['ffmpeg', '-y', '-loop', '1', '-i', str(material), '-t', '3', '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(clip)], check=True, capture_output=True)",
  "        clips.append(str(clip))",
  "    else:",
  "        clips.append(str(material))",
  "if len(clips) == 1:",
  "    progress('正在渲染单条素材为竖版成片...')",
  "    subprocess.run(['ffmpeg', '-y', '-i', clips[0], '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p', '-r', '30', '-c:v', 'libx264', '-c:a', 'aac', str(payload['output_path'])], check=True, capture_output=True)",
  "else:",
  "    progress('正在按照参考节奏拼接素材并渲染成片...')",
  "    result = VideoStitch().execute({'operation': 'stitch', 'clips': clips, 'output_path': payload['output_path'], 'transition': transition, 'transition_duration': 0.35, 'auto_normalize': True, 'target_resolution': '1080x1920', 'target_fps': 30})",
  "    if not result.success: raise RuntimeError(result.error or '视频素材合成失败。')",
  "progress('视频已渲染完成，正在保存到内容库...')",
  "print(json.dumps({'success': True}))"
].join("\n");

export function createViralRemake(input: {
  referenceUrl?: string;
  referencePath?: string;
  materialPaths: string[];
  workspace: string;
  outputPath: string;
}, onProgress?: (text: string) => void): Promise<void> {
  const montageRoot = process.env.OPENMONTAGE_DIR || join(process.cwd(), "OpenMontage");
  const python = process.env.OPENMONTAGE_PYTHON || "python";
  if (!existsSync(montageRoot)) return Promise.reject(new Error("未找到 OpenMontage，无法制作视频。"));

  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-c", remakeRunner, JSON.stringify({
      reference_url: input.referenceUrl,
      reference_path: input.referencePath,
      materials: input.materialPaths,
      workspace: input.workspace,
      output_path: input.outputPath
    })], { cwd: montageRoot, shell: false, env: { ...process.env } });
    let stdout = "";
    let stdoutBuffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { type?: string; text?: string };
          if (event.type === "progress" && event.text) onProgress?.(event.text);
        } catch {
          // OpenMontage tools may write diagnostic output alongside JSON progress.
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new Error(`无法启动 OpenMontage：${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0 || !existsSync(input.outputPath)) {
        reject(new Error(stderr.trim() || `OpenMontage 制作失败（退出码 ${code}）。`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim().split("\n").pop() || "{}");
        if (!result.success) throw new Error("OpenMontage 没有生成视频文件。");
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error("无法读取 OpenMontage 制作结果。"));
      }
    });
  });
}
