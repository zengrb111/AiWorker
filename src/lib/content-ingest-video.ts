import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { prisma } from "@/lib/prisma";
import { extractArticleTitle } from "@/lib/content-ingest";
import { extractVideoPoster } from "@/lib/video/poster";
import { assertPathAllowed } from "@/lib/video/agent-studio-paths";
import {
  AGENT_HUASHU_SOURCE,
  assertStudioVideoExt,
  prepareAgentStudio,
  registerAgentStudioProject,
  type StudioPrepareResult
} from "@/lib/video/agent-studio";

/**
 * 龙虾（OpenClaw agent）把**已出片的视频**存进内容库。
 *
 * 与 /api/content/ingest 的区别（刻意分开，别混用）：
 * - 那边只收 ≥200 字的图文稿，遇到「视频」分类会**后台生成一支新片**；
 * - 这边收的是龙虾手里**已经存在的成片**，只负责落盘 + 入库，绝不触发生成，
 *   也不要求正文长度（视频条目常常只有一句标题/脚本）。
 *
 * 视频来源三种，统一收敛成站内 `/videos/xxx.mp4`：
 *   1. upload   —— multipart 直接传文件（最通用，不依赖同机）
 *   2. filePath —— 服务器本地绝对路径（线上龙虾与平台同机，huashu-motion 产物直接给路径）
 *   3. videoUrl —— 站内 /videos|/uploads 路径（直接引用）或 http(s) 远程 URL（下载落盘）
 *
 * 运行期写进 public/videos 能被访问，依赖 nginx 已配 `/videos` 直读磁盘
 * （next start 启动时缓存 public 文件清单，新写的文件必须靠 nginx 直出，否则 404）。
 *
 * `studio: true` —— 片子是龙虾用 DSH 调 huashu-motion 出的，要能进 Studio 改：
 * 额外传 `projectDir`（om 项目根目录），平台会按 `/videos/huashu-<token>-v1.mp4`
 * 规范落盘、登记 VideoMotionProject（source=DSH_HUASHU, status=READY），
 * 前端「去 Studio 修改」按钮与后台改片 tick 才会自动生效。见 video/agent-studio.ts。
 */

const VIDEOS_DIR = join(process.cwd(), "public", "videos");
const ALLOWED_EXT = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const MAX_BYTES = 100 * 1024 * 1024; // 100MB，防误传整段素材把磁盘打满
const DOWNLOAD_TIMEOUT_MS = 60_000;

export type VideoUpload = { name: string; data: Buffer };

export type IngestVideoInput = {
  title?: string;
  /** 视频说明 / 脚本 / 配文；可空，不设最小字数 */
  body?: string;
  /** 默认「视频」；前端按 videoUrl 归类，category 只作展示 */
  category?: string;
  /** 不传则自动从成片抽一帧 */
  coverImageUrl?: string;
  /** 传了就更新这条已有内容（把成片挂到先前建的占位条目），不传则新建 */
  contentId?: string;
  /** 站内相对路径或 http(s) 远程地址 */
  videoUrl?: string;
  /** 服务器本地绝对路径（受白名单目录限制） */
  filePath?: string;
  /** multipart 上传的文件 */
  upload?: VideoUpload;

  // ── Studio（DSH + huashu-motion 出片）────────────────────────────
  /** true = 这支片子由 DSH 调 huashu-motion 创建，要登记成可进 Studio 修改的项目 */
  studio?: boolean;
  /** DSH 出片时的 huashu-motion 项目根目录（绝对路径）；studio=true 时必填 */
  projectDir?: string;
  /** 可选，复用龙虾自己的项目 token；不传平台生成 */
  token?: string;
  /** 可选，是否把项目复制进平台 public/uploads/huashu/<token> */
  copyProject?: boolean;
  /** 可选，项目展示名（默认用标题） */
  productName?: string;
  /** 可选，产品网站 */
  siteUrl?: string;
  /** 可选，目标时长（秒），Studio 改片重出片时据此裁剪 */
  targetSeconds?: number;
  /** 可选，成片时长（秒），写进版本记录 */
  duration?: number;
};

