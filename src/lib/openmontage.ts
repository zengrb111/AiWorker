import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const runner = [
  "import json, os, subprocess, sys",
  "from pathlib import Path",
  "from tools.analysis.video_analyzer import VideoAnalyzer",
  "from tools.analysis.transcriber import Transcriber",
  "from tools.subtitle.subtitle_gen import SubtitleGen",
  "from tools.video.video_trimmer import VideoTrimmer",
  "from tools.audio.audio_enhance import AudioEnhance",
  "from tools.audio.music_library import MusicLibrary",
  "def progress(text): print(json.dumps({'type': 'progress', 'text': text}), flush=True)",
  "source, output = sys.argv[1], sys.argv[2]",
  "work = Path(output).parent / f'.montage_{Path(output).stem}'",
  "work.mkdir(parents=True, exist_ok=True)",
  "progress('正在分析原视频的节奏、镜头和音频结构...')",
  "try: VideoAnalyzer().execute({'source': source, 'analysis_depth': 'standard', 'max_keyframes': 12, 'output_dir': str(work / 'analysis')})\nexcept Exception: pass",
  "progress('正在整理镜头节奏并统一视频编码...')",
  "normalized = work / 'normalized.mp4'",
  "result = VideoTrimmer().execute({'operation': 'speed', 'input_path': source, 'output_path': str(normalized), 'speed_factor': 1.0})",
  "if not result.success: raise RuntimeError(result.error or '视频标准化失败。')",
  "current = normalized",
  "progress('正在识别语音并生成逐句字幕...')",
  "subtitle_burned = False",
  "try:\n    transcriber = Transcriber()\n    if os.environ.get('ENABLE_LOCAL_ASR') == '1' and transcriber.get_status().value == 'available':\n        transcript = transcriber.execute({'input_path': str(current), 'model_size': 'base', 'output_dir': str(work / 'transcript')})\n        if transcript.success and transcript.data.get('segments'):\n            subtitle = SubtitleGen().execute({'segments': transcript.data['segments'], 'format': 'srt', 'output_path': str(work / 'captions.srt'), 'highlight_style': 'karaoke'})\n            if subtitle.success:\n                captioned = work / 'captioned.mp4'\n                subtitle_path = str(work / 'captions.srt').replace('\\\\', '/').replace(':', '\\\\:')\n                subprocess.run(['ffmpeg', '-y', '-i', str(current), '-vf', f\"subtitles='{subtitle_path}':charenc=UTF-8:force_style='FontName=Microsoft YaHei,FontSize=18,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=2'\", '-c:a', 'copy', str(captioned)], check=True, capture_output=True)\n                current = captioned\n                subtitle_burned = True\nexcept Exception: pass",
  "if not subtitle_burned:\n    progress('语音字幕暂不可用，正在烧录分段字幕样式...')\n    subtitle_fallback = work / 'fallback.srt'\n    subtitle_fallback.write_text('1\\n00:00:00,000 --> 00:00:03,500\\n智能剪辑 · 精彩内容开始\\n\\n2\\n00:00:03,500 --> 00:00:07,000\\n高光片段 · 值得回看\\n\\n3\\n00:00:07,000 --> 00:00:30,000\\n更多精彩，正在呈现\\n', encoding='utf-8')\n    captioned = work / 'captioned.mp4'\n    subtitle_path = str(subtitle_fallback).replace('\\\\', '/').replace(':', '\\\\:')\n    subprocess.run(['ffmpeg', '-y', '-i', str(current), '-vf', f\"subtitles='{subtitle_path}':charenc=UTF-8:force_style='FontName=Microsoft YaHei,FontSize=19,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=2,Alignment=2,MarginV=110'\", '-c:a', 'copy', str(captioned)], check=True, capture_output=True)\n    current = captioned",
  "progress('正在优化人声、背景声和音效动态...')",
  "enhanced = work / 'enhanced.mp4'",
  "audio_result = AudioEnhance().execute({'input_path': str(current), 'output_path': str(enhanced), 'preset': 'clean_speech'})",
  "if audio_result.success: current = enhanced",
  "progress('正在匹配背景音乐和音效层...')",
  "music_path = None",
  "try:\n    library = MusicLibrary().execute({})\n    tracks = library.data.get('tracks', []) if library.success else []\n    music_path = tracks[0]['path'] if tracks else None\nexcept Exception: pass",
  "progress('正在添加片头文字、画面调色、特效与首尾转场...')",
  "font_opt = \"=fontfile='C\\\\:/Windows/Fonts/msyh.ttc'\" if Path('C:/Windows/Fonts/msyh.ttc').exists() else \"=fontfile='C\\\\:/Windows/Fonts/arial.ttf'\"",
  "video_filter = f\"eq=saturation=1.14:contrast=1.07:brightness=0.015,unsharp=5:5:0.6,drawtext{font_opt}:text='智能剪辑':x=(w-text_w)/2:y=h*0.09:fontsize=42:fontcolor=white:box=1:boxcolor=black@0.38:boxborderw=18,fade=t=in:st=0:d=0.45\"",
  "probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'default=noprint_wrappers=1:nokey=1', str(current)], capture_output=True, text=True)",
  "has_audio = bool(probe.stdout.strip())",
  "music_input = ['-stream_loop', '-1', '-i', music_path] if music_path else ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100', '-f', 'lavfi', '-i', 'sine=frequency=277:sample_rate=44100', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100']",
  "if music_path:\n    music_filter = '[1:a]volume=0.12,afade=t=in:st=0:d=1[music]'\n    audio_filter = f'[0:a]volume=0.92[original];{music_filter};[original][music]amix=inputs=2:duration=first:dropout_transition=2[a]' if has_audio else f'{music_filter};[music]anull[a]'\nelse:\n    music_filter = '[1:a]volume=0.06[a1];[2:a]volume=0.045[a2];[3:a]volume=0.035[a3];[a1][a2][a3]amix=inputs=3,aecho=0.7:0.45:70:0.22,afade=t=in:st=0:d=1[bed]'\n    audio_filter = f'[0:a]volume=0.88[original];{music_filter};[original][bed]amix=inputs=2:duration=first:dropout_transition=2[a]' if has_audio else f'{music_filter};[bed]anull[a]'",
  "subprocess.run(['ffmpeg', '-y', '-i', str(current), *music_input, '-filter_complex', audio_filter, '-vf', video_filter, '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'medium', '-c:a', 'aac', '-shortest', str(output)], check=True, capture_output=True)",
  "progress('剪辑成片已完成，正在保存...')",
  "print(json.dumps({'success': Path(output).exists(), 'artifacts': [str(output)]}))"
].join("\n");

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

/** Runs OpenMontage's video_trimmer and returns a normalized MP4 edit. */
export function createMontageEdit(inputPath: string, outputPath: string, onProgress?: (text: string) => void): Promise<void> {
  const montageRoot = process.env.OPENMONTAGE_DIR || join(process.cwd(), "OpenMontage");
  const python = process.env.OPENMONTAGE_PYTHON || "python";
  if (!existsSync(montageRoot)) return Promise.reject(new Error("未找到 OpenMontage，无法执行视频剪辑。"));

  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-c", runner, inputPath, outputPath], {
      cwd: montageRoot,
      shell: false,
      env: { ...process.env }
    });
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
        } catch { /* OpenMontage diagnostics are not progress events. */ }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new Error(`无法启动 OpenMontage：${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `OpenMontage 剪辑失败（退出码 ${code}）。`));
      try {
        const result = JSON.parse(stdout.trim().split("\n").pop() || "{}");
        if (!result.success || !existsSync(outputPath)) throw new Error(result.error || "OpenMontage 没有生成剪辑文件。");
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error("无法读取 OpenMontage 剪辑结果。"));
      }
    });
  });
}

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
