import { jsonError, readJson } from "@/lib/http";
import { openClawClient } from "@/lib/openclaw";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { buildVideoScriptPrompt, extractRemotionProps } from "@/lib/video-prompt";
import { generateNarration } from "@/lib/tts";
import { generateSceneImages } from "@/lib/scene-images";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type VideoBody = {
  content?: string;
};

type ConversationMessage = {
  role: string;
  content: string;
  createdAt: Date;
};

const maxContextMessages = 20;
const maxContextCharacters = 12000;

function roleLabel(message: ConversationMessage): string {
  return message.role === "ASSISTANT" ? "助手" : "用户";
}

function trimContext(value: string): string {
  if (value.length <= maxContextCharacters) return value;
  return `...前文已截断...\n${value.slice(-maxContextCharacters)}`;
}

function buildConversationContext(messages: ConversationMessage[]): string {
  if (!messages.length) return "暂无历史会话。";
  return trimContext(
    messages
      .map((m) => `[${m.createdAt.toLocaleString("zh-CN")}] ${roleLabel(m)}: ${m.content}`)
      .join("\n")
  );
}

function titleFrom(content: string): string {
  return content.length > 18 ? `${content.slice(0, 18)}...` : content || "新的对话";
}

/**
 * Render a Remotion composition to MP4.
 * Runs `npx remotion render` in the OpenMontage/remotion-composer directory.
 */
function renderRemotionVideo(
  propsPath: string,
  outputPath: string,
  onProgress?: (line: string) => void
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const montageRoot = process.env.OPENMONTAGE_DIR || join(process.cwd(), "OpenMontage");
    const composerDir = join(montageRoot, "remotion-composer");
    const args = [
      "remotion",
      "render",
      "Explainer",
      outputPath,
      "--props=" + propsPath,
      "--codec=h264",
      "--concurrency=2",
    ];

    const child = spawn("npx", args, {
      cwd: composerDir,
      shell: true,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        onProgress?.(line);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code: number) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({
          success: false,
          error: stderr.slice(-500) || `Remotion render exited with code ${code}`,
        });
      }
    });

    child.on("error", (err: Error) => {
      resolve({ success: false, error: err.message });
    });
  });
}