export type StudioResult = {
  token: string;
  projectDir: string;
  version: number;
  source: string;
  status: string;
  /** 打开 Studio 的接口路径（前端按钮会自己拼） */
  studioPath: string;
  /** 项目目录是否复制进了平台托管目录 */
  copied: boolean;
};

export type IngestVideoResult = {
  contentId: string;
  title: string;
  videoUrl: string;
  coverImageUrl: string | null;
  category: string;
  /** true=新建，false=更新已有条目 */
  created: boolean;
  /** true=幂等命中，复用已有条目，没有重复建 */
  reused: boolean;
  /** 成片是怎么进来的，便于龙虾自查 */
  origin: "station" | "download" | "filePath" | "upload";
  /** studio=true 时返回；没登记则为 null */
  studio: StudioResult | null;
};

function assertVideoExt(nameOrPath: string): string {
  const ext = extname(nameOrPath).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`只支持 ${[...ALLOWED_EXT].join(" / ")} 视频文件，收到「${ext || "无扩展名"}」。`);
  }
  return ext;
}

function assertVideoSize(bytes: number): void {
  if (bytes <= 0) throw new Error("视频文件是空的。");
  if (bytes > MAX_BYTES) {
    throw new Error(`视频超过 ${MAX_BYTES / 1024 / 1024}MB 上限（${(bytes / 1024 / 1024).toFixed(1)}MB）。`);
  }
}

/** 站内路径：只允许 /videos/ 与 /uploads/，且文件必须真实存在。 */
function isStationPath(url: string): boolean {
  return /^\/(videos|uploads)\//.test(url) && !url.includes("..") && !/[?#]/.test(url);
}

async function stationPathExists(url: string): Promise<void> {
  const abs = join(process.cwd(), "public", url);
  if (!existsSync(abs)) throw new Error(`站内找不到这个视频文件：${url}`);
  const info = await stat(abs);
  assertVideoSize(info.size);
}

function newVideoName(ext: string): string {
  return `agent-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`;
}

/**
 * 把三种来源统一落盘，返回站内 URL 与来源类型。
 * studio 传非空时强制用 `/videos/huashu-<token>-vN.mp4` 命名 —— 这是前端识别
 * 「可去 Studio 修改」的唯一依据，不能用 agent-xxx.mp4 那种自由名。
 */
async function resolveVideoSource(
  input: IngestVideoInput,
  studio: StudioPrepareResult | null
): Promise<{ videoUrl: string; origin: IngestVideoResult["origin"] }> {
  const sources = [input.upload ? 1 : 0, input.filePath ? 1 : 0, input.videoUrl ? 1 : 0].reduce(
    (a, b) => a + b,
    0
  );
  if (sources === 0) {
    throw new Error("缺少视频：请传 multipart 的 file 字段，或 JSON 里的 filePath / videoUrl。");
  }
  if (sources > 1) {
    throw new Error("视频来源只能给一个：file、filePath、videoUrl 三选一。");
  }

  // 1) multipart 上传
  if (input.upload) {
    const ext = assertVideoExt(input.upload.name);
    if (studio) assertStudioVideoExt(input.upload.name);
    assertVideoSize(input.upload.data.length);
    await mkdir(VIDEOS_DIR, { recursive: true });
    const name = studio ? studio.videoName : newVideoName(ext);
    await writeFile(join(VIDEOS_DIR, name), input.upload.data);
    return { videoUrl: `/videos/${name}`, origin: "upload" };
  }

  // 2) 同机绝对路径
  if (input.filePath) {
    const abs = resolve(input.filePath.trim());
    const ext = assertVideoExt(abs);
    if (studio) assertStudioVideoExt(abs);
    assertPathAllowed(abs, "视频文件");
    const info = await stat(abs);
    assertVideoSize(info.size);
    await mkdir(VIDEOS_DIR, { recursive: true });
    const name = studio ? studio.videoName : newVideoName(ext);
    await copyFile(abs, join(VIDEOS_DIR, name));
    return { videoUrl: `/videos/${name}`, origin: "filePath" };
  }

  // 3) 站内路径 / 远程 URL
  const url = (input.videoUrl || "").trim();
  if (isStationPath(url)) {
    await stationPathExists(url);
    if (!studio) return { videoUrl: url, origin: "station" };
    // studio 模式：站内原名不符合 huashu 规范，复制一份规范命名的副本（原件保留）。
    assertStudioVideoExt(url);
    const name = studio.videoName;
    await mkdir(VIDEOS_DIR, { recursive: true });
    await copyFile(join(process.cwd(), "public", url), join(VIDEOS_DIR, name));
    return { videoUrl: `/videos/${name}`, origin: "station" };
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("videoUrl 需为站内 /videos/、/uploads/ 路径，或 http(s) 开头的远程地址。");
  }

  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  // 基本 SSRF 防护：龙虾是内部可信 agent，但仍不让它借平台去探内网。
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "169.254.169.254" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^127\./.test(host)
  ) {
    throw new Error("不允许从内网地址下载视频，请改用 filePath 同机路径或先自行落盘。");
  }

  const ext = assertVideoExt(parsed.pathname);
  if (studio) assertStudioVideoExt(parsed.pathname);
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`下载视频失败（HTTP ${response.status}）。`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared) assertVideoSize(declared);
  const data = Buffer.from(await response.arrayBuffer());
  assertVideoSize(data.length);
  await mkdir(VIDEOS_DIR, { recursive: true });
  const name = studio ? studio.videoName : newVideoName(ext);
  await writeFile(join(VIDEOS_DIR, name), data);
  return { videoUrl: `/videos/${name}`, origin: "download" };
}

