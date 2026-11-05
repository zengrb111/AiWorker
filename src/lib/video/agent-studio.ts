import { randomBytes } from "node:crypto";
import { cpSync, existsSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { prisma } from "@/lib/prisma";
import { assertPathAllowed, projectDirFor } from "./agent-studio-paths";

/**
 * 龙虾用 DSH 调 huashu-motion 出片后，把成片**登记成可进 Studio 修改的项目**。
 *
 * 为什么不能只存一个「来源标记」：平台判断「这条视频能不能改」全靠两处硬约定 ——
 *   1. 前端 `huashuTokenOf()` 正则 `/videos/huashu-([A-Za-z0-9-]+)-vN.mp4/`，匹配上才渲染
 *      「去 Studio 修改」按钮；
 *   2. `POST /api/video-motion/<token>/studio` 按 token 查 `VideoMotionProject`，
 *      再 `ensureStudio(project.projectDir)` 起 om studio，目录不存在直接 410。
 * 所以这里必须同时产出「规范命名的成片」+「带真实 projectDir 的项目记录」，
 * 并让 status=READY / versionsJson 带 v1，后台 tick 才会自动接单改片。
 */

export const AGENT_HUASHU_SOURCE = "DSH_HUASHU";

/** 前端正则只认 `[A-Za-z0-9-]`，token 里出现下划线会让按钮消失。 */
const TOKEN_RE = /^[A-Za-z0-9-]{1,64}$/;

/** om 项目的标志：om new 会生成 .om/ 与 index.html（老项目可能只有其中之一）。 */
function assertOmProject(dir: string): void {
  if (existsSync(join(dir, ".om")) || existsSync(join(dir, "index.html"))) return;
  throw new Error(
    `不是有效的 huashu-motion 项目目录（缺少 .om/ 或 index.html）：${dir}。` +
      "Studio 需要完整的 om 工程才能改片；请传 `om new` 建出来的项目根目录，或去掉 studio 标记按普通视频保存。"
  );
}

export type StudioPrepareInput = {
  /** 龙虾侧 huashu 项目根目录（绝对路径） */
  projectDir?: string;
  /** 可选：复用龙虾自己的 token；不传平台生成 */
  token?: string;
  /** 可选：是否把项目复制进平台 public/uploads/huashu/<token>（默认 false，避免大目录拷贝） */
  copyProject?: boolean;
};

export type StudioPrepareResult = {
  token: string;
  /** 最终登记到 VideoMotionProject.projectDir 的绝对路径 */
  projectDir: string;
  /** 成片应落盘成的名字，形如 huashu-<token>-v1.mp4 */
  videoName: string;
  version: number;
  /** 是否复制过项目目录 */
  copied: boolean;
};

/**
 * 落盘前准备：校验项目目录 → 定 token/版本 → 给出成片文件名。
 * 只查库不写库，避免落盘失败时留下孤儿项目记录。
 *
 * 🔴 token 与项目目录名必须一致：huashu Studio 的「同步修改到内容库」是按
 * **目录名**回调 `POST /api/video-motion/<目录名>/sync`（见 huashu-motion
 * `cli/lib/server.js::syncToPlatform`）。目录名与 token 不一致时，Studio 会请求到
 * 一个不存在的项目 → 用户看到「点了同步，内容库没变」。
 * 所以优先用目录名当 token；目录名不可用（含下划线/中文）或被别人占用时，
 * 才生成新 token 并把项目复制到 `public/uploads/huashu/<token>`。
 */
export async function prepareAgentStudio(
  input: StudioPrepareInput,
  userId?: string
): Promise<StudioPrepareResult> {
  const rawDir = (input.projectDir || "").trim();
  if (!rawDir) {
    throw new Error("studio 模式缺少 projectDir：请传 DSH 出片时那个 huashu-motion 项目根目录的绝对路径。");
  }
  const sourceDir = resolve(rawDir);
  assertPathAllowed(sourceDir, "huashu 项目目录");
  let realDir: string;
  try {
    realDir = realpathSync(sourceDir);
  } catch {
    throw new Error(`找不到 huashu 项目目录：${sourceDir}`);
  }
  if (!statSync(realDir).isDirectory()) {
    throw new Error(`huashu 项目路径不是目录：${realDir}`);
  }
  assertOmProject(realDir);

  const dirName = basename(realDir);
  let token = (input.token || "").trim();
  let mustCopy = input.copyProject === true;

  if (!token) {
    // 目录名可直接当 token 且没被别的账号占用 → 零拷贝
    const nameUsable = TOKEN_RE.test(dirName);
    const occupant = nameUsable
      ? await prisma.videoMotionProject.findUnique({ where: { token: dirName }, select: { userId: true } })
      : null;
    if (nameUsable && (!occupant || !userId || occupant.userId === userId)) {
      token = dirName;
    } else {
      token = `${Date.now()}-${randomBytes(4).toString("hex")}`;
      mustCopy = true;
    }
  }

  if (!TOKEN_RE.test(token)) {
    throw new Error(
      "token 只能用字母、数字、连字符（1~64 位），不能有下划线或路径分隔符 —— 前端靠它从 videoUrl 里识别 Studio 项目。"
    );
  }

  // 同一 token 重复保存（龙虾改片后重传）递增版本号，避免覆盖 v1 且让 Studio 版本链不断。
  const existing = await prisma.videoMotionProject.findUnique({ where: { token } });
  const versions = existing ? parseVersions(existing.versionsJson) : [];
  const version = Math.max(0, ...versions.map((v) => Number(v.version) || 0)) + 1;

  let finalDir = realDir;
  let copied = false;
  // 显式传了 token 但目录名对不上 → 也必须复制，否则 Studio 同步还是会打错项目
  if (basename(realDir) !== token) mustCopy = true;
  if (mustCopy) {
    const target = projectDirFor(token);
    if (resolve(target).toLowerCase() !== realDir.toLowerCase()) {
      cpSync(realDir, target, { recursive: true, force: true });
      finalDir = target;
      copied = true;
    }
  }

  return {
    token,
    projectDir: finalDir,
    videoName: `huashu-${token}-v${version}.mp4`,
    version,
    copied
  };
}

export type RegisterStudioInput = {
  userId: string;
  studio: StudioPrepareResult;
  /** 最终生效的站内 videoUrl（幂等命中时可能是已有条目的 URL） */
  videoUrl: string;
  title: string;
  productName?: string;
  siteUrl?: string;
  targetSeconds?: number | null;
  duration?: number | null;
};

/**
 * 登记 / 更新 VideoMotionProject。
 * source 记为 DSH_HUASHU —— 这就是「由 DSH 调 huashu-motion 创建」的持久化标记，
 * 便于后续筛选「哪些片子是龙虾出的」，同时不影响前端按 videoUrl 归类。
 */
export async function registerAgentStudioProject(input: RegisterStudioInput): Promise<{
  token: string;
  projectDir: string;
  version: number;
  source: string;
  status: string;
}> {
  const { studio, userId, videoUrl, title } = input;
  const createdAt = new Date().toISOString();
  const productName = (input.productName || "").trim() || title;
  const siteUrl = (input.siteUrl || "").trim() || null;
  const targetSeconds =
    typeof input.targetSeconds === "number" && Number.isFinite(input.targetSeconds)
      ? Math.min(120, Math.max(5, Math.round(input.targetSeconds)))
      : null;
  const duration =
    typeof input.duration === "number" && Number.isFinite(input.duration) ? input.duration : null;

  const existing = await prisma.videoMotionProject.findUnique({ where: { token: studio.token } });
  // 防跨用户抢占同一个 token（内容库按账号隔离，项目也必须隔离）。
  if (existing && existing.userId !== userId) {
    throw new Error(`token「${studio.token}」已被其他账号占用，请换一个或不传 token 由平台生成。`);
  }

  const versionRecord = {
    version: studio.version,
    videoUrl,
    duration,
    createdAt,
    note: "龙虾 DSH 出片"
  };
  const versions = existing ? parseVersions(existing.versionsJson) : [];
  const nextVersions = [...versions.filter((v) => v.version !== studio.version), versionRecord].sort(
    (a, b) => a.version - b.version
  );

  if (existing) {
    await prisma.videoMotionProject.update({
      where: { id: existing.id },
      data: {
        projectDir: studio.projectDir,
        status: "READY",
        videoUrl,
        versionsJson: JSON.stringify(nextVersions),
        error: null,
        ...(siteUrl ? { siteUrl } : {}),
        ...(targetSeconds != null ? { targetSeconds } : {})
      }
    });
  } else {
    await prisma.videoMotionProject.create({
      data: {
        token: studio.token,
        userId,
        source: AGENT_HUASHU_SOURCE,
        siteUrl,
        productName,
        projectDir: studio.projectDir,
        status: "READY",
        videoUrl,
        versionsJson: JSON.stringify(nextVersions),
        progressInChat: false,
        targetSeconds
      }
    });
  }

  return {
    token: studio.token,
    projectDir: studio.projectDir,
    version: studio.version,
    source: AGENT_HUASHU_SOURCE,
    status: "READY"
  };
}

function parseVersions(json: string): Array<{ version: number; videoUrl: string; duration: number | null; createdAt: string; note: string }> {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** studio 模式下成片必须是 mp4：命名规范与前端正则都写死 .mp4。 */
export function assertStudioVideoExt(videoNameOrPath: string): void {
  if (!/\.mp4$/i.test(basename(videoNameOrPath))) {
    throw new Error(
      "studio 模式的成片必须是 .mp4（huashu-motion 渲染产物即 mp4）。" +
        "若手上不是 mp4，请先转码，或去掉 studio 标记按普通视频保存（那样没有 Studio 修改入口）。"
    );
  }
}