function sseEncode(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const body = await readJson<VideoBody>(request);
  const content = body.content?.trim() ?? "";
  if (!content) return jsonError("请输入视频制作需求。");

  const conversation = await prisma.conversation.findFirst({
    where: { id: context.params.id, userId: user.id },
  });
  if (!conversation) return jsonError("对话不存在。", 404);

  // Save user message
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "USER",
      content: `[视频制作] ${content}`,
    },
  });

  const recentMessages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    take: maxContextMessages,
  });
  const conversationContext = buildConversationContext(recentMessages.reverse());
  const prompt = buildVideoScriptPrompt(content, conversationContext);

  const task = await prisma.openClawTask.create({
    data: { userId: user.id, type: "video", prompt, status: "RUNNING" },
  });

  const stream = new ReadableStream({
    async start(controller) {
      let rawContent = "";

      try {
        // Step 1: Call OpenClaw to generate Remotion JSON props
        controller.enqueue(sseEncode({ type: "delta", text: "正在生成视频脚本...\n\n" }));

        const result = await openClawClient.sendTaskStream(prompt, (deltaText) => {
          rawContent += deltaText;
          controller.enqueue(sseEncode({ type: "delta", text: deltaText }));
        });

        // Step 2: Extract JSON from OpenClaw response
        controller.enqueue(sseEncode({ type: "delta", text: "\n\n正在解析视频脚本...\n" }));

        const remotionProps = extractRemotionProps(result.content);

        if (!remotionProps) {
          // Fallback: save the text response as a content item
          const assistantMessage = await prisma.message.create({
            data: {
              conversationId: conversation.id,
              role: "ASSISTANT",
              content: result.content,
            },
          });
          await prisma.openClawTask.update({
            where: { id: task.id },
            data: { status: "SUCCEEDED", resultJson: JSON.stringify(result.raw ?? null) },
          });
          controller.enqueue(sseEncode({
            type: "final",
            message: {
              id: assistantMessage.id,
              role: "ASSISTANT",
              content: assistantMessage.content,
              createdAt: assistantMessage.createdAt.toISOString(),
            },
            contentSaved: null,
          }));
          controller.close();
          return;
        }

        // Step 3: Write JSON props to temp file
        const propsFileName = `video-props-${Date.now()}.json`;
        const propsDir = join(tmpdir(), "openmontage");
        if (!existsSync(propsDir)) mkdirSync(propsDir, { recursive: true });
        const propsPath = join(propsDir, propsFileName);
        writeFileSync(propsPath, JSON.stringify(remotionProps), "utf-8");

        // Step 3.5: Generate scene images (free pollinations.ai)
        const montageRoot = process.env.OPENMONTAGE_DIR || join(process.cwd(), "OpenMontage");
        const composerPublicDir = join(montageRoot, "remotion-composer", "public");

        controller.enqueue(sseEncode({
          type: "delta",
          text: "\n正在生成场景画面（AI 图片生成，免费）...\n",
        }));

        try {
          const imgResult = await generateSceneImages(
            remotionProps as Record<string, unknown>,
            composerPublicDir,
            (text) => {
              controller.enqueue(sseEncode({ type: "delta", text: `${text}\n` }));
            }
          );

          controller.enqueue(sseEncode({
            type: "delta",
            text: `  画面生成完成：${imgResult.generated} 张成功，${imgResult.skipped} 张跳过\n`,
          }));

          // Re-write props with backgroundImage paths
          writeFileSync(propsPath, JSON.stringify(remotionProps), "utf-8");
        } catch (imgError) {
          controller.enqueue(sseEncode({
            type: "delta",
            text: `  画面生成失败（跳过，继续渲染）：${imgError instanceof Error ? imgError.message.slice(0, 80) : "未知错误"}\n`,
          }));
        }

        // Step 3.5: Generate TTS narration (free edge-tts) + word-level captions
        const narrationText = (remotionProps as { narration?: string }).narration;
        const videosDir = join(process.cwd(), "public", "videos");
        if (!existsSync(videosDir)) mkdirSync(videosDir, { recursive: true });

        if (narrationText && typeof narrationText === "string" && narrationText.trim().length > 0) {
          controller.enqueue(sseEncode({
            type: "delta",
            text: "\n正在生成 AI 配音（edge-tts 免费配音）...\n",
          }));

          try {
            const ttsResult = await generateNarration(narrationText, videosDir);

            // Inject audio + captions into Remotion props
            (remotionProps as Record<string, unknown>).audio = {
              narration: {
                src: ttsResult.audioPublicPath,
                volume: 1,
              },
            };

            if (ttsResult.captions.length > 0) {
              (remotionProps as Record<string, unknown>).captions = ttsResult.captions;
            }

            // Re-write updated props with audio + captions
            writeFileSync(propsPath, JSON.stringify(remotionProps), "utf-8");

            controller.enqueue(sseEncode({
              type: "delta",
              text: `  配音完成：${ttsResult.captions.length} 个词，时长约 ${ttsResult.durationSeconds.toFixed(1)}s\n`,
            }));
          } catch (ttsError) {
            // TTS is best-effort — if it fails, continue without narration
            controller.enqueue(sseEncode({
              type: "delta",
              text: `  配音生成失败（跳过）：${ttsError instanceof Error ? ttsError.message : "未知错误"}\n`,
            }));
          }
        }

        // Step 4: Render video with Remotion
        controller.enqueue(sseEncode({
          type: "delta",
          text: "\n正在渲染视频（这可能需要 1-3 分钟）...\n",
        }));

        const videoFileName = `video-${Date.now()}.mp4`;
        const outputPath = join(videosDir, videoFileName);

        const renderResult = await renderRemotionVideo(
          propsPath,
          outputPath,
          (line) => {
            // Stream progress lines as they come
            controller.enqueue(sseEncode({ type: "delta", text: `  ${line}\n` }));
          }
        );

        if (!renderResult.success) {
          throw new Error(`视频渲染失败：${renderResult.error}`);
        }

        // Step 4.5: FFmpeg audio normalization (free, improves audio quality)
        if (narrationText && typeof narrationText === "string" && narrationText.trim().length > 0) {
          controller.enqueue(sseEncode({
            type: "delta",
            text: "\n正在优化音频（FFmpeg 归一化）...\n",
          }));

          try {
            const { normalizeAudio } = await import("@/lib/ffmpeg-post");
            const normalizedPath = outputPath.replace(/\.mp4$/, "_normalized.mp4");
            const normResult = await normalizeAudio(outputPath, normalizedPath, (line) => {
              controller.enqueue(sseEncode({ type: "delta", text: `  ${line}\n` }));
            });

            if (normResult.success) {
              // Replace original with normalized version
              const { copyFileSync, unlinkSync } = await import("node:fs");
              unlinkSync(outputPath);
              copyFileSync(normalizedPath, outputPath);
              unlinkSync(normalizedPath);
              controller.enqueue(sseEncode({
                type: "delta",
                text: "  音频归一化完成\n",
              }));
            } else {
              controller.enqueue(sseEncode({
                type: "delta",
                text: `  音频归一化跳过：${normResult.error?.slice(0, 80)}\n`,
              }));
            }
          } catch (ffError) {
            // FFmpeg is best-effort
            controller.enqueue(sseEncode({
              type: "delta",
              text: `  FFmpeg 后期跳过：${ffError instanceof Error ? ffError.message.slice(0, 80) : "未知错误"}\n`,
            }));
          }
        }

        // Step 5: Save assistant message with video info
        const videoSummary = [
          "## 视频制作完成\n",
          `**主题**: ${content.slice(0, 50)}\n`,
          `**场景数**: ${(remotionProps as { cuts?: unknown[] }).cuts?.length ?? 0}\n`,
          `**文件**: /videos/${videoFileName}\n`,
          "",
          "### 视频脚本 (JSON)",
          "```json",
          JSON.stringify(remotionProps, null, 2),
          "```",
        ].join("\n");

        const assistantMessage = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: "ASSISTANT",
            content: videoSummary,
          },
        });

        await prisma.openClawTask.update({
          where: { id: task.id },
          data: { status: "SUCCEEDED", resultJson: JSON.stringify(remotionProps) },
        });

        await prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            title: conversation.title === "新的对话" ? titleFrom(content) : conversation.title,
          },
        });

        // Step 6: Auto-save to content library (title + video only, no cover image or body text)
        const videoTitle = content.slice(0, 30) || "视频作品";
        const saved = await prisma.contentItem.create({
          data: {
            userId: user.id,
            title: videoTitle,
            body: "",
            category: "视频",
            coverImageUrl: null,
            videoUrl: `/videos/${videoFileName}`,
            sourceConversationId: conversation.id,
          },
        });

        const contentSaved = {
          id: saved.id,
          title: saved.title,
          category: saved.category,
          videoUrl: saved.videoUrl,
        };

        controller.enqueue(sseEncode({
          type: "final",
          message: {
            id: assistantMessage.id,
            role: "ASSISTANT",
            content: assistantMessage.content,
            createdAt: assistantMessage.createdAt.toISOString(),
          },
          contentSaved,
          videoUrl: `/videos/${videoFileName}`,
        }));
      } catch (error) {
        await prisma.openClawTask.update({
          where: { id: task.id },
          data: {
            status: "FAILED",
            error: error instanceof Error ? error.message : "视频制作失败。",
          },
        });
        controller.enqueue(sseEncode({
          type: "error",
          error: error instanceof Error ? error.message : "视频制作失败。",
        }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