/** 视频封面：调用方没给就抽一帧；抽帧失败不阻塞入库（列表用占位图）。 */
async function resolveCover(videoUrl: string, provided?: string): Promise<string | null> {
  const given = (provided || "").trim();
  if (given) return given;
  try {
    return await extractVideoPoster(videoUrl, basename(videoUrl, extname(videoUrl)));
  } catch (error) {
    console.warn("[content-ingest-video] 抽封面帧失败（保留空封面）：", error);
    return null;
  }
}

/** 同一天零点，用于幂等去重。 */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 把 studio 项目登记成结果。幂等命中时不能登记 —— 本次落盘的副本已被删掉，
 * 把不存在的 vN 写进版本链会让 Studio 改片后同步到空文件；此时只回报已有项目信息。
 */
async function finalizeStudio(
  userId: string,
  input: IngestVideoInput,
  studio: StudioPrepareResult | null,
  videoUrl: string,
  title: string,
  register: boolean
): Promise<StudioResult | null> {
  if (!studio) return null;
  let version = studio.version;
  if (register) {
    const row = await registerAgentStudioProject({
      userId,
      studio,
      videoUrl,
      title,
      productName: input.productName,
      siteUrl: input.siteUrl,
      targetSeconds: input.targetSeconds,
      duration: input.duration
    });
    version = row.version;
  } else {
    // 幂等命中：本次副本已删，回报库里真正存在的最高版本，别把 prepare 阶段预分配的
    // 下一个版本号当成已出片版本回给龙虾。
    const existing = await prisma.videoMotionProject.findUnique({ where: { token: studio.token } });
    const versions = existing?.versionsJson ? safeParseVersions(existing.versionsJson) : [];
    const highest = Math.max(0, ...versions.map((v) => Number(v.version) || 0));
    version = highest || studio.version;
  }
  return {
    token: studio.token,
    projectDir: studio.projectDir,
    version,
    source: AGENT_HUASHU_SOURCE,
    status: "READY",
    studioPath: `/api/video-motion/${studio.token}/studio`,
    copied: studio.copied
  };
}

