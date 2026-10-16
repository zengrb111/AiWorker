import { jsonError } from "@/lib/http";
import { createViralRemake } from "@/lib/openmontage";
import { prisma } from "@/lib/prisma";
import { probeDuration } from "@/lib/ffmpeg";
import { requireUser } from "@/lib/session";
import { pickBgm, resolveRenderEngine, runVideoPipeline } from "@/lib/video/pipeline";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const maxUploadBytes = 500 * 1024 * 1024;
const videoExtensions = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** SSE 心跳间隔（毫秒）：出片期间长时间无事件，靠 ping 保活。 */
const HEARTBEAT_MS = 15_000;

function sseEncode(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function extractReferenceUrl(value: string): string | null {
  // 平台分享口令通常会把链接夹在描述文字、日期和邀请码中间。
  const withProtocol = value.match(/https?:\/\/[^\s<>"'，。！？；、]+/i)?.[0];
  const withoutProtocol = value.match(/(?:www\.|v\.douyin\.com\/|xhslink\.com\/|channels\.weixin\.qq\.com\/|v\.kuaishou\.com\/)[^\s<>"'，。！？；、]*/i)?.[0];
  const candidate = withProtocol ?? withoutProtocol;
  if (!candidate) return null;
  const trimmed = candidate.replace(/[),.;:：!?！？]+$/u, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function saveFile(file: File, directory: string, prefix: string): Promise<string> {
  const extension = extname(file.name).toLowerCase();
  const target = join(directory, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extension}`);
  await writeFile(target, Buffer.from(await file.arrayBuffer()));
  return target;
}

export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);
  const conversation = await prisma.conversation.findFirst({ where: { id: context.params.id, userId: user.id } });
  if (!conversation) return jsonError("对话不存在。", 404);

  const form = await request.formData();
  const referenceText = String(form.get("referenceUrl") ?? "").trim();
  const referenceUrl = extractReferenceUrl(referenceText);
  const referenceVideo = form.get("referenceVideo");
  const materialFiles = form.getAll("materials").filter((item): item is File => item instanceof File && item.size > 0);
  if (!referenceUrl && !(referenceVideo instanceof File && referenceVideo.size > 0)) return jsonError("未从输入内容中识别到视频链接，请粘贴完整分享口令或上传参考视频。");
  if (!materialFiles.length) return jsonError("请至少上传一个制作素材。");
  if (materialFiles.some((file) => file.size > maxUploadBytes)) return jsonError("单个素材文件不能超过 500MB。");
  if (materialFiles.some((file) => !videoExtensions.has(extname(file.name).toLowerCase()) && !imageExtensions.has(extname(file.name).toLowerCase()))) return jsonError("素材仅支持 MP4、MOV、M4V、WebM、JPG、PNG 或 WebP。");

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const uploadsDir = join(process.cwd(), "public", "uploads", "remake", token);
  const projectDir = join(process.cwd(), "OpenMontage", "projects", `remake-${token}`);
  const videosDir = join(process.cwd(), "public", "videos");
  await Promise.all([mkdir(uploadsDir, { recursive: true }), mkdir(projectDir, { recursive: true }), mkdir(videosDir, { recursive: true })]);
  let referencePath: string | undefined;
  if (referenceVideo instanceof File && referenceVideo.size > 0) {
    const extension = extname(referenceVideo.name).toLowerCase();
    if (!videoExtensions.has(extension)) return jsonError("参考视频仅支持 MP4、MOV、M4V 或 WebM。");
    referencePath = await saveFile(referenceVideo, uploadsDir, "reference");
  }
  const materialPaths = await Promise.all(materialFiles.map((file) => saveFile(file, uploadsDir, "material")));
  const outputName = `viral-remake-${token}.mp4`;
  const outputPath = join(videosDir, outputName);
  const task = await prisma.openClawTask.create({
    data: { userId: user.id, type: "video-remake", prompt: referenceUrl || "uploaded-reference", status: "RUNNING" },
  });

  const stream = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        controller.enqueue(sseEncode({ type: "ping", at: Date.now() }));
      }, HEARTBEAT_MS);

      const sendProgress = (text: string) => {
        if (text.trim()) controller.enqueue(sseEncode({ type: "delta", text: `${text}\n` }));
      };
      try {
        const engine = resolveRenderEngine();
        let videoUrl: string;
        let engineUsed: string;

        if (engine === "openclaw") {
          // 回滚路径：仍走 OpenMontage 的 Python 制作流程
          sendProgress("素材上传完成，正在启动 OpenMontage 制作流程...");
          await createViralRemake(
            { referenceUrl: referenceUrl || undefined, referencePath, materialPaths, workspace: projectDir, outputPath },
            sendProgress,
          );
          videoUrl = `/videos/${outputName}`;
          engineUsed = "openmontage";
        } else {
          // 新路径：DeepSeek 排素材节奏 → 项目内 Remotion 竖版渲染 → 本地后期。
          // 参考视频只用来对齐节奏与时长，不作为素材 —— 那是原作的版权内容。
          const referenceDuration = referencePath ? await probeDuration(referencePath) : 0;
          const firstVideo = materialPaths.find((p) => videoExtensions.has(extname(p).toLowerCase()));
          const materialDuration = firstVideo ? await probeDuration(firstVideo) : 0;
          // 复刻以素材自身长度为准：素材只有 8 秒就没必要硬撑到 40 秒
          const targetSeconds = Math.max(8, Math.round(materialDuration || Math.min(referenceDuration, 30) || 20));

          sendProgress("素材上传完成，正在按参考节奏排布画面...");
          const result = await runVideoPipeline({
            mode: "remake",
            token,
            materials: materialPaths,
            requirement: [
              `复刻参考视频（${referenceUrl || "已上传参考视频"}）的节奏与情绪`,
              referenceDuration ? `参考视频时长约 ${Math.round(referenceDuration)} 秒` : "",
              "用我上传的素材重新编排一条同类型短视频",
            ]
              .filter(Boolean)
              .join("；"),
            theme: String(form.get("theme") ?? "").trim() || undefined,
            targetSeconds,
            bgmPath: pickBgm(),
            // 归属用户：分镜规划与配音都按该用户「系统配置」里的模型服务来调用
            userId: user.id,
            onProgress: sendProgress,
          });
          if (!result.ok) throw new Error(result.error ?? "视频复刻失败。");
          if (!result.videoUrl) throw new Error("视频复刻未产出成片。");
          videoUrl = result.videoUrl;
          engineUsed = result.engineUsed;
        }

        const assistantMessage = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: "ASSISTANT",
            content: `已根据参考节奏和你上传的素材完成视频制作：${videoUrl}`,
          },
        });
        const saved = await prisma.contentItem.create({
          data: { userId: user.id, title: "爆款视频复刻", body: "", category: "视频", videoUrl, sourceConversationId: conversation.id },
        });
        await prisma.openClawTask.update({
          where: { id: task.id },
          data: {
            status: "SUCCEEDED",
            resultJson: JSON.stringify({ videoUrl, engine: engineUsed, messageId: assistantMessage.id, contentId: saved.id }),
          },
        });
        controller.enqueue(
          sseEncode({ type: "final", videoUrl, contentSaved: { id: saved.id, title: saved.title, category: saved.category, videoUrl } }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "视频复刻失败。";
        await prisma.openClawTask.update({ where: { id: task.id }, data: { status: "FAILED", error: message } });
        controller.enqueue(sseEncode({ type: "error", error: message }));
      } finally {
        // 必须清掉心跳：流 close 之后继续 enqueue 会抛错
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