function safeParseVersions(json: string): Array<{ version?: number }> {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 保存一条视频内容。
 *
 * 幂等：同账号当天已存在同一支成片（或同名）条目时直接复用，避免龙虾重试/重复跑任务
 * 灌出一堆重复视频。传 contentId 则走「更新已有条目」。
 * 封面按需抽帧 —— 重复提交时不抽，避免留下没人引用的孤儿封面文件。
 */
export async function ingestVideoContent(
  userId: string,
  input: IngestVideoInput
): Promise<IngestVideoResult> {
  const body = (input.body || "").trim();
  const title =
    (input.title || "").trim().slice(0, 120) ||
    extractArticleTitle(body, `视频内容-${new Date().toISOString().slice(0, 10)}`);
  const category = (input.category || "").trim() || "视频";

  // studio 模式先校验项目目录并定好 token/版本/成片名，再落盘（失败就不留孤儿记录）。
  // 只要传了 projectDir 就自动进 studio —— 龙虾/脚本漏传 studio:true 时别让能力静默失效。
  const wantStudio = input.studio ?? Boolean((input.projectDir || "").trim());
  const studio = wantStudio ? await prepareAgentStudio(input, userId) : null;
  const { videoUrl, origin } = await resolveVideoSource(input, studio);

  // 更新已有条目：把成片挂上去，标题/正文有传才覆盖。
  if (input.contentId) {
    const existing = await prisma.contentItem.findFirst({
      where: { id: input.contentId.trim(), userId },
      select: { id: true, title: true }
    });
    if (!existing) throw new Error("找不到指定的 contentId（或这条内容不属于当前账号）。");
    const coverImageUrl = await resolveCover(videoUrl, input.coverImageUrl);
    const updated = await prisma.contentItem.update({
      where: { id: existing.id },
      data: {
        videoUrl,
        coverImageUrl: coverImageUrl ?? undefined,
        ...(input.title ? { title } : {}),
        ...(body ? { body } : {}),
        category
      }
    });
    return {
      contentId: updated.id,
      title: updated.title,
      videoUrl,
      coverImageUrl: coverImageUrl ?? null,
      category,
      created: false,
      reused: false,
      origin,
      studio: await finalizeStudio(userId, input, studio, videoUrl, updated.title, true)
    };
  }

  // 幂等：同一账号、当天、同一支成片（或同一标题）只留一条。
  // 上传/复制每次会生成新文件名，光按 videoUrl 匹配挡不住「重复上传同一支片子」，
  // 所以再按标题兜一层 —— 与 /api/content/ingest 的「当天同名去重」保持一致。
  const duplicated = await prisma.contentItem.findFirst({
    where: {
      userId,
      createdAt: { gte: startOfToday() },
      OR: [{ videoUrl }, { title }]
    },
    select: { id: true, title: true, category: true, coverImageUrl: true, videoUrl: true },
    orderBy: { createdAt: "asc" }
  });
  if (duplicated) {
    const existingVideoUrl = duplicated.videoUrl ?? videoUrl;
    // 本次新落盘的文件是多余的，删掉避免垃圾堆积（站内路径是引用，不能删）。
    if (origin !== "station") {
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(join(process.cwd(), "public", videoUrl));
      } catch {
        /* ignore */
      }
    }
    // 已有条目缺封面才补抽一帧（用库里那条真实视频，不是刚删掉的重复文件）。
    let finalCover = duplicated.coverImageUrl;
    if (!finalCover) {
      finalCover = await resolveCover(existingVideoUrl, input.coverImageUrl);
      if (finalCover) {
        await prisma.contentItem
          .update({ where: { id: duplicated.id }, data: { coverImageUrl: finalCover } })
          .catch(() => undefined);
      }
    }
    return {
      contentId: duplicated.id,
      title: duplicated.title,
      // 返回库里那条真正能播放的地址，而不是刚被删掉的重复文件。
      videoUrl: existingVideoUrl,
      coverImageUrl: finalCover,
      category: duplicated.category ?? category,
      created: false,
      reused: true,
      origin,
      // 幂等命中：副本已删，只回报已有项目信息，不再写版本链。
      studio: await finalizeStudio(userId, input, studio, existingVideoUrl, duplicated.title, false)
    };
  }

  const coverImageUrl = await resolveCover(videoUrl, input.coverImageUrl);
  const created = await prisma.contentItem.create({
    data: { userId, title, body, category, videoUrl, coverImageUrl }
  });
  return {
    contentId: created.id,
    title: created.title,
    videoUrl,
    coverImageUrl: coverImageUrl ?? null,
    category,
    created: true,
    reused: false,
    origin,
    studio: await finalizeStudio(userId, input, studio, videoUrl, created.title, true)
  };
}
