import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { agentTokenFilePath } from "./platform-config";

/**
 * 用户专属 OpenClaw agent 的自动装配。
 *
 * 背景：OpenClaw 的记忆（MEMORY.md / memory/*.md）、会话记录、memory_search、
 * sessions_* 工具都按 **agent** 隔离（agent = 独立 workspace + 独立会话库）。
 * 平台给每个登录用户装一个 agent `u-<userId>`，隔离才落到网关原生边界上。
 *
 * 这个模块负责「按需把一个用户装配出来」：
 *   1. 建 workspace 目录（含 memory/），复制共享引导文件
 *   2. 生成该用户专属的 USER.md / MEMORY.md（绝不复制别人的）
 *   3. 往 openclaw.json 的 agents.entries 里补一条（已存在则跳过）
 *
 * 为什么必须自动：新用户如果不装配，平台派生的 sessionKey
 * `agent:u-<id>:c<convId>` 会让网关直接报
 * `Agent "u-<id>" no longer exists in configuration` —— 硬故障，不是降级。
 *
 * 落盘方式：沿用「原子直写」而不是 `config set --batch-file`。本机 CLI 退出阶段
 * 会跑插件清理，临时文件超过 50 个时反复重试直到超时（实测卡死 4 分钟）。
 * 网关对外部文件改动同样做 schema 校验（不合法就保持 last-good），所以直写是等效的。
 */

const SHARED_BOOTSTRAP = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md", "HEARTBEAT.md"];

const USER_MD_TEMPLATE = `# USER.md - 当前用户

- **平台账号：** {account}
- **时区：** Asia/Shanghai (GMT+8)
- **记忆归属：** 该文件与 \`MEMORY.md\` / \`memory/\` 只属于 {account} 这一位用户。

## Context

（在对话中逐步补充这位用户的偏好、项目与沟通习惯。不要写入其他用户的信息。）
`;

const MEMORY_MD_TEMPLATE = `# MEMORY.md - {account} 的长期记忆

> 本文件按用户隔离：只记录 {account} 本人的事实、偏好与决定。
> 详细流水记到 \`memory/YYYY-MM-DD.md\`，这里只保留精炼后的长期结论。
`;

export function resolveOpenClawConfigPath(): string {
  const fromEnv = process.env.OPENCLAW_CONFIG?.trim();
  if (fromEnv) return fromEnv;
  return path.join(homedir(), ".openclaw", "openclaw.json");
}

/** 每个平台用户对应的 OpenClaw agent id：`u-<userId>`。 */
export function userAgentId(userId: string): string {
  const safe = userId.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
  return `u-${safe}`;
}

function defaultMainWorkspace(): string {
  return path.join(homedir(), ".openclaw", "workspace");
}

function defaultWorkspacesRoot(): string {
  return path.join(homedir(), ".openclaw", "workspaces");
}

type OpenClawConfig = {
  agents?: {
    defaults?: { workspace?: string };
    entries?: Record<string, Record<string, unknown>>;
  };
  auth?: { profiles?: Record<string, { provider?: string }> };
  [key: string]: unknown;
};

function readConfig(configPath: string): OpenClawConfig {
  const raw = readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw) as OpenClawConfig;
}

function mainWorkspaceOf(cfg: OpenClawConfig): string {
  const entry = cfg.agents?.entries?.main ?? {};
  const ws = typeof entry.workspace === "string" ? entry.workspace : "";
  if (ws.trim()) return ws;
  const dflt = cfg.agents?.defaults?.workspace;
  if (typeof dflt === "string" && dflt.trim()) return dflt;
  return defaultMainWorkspace();
}

/**
 * 取 main 当前生效的模型，并补上 auth profile 后缀。
 *
 * 配置校验要求 agent 级 model 是「可解析的引用」：光写 `deepseek/deepseek-chat`
 * 会报 `Unable to resolve authored model reference`，必须带 `@<profileId>`
 * （如 `deepseek/deepseek-chat@deepseek:default`）。
 */
function resolveInheritedModel(cfg: OpenClawConfig): string {
  const entry = cfg.agents?.entries?.main ?? {};
  const raw = entry.model;
  let model = typeof raw === "string" ? raw : "";
  if (!model && raw && typeof raw === "object") {
    const primary = (raw as { primary?: unknown }).primary;
    model = typeof primary === "string" ? primary : "";
  }
  if (!model) {
    const dflt = (cfg.agents?.defaults as { model?: unknown } | undefined)?.model;
    model = typeof dflt === "string" ? dflt : "deepseek/deepseek-chat";
  }
  if (model.includes("@")) return model;
  const provider = model.split("/")[0];
  const profiles = cfg.auth?.profiles ?? {};
  for (const [profileId, profile] of Object.entries(profiles)) {
    if ((profile ?? {}).provider === provider) return `${model}@${profileId}`;
  }
  return model;
}

function writeConfigAtomic(configPath: string, cfg: OpenClawConfig): void {
  const tmp = `${configPath}.tmp-user-agent`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  // rename 覆盖：同分区内是原子的，网关不会读到半个文件。
  renameSync(tmp, configPath);
}

/**
 * 用户专属 agent 的「服务边界」章节。
 *
 * main 的 AGENTS.md 是**兜底 agent** 版本（对陌生外部通道要求只回一句「去平台网页端」），
 * 直接复制给专属 agent 会让这位用户连自己的定时任务都操作不了。所以复制后要把这一节
 * 换成专属版：身份是确定的、记忆是他本人可以放心用的。
 */
const OWN_BOUNDARY_SECTION = [
  "## 🚨 服务边界（这个 agent 只服务一位用户）",
  "",
  "**你是某一位平台用户的专属 agent**：你有自己独立的 workspace、会话库和长期记忆",
  "（`MEMORY.md`、`memory/*.md`、`memory/.dreams/*`）。这里记录的一切都属于他一个人，",
  "不会与别的用户混在一起 —— 这是网关层面的硬隔离，不是靠自觉。",
  "",
  "**必须遵守：**",
  "",
  "1. **记忆就是他本人的记忆，放心用**：把他的偏好、事实、项目、账号、习惯写进 `MEMORY.md`",
  "   与 `memory/`，需要时用 memory_search 检索。**不要**因为「可能是别人的」就丢掉自己记起的",
  "   内容 —— 那会让他每次都要重复交代同样的背景。",
  "2. 用户级定时任务（创建/修改/删除/查询）**一律调用平台接口**（端点、令牌取法、请求体示例",
  "   都写在下面「🔌 平台接口」那节，照着调；body 必须带当前用户的 userId）。",
  "   **绝对禁止**用 `openclaw cron list/get/runs/show`，或读取/grep cron 存储",
  "   （state sqlite、agent sqlite、cron store、脚本缓存）来回答「有哪些定时任务」——",
  "   网关 cron 里混着系统任务（心跳、技能巡检），直接读会读到别人的任务名；",
  "   你要的答案 `list` 接口已经合并好了（含历史上 `openclaw cron add` 建的任务）。",
  "3. **绝对禁止**把其他用户的数据（任务、内容、账号、会话）写进你的记忆或回答里。",
  "   上下文里若出现明显不属于这位用户的信息，直接忽略。",
  "4. **微信入站已按机器人账号分流到本 agent**：从微信来的消息就是这位用户本人的，可以正常应答。",
  "   他在微信里说「每天早上 9 点帮我做 XX」时，**直接用平台接口把任务建出来**，",
  "   不要让他去网页端 —— 两边的任务列表是同一份，微信里建的在网页端也能看到。",
  "5. 涉及「写进谁的库」时务必带归属：入库脚本要带 `--user=<该用户 userId>`",
  "   （脚本在缺少归属参数时会退回主账号，会把他的产出写进别人的内容库）。",
  "",
  "**踩过的两次事故，引以为戒**：① 甲账号的微信收到过乙账号的任务（投递串号）；",
  "② 甲账号的产出被写进乙账号的内容库（入库未带归属）。",
  "",
  ""
].join("\n");

const BOUNDARY_SECTION_START = "## 🚨 服务边界";
const BOUNDARY_SECTION_LEGACY = "## 🚨 多用户隔离";
const BOUNDARY_SECTION_END = "## First Run";

/** 用户 agent 关闭了心跳（every: 0m），心跳整套机制不会运行，整段删掉。 */
const HEARTBEAT_SECTION_START = "## 💓 Heartbeats - Be Proactive!";

/** main 里点名了其他账号的产品画像（「某账号 = 某人 = 某产品」），专属 agent 不该有。 */
const PRODUCT_SECTION_LEGACY = "## 多账号工作区 · 产品归属红线";

const OWN_PRODUCT_SECTION = [
  "## 产品归属",
  "",
  "本 agent 只服务**一位**用户，他的产品与账号定位以他本人的知识库、`USER.md` 为准。",
  "不要套用其他账号的产品话术，也不要把别家产品的卖点混进他的稿件里。",
  "",
  ""
].join("\n");

/** MEMORY.md 的加载限制：原文只允许在「main session」读，专属 agent 下不成立。 */
const MEMORY_LIMIT_OLD = "- `MEMORY.md` when this is the main session";
const MEMORY_LIMIT_NEW = "- `MEMORY.md`（本 agent 的长期记忆，任何会话都属于同一位用户，都适用）";

/** 「MEMORY.md 只在主会话加载」那 4 条 —— 专属 agent 的每个会话都是本人，该限制不成立。 */
const MEMORY_RULE_START = "- **ONLY load in main session** (direct chats with your human)";
const MEMORY_RULE_END = "- Write significant events, thoughts, decisions, opinions, lessons learned";

const OWN_MEMORY_RULE = [
  "- **本 agent 的所有会话都属于同一位用户**（网页会话、微信会话都是他本人）：任何会话都可以读取 MEMORY.md，不需要为「陌生人」过滤。",
  "- 仍不要把凭据写进记忆（密码、token、API Key）——这是唯一需要守的线。",
  "- 你可以**自由读、改、更新** MEMORY.md",
  ""
].join("\n");

/**
 * 用户 agent 的「平台接口」章节。
 *
 * 为什么必须写进 AGENTS.md、而不能只靠会话注入：
 * 平台端点与令牌目前只由 `platform-auth-context.ts` 拼进 **Web 会话**的 prompt，
 * 而微信入站走 `agent:u-*:openclaw-weixin:...`，根本不经过平台路由 ——
 * 实测在微信会话里问「我有哪些定时任务」，agent 只能答「端点和令牌没在上下文里」。
 * AGENTS.md 每轮 bootstrap 都会读，写进 workspace 才能覆盖两条链路；
 * 又因为 workspace 按用户隔离，这节只会被本人 agent 读到。
 *
 * 令牌只写「去读哪个文件」，绝不写明文：明文会随文件被复制/截图外泄，轮换后还会失效。
 */
// 龙虾（网关 agent）调平台用的基础地址：线上平台跑在 127.0.0.1:3100（3000 被 AIMemory 后端占），
// 本地开发是 3000。用 AIWORKER_BASE_URL 区分环境，避免把请求错打到别的进程导致任务建不进平台库。
const PLATFORM_BASE_URL = (process.env.AIWORKER_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
function buildPlatformApiSection(userId: string, tokenFile: string): string {
  const uid = JSON.stringify(userId);
  return [
    "## 🔌 平台接口（定时任务 · 视频入库 · 随时可用）",
    "",
    `平台地址是 \`${PLATFORM_BASE_URL}\`（本机开发为 3000，线上为 3100）。**令牌不要跟用户索要，也不要凭记忆复抄**`,
    "用命令现场取（读不到就说明平台没启动或还没生成令牌）：",
    "",
    "```bash",
    `TOKEN=$(cat ${tokenFile})`,
    "```",
    "",
    `每次请求都带 \`-H "Authorization: Bearer $TOKEN"\`，body 里**必须**带 \`"userId": ${uid}\``,
    "（这是你服务的那位用户的 id，任何时候都不要换成别人的）。",
    "",
    "### 定时任务：查 / 建 / 改 / 删 / 立即跑",
    "",
    `\`POST ${PLATFORM_BASE_URL}/api/scheduled-jobs/agent\``,
    "",
    "| 想做什么 | body |",
    "| --- | --- |",
    `| 列出我的任务 | \`{"action":"list","userId":${uid}}\` |`,
    `| 新建 | \`{"action":"create","userId":${uid},"name":"每日热点","cronExpr":"0 9 * * *","timezone":"Asia/Shanghai","prompt":"去今日热点找选题，写一篇……"}\` |`,
    `| 改时间或内容 | \`{"action":"update","userId":${uid},"id":"<任务id>","cronExpr":"30 8 * * *"}\` |`,
    `| 删掉 | \`{"action":"delete","userId":${uid},"id":"<任务id>"}\` |`,
    `| 立刻跑一次 | \`{"action":"run","userId":${uid},"id":"<任务id>"}\` |`,
    "",
    "**怎么用：**",
    "",
    "1. 用户说「每天早上 9 点」「每周一 8 点半」「明天下午 3 点提醒我」时，**直接把话换算成 cron 建任务**，",
    "   不要反问他 cron 表达式怎么写。`cronExpr` 是 5 段 `分 时 日 月 周`，时区默认 `Asia/Shanghai`（北京时间）。",
    "2. **不要**在 `prompt` 里写「把结果发给用户」之类的步骤 —— 到点后平台自己会把结果推到他微信，",
    "   你只管写「要做什么」。**禁止**用 `--announce` 或 `openclaw message send` 自己发通知：",
    "   多 agent 之后这条命令需要显式 owner，一调就报 `Multiple agents are configured`，",
    "   而通知其实早就由平台送达了 —— 你一报错，用户会以为通知断了。",
    "3. 建完把任务名、时间、下一次执行时间复述给他确认；他说要改，就用 `list` 拿到 id 再 `update`。",
    "4. `list` 每条任务带 `origin`，先看它再决定怎么改：",
    "   - `PLATFORM`：平台库任务，平台调度器执行、有运行记录 —— 用上面的 `update`/`delete`/`run` 改。",
    "   - `GATEWAY`：**只在网关 cron 里**的任务（历史遗留，网关自己执行）。平台的 `update`/`delete` 改不动它，",
    "     要改得用 `openclaw cron update <gatewayJobId>`、删用 `openclaw cron remove <gatewayJobId>`。",
    "   新建任务**一律用上面的 create**，不要再用 `openclaw cron add`：那样建的任务平台调度器不认，",
    "   执行结果不落库、微信通知也走不到平台这条链路，用户只能看到一个「野」任务。",
    "5. 同一个名字出现两条、其中一条是「已暂停」，通常是删了重建留下的旧任务 —— 提醒用户可以清掉，",
    "   否则哪天误启用会重复执行。",
    "",
    "### 停止正在运行的任务（含视频生成等后台任务）",
    "",
    "当用户说「停一下」「别生成了」「把刚才那个视频取消掉」，或你自己判断需要中止当前会话里",
    "正在跑的 run / 后台子任务时，调这个接口中止（等价于前端那个「停止」按钮，但你能主动调）：",
    "",
    `\`POST ${PLATFORM_BASE_URL}/api/openclaw/task/stop/agent\``,
    "",
    "鉴权和上面定时任务一样：`-H \"Authorization: Bearer $TOKEN\"`，body 里**必须**带归属账号",
    `（userId: ${uid}，或 sessionKey / phone）。`,
    "",
    "| 想做什么 | body |",
    "| --- | --- |",
    `| 停掉「我当前会话」正在跑的任务 | \`{"userId":${uid},"conversationId":"<会话id>"}\` |`,
    `| 停掉我指定的某个会话 | \`{"userId":${uid},"sessionKey":"agent:u-${userId}:c<会话id>"}\` |`,
    `| 精确取消某个 run（如视频渲染子任务） | \`{"userId":${uid},"sessionKey":"<后台任务的sessionKey>","runId":"<runId>"}\` |`,
    "",
    "**注意：**",
    "",
    "1. `sessionKey` 必须以 `agent:u-" + userId + ":` 开头 —— 你只能停**自己这位用户**的任务，",
    "   平台会直接拒绝跨用户的停止请求（403）。",
    "2. 不传 `sessionKey` 也不传 `conversationId` 时无法定位要停的会话，接口会返回 stopped:false，",
    "   所以至少给一个；最常用的是「带 userId + 当前 conversationId」。",
    `3. 返回 \`{"stopped":true}\` 表示已向网关发出中止信号；返回 \`{"stopped":false}\` 多半是任务已经跑完了，`,
    "   不是失败，不用重试。",
    "",
    "### 出视频：只给选题，写片交给平台（**首选，别自己调 om**）",
    "",
    `\`POST ${PLATFORM_BASE_URL}/api/video/from-topic\``,
    "",
    "| 想做什么 | body |",
    "| --- | --- |",
    `| 把选定的选题做成视频 | \`{"userId":${uid},"topic":"标题\\n要点1；要点2","title":"标题","targetSeconds":30}\` |`,
    `| 带产品网站素材 | 同上再加 \`"siteUrl":"https://..."\` |`,
    `| 带参考图（本地文件） | 同上再加 \`"images":["C:/Users/.../workspace/ocr/frame-01.png"]\` |`,
    `| 参考图只给文件名 | 再加 \`"imageDir":"C:/Users/.../workspace/ocr"\`，images 里写 \`["frame-01.png"]\` |`,
    "",
    "**参考图怎么传（三种形态任选，最多 6 张，jpg/png/webp，单张 ≤30MB）：**",
    "",
    "1. 远程地址：`https://example.com/a.png`",
    "2. 平台站内路径：`/uploads/xxx.png`（内容库里的图直接抄 imageUrl）",
    "3. **本地磁盘绝对路径**：`C:/Users/zengr/.openclaw/workspaces/u-xxx/ocr/a.png`",
    "   —— 你自己截图、OCR 出来的图走这条。只允许三个目录：平台 public、huashu-motion 仓库、",
    "   OpenClaw `workspace` 与 `workspaces`（也就是你的工作区，一定在白名单里）；",
    "   传别处的路径会被拒（防读系统文件），报错里会写清楚。",
    "   同一个目录下多张图，可以只写文件名 + `imageDir`，省得每张都写全路径。",
    "",
    "**为什么必须用这个接口、不要自己写分镜再跑 om：**",
    "平台这条流水线用代码写死的导演 prompt（先读 SKILL.md / director.md / rhythm.md，再定方向、搭节奏），",
    "渲染参数统一、入库自动、Studio 标记自动带。实测同一台机器上：平台出的片子 index.html 81KB、",
    "60 处音效、有 treatment.md；agent 自己读规范再转述给 DSH 只有 23KB、0 处音效、没有设计文档。",
    "差距不在模型，在「谁写这段 prompt」—— 你转述必然丢细节。",
    "",
    "**怎么用：**",
    "",
    "1. `topic` 只放「讲什么」：第一行是标题，后面是要点。**不要自己写分镜、不要写镜头时长**，",
    "   方向和分镜由 DSH 读导演手册自己定，你写了反而限制它。",
    "2. 接口是**异步**的：立刻返回 `{status:\"RUNNING\", message, conversationId}`，把 `message` 原样回给用户即可。",
    "3. 出片 5~15 分钟。做好后**平台直接推微信**给用户（带视频链接），不用你再发一遍，也不要去轮询。",
    "4. 失败也会推一条说明给用户，你不用盯着，也不用重试。",
    "5. 用了这个接口就**不要**再调 `/api/content/ingest/video` 入库 —— 已经自动入库了。",
    "",
    "### 保存视频到内容库（你已经出好片了）",
    "",
    "当你自己用 huashu-motion / ffmpeg 等做出了一支 MP4，想让它出现在平台「内容库」里给用户看、",
    "能播放、能改片、能发布时，调这个接口。**这里只保存成片，不会重新生成视频**。",
    "",
    `\`POST ${PLATFORM_BASE_URL}/api/content/ingest/video\``,
    "",
    "鉴权同样是 `-H \"Authorization: Bearer $TOKEN\"`，请求里**必须**带归属账号",
    `（\`"userId": ${uid}\`，或 phone）。以下三种传法任选其一：`,
    "",
    "| 场景 | 怎么传 |",
    "| --- | --- |",
    "| 最通用：直接把文件传上来 | multipart `-F \"file=@/abs/path/out.mp4\"` |",
    `| 视频就在同机磁盘上 | JSON \`{"filePath":"/opt/huashu-motion/.../out.mp4"}\` |`,
    `| 平台已有 / 远程地址 | JSON \`{"videoUrl":"/videos/xxx.mp4"}\` 或 \`{"videoUrl":"https://.../a.mp4"}\` |`,
    "",
    "常用完整例子（multipart，推荐）：",
    "",
    "```bash",
    `curl -s -X POST ${PLATFORM_BASE_URL}/api/content/ingest/video \\`,
    `  -H \"Authorization: Bearer $TOKEN\" \\`,
    `  -F \"userId=${userId}\" \\`,
    `  -F \"file=@/abs/path/to/video.mp4\" \\`,
    `  -F \"title=今日 AI 热点速览\" \\`,
    `  -F \"body=视频脚本 / 配文，可留空\"`,
    "```",
    "",
    "可选字段：`category`（默认「视频」）、`coverImageUrl`（不传则自动从成片抽一帧）、",
    "`contentId`（传给已有内容条目，把成片挂上去而不是新建一条）。",
    "",
    "**注意：**",
    "",
    "1. 只支持 mp4 / mov / webm / m4v，单个 ≤100MB。`filePath` 只认平台 public、huashu-motion 仓库、",
    "   你的 workspace 目录（要加别的目录让管理员设 `AGENT_VIDEO_IMPORT_DIRS`）。",
    "2. 返回的 `videoUrl` 是站内路径（如 `/videos/agent-xxx.mp4`），回给用户时**拼上平台域名**再发；",
    "   别把服务器本地绝对路径发给他，那是打不开的。",
    "3. 同一天同一账号重复保存同一支片子会复用已有条目（`reused:true`），不会灌出重复内容。",
    `4. **别用 \`/api/content/ingest\` 存视频**：那边要求正文 ≥200 字，还会另起一支新片。`,
    "",
    "### 这支片子是 DSH 调 huashu-motion 出的 → 存成「可去 Studio 修改」",
    "",
    "如果你是用 DSH 驱动 huashu-motion（`om new` 建项目 → DSH 写片 → `om render` 出片）做的视频，",
    "**保存时务必带上生产这支片子的项目根目录（projectDir）**，这样用户能在内容库里点「去 Studio 修改」继续改片、",
    "平台后台会自动接单改片并出新版。只传视频文件不带这些字段 = 一支普通视频，改不了。",
    "",
    "在原来的请求里多加两个字段（multipart 用 `-F`，JSON 直接写）：",
    "",
    "| 字段 | 说明 |",
    "| --- | --- |",
    "| `projectDir` | **必填**，`om new` 建出来的**项目根目录绝对路径**（含 `.om/` 和 `index.html`），不是 out 目录。**只要传了它，平台就自动按 Studio 模式处理** |",
    "| `studio` | 可选，显式写 `true` 也行（等价于传了 projectDir）；漏传不会失效 |",
    "| `token` | 可选；不传平台自动生成一个。只能用字母/数字/连字符 |",
    "| `productName` / `siteUrl` / `targetSeconds` / `duration` | 可选，项目元数据 |",
    "| `copyProject` | 可选，默认 `false`；设 `true` 会把项目目录复制进平台托管目录（项目在临时目录、可能被清理时用） |",
    "",
    "JSON 完整例子（`filePath` 指向 out 里的成片）：",
    "",
    "```bash",
    `curl -s -X POST ${PLATFORM_BASE_URL}/api/content/ingest/video \\`,
    `  -H \"Authorization: Bearer $TOKEN\" -H \"Content-Type: application/json\" \\`,
    `  -d '{\"userId\":\"${userId}\",`,
    `      \"projectDir\":\"/opt/huashu-motion/workspace/my-video\",`,
    `      \"filePath\":\"/opt/huashu-motion/workspace/my-video/out/final.mp4\",`,
    `      \"title\":\"今日 AI 热点速览\",\"targetSeconds\":20}'`,
    "```",
    "",
    "保存成功后返回的 `studio` 里有 `token` / `projectDir` / `version` / `studioPath`。",
    "**成片必须叫 `/videos/huashu-<token>-v1.mp4` 这种名字**，平台会自动按这个规范落盘 ——",
    "前端就是靠 URL 里的 `huashu-<token>-vN.mp4` 认出「这支片子能进 Studio」的，",
    "所以别自己改文件名，也别事后用别的接口把它改名。",
    "",
    "注意：studio 模式成片必须是 `.mp4`；`projectDir` 必须在允许目录内",
    "（huashu-motion 仓库、OpenClaw workspace、平台 public，或让管理员加 `AGENT_VIDEO_IMPORT_DIRS`）。",
    "",
    ""
  ].join("\n");
}

/** 该章节的定位标题：换了它会让幂等判断失效，改文案别改这行。 */
const PLATFORM_API_HEADING = "## 🔌 平台接口";

/**
 * 写入/更新 AGENTS.md 的「平台接口」章节（幂等）。
 *
 * 已存在 → 替换到下一个二级标题为止（文案更新能自动生效）；
 * 不存在 → 插到「## First Run」之前（那是 bootstrap 的收尾段，插在后面等于被淹没）。
 */
function upsertPlatformApiSection(file: string, userId: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  // 反斜杠在 bash 里是转义符，`cat D:\...` 会被吃掉，一律转成正斜杠再写进文档。
  const section = buildPlatformApiSection(userId, agentTokenFilePath().replace(/\\/g, "/"));
  const at = text.indexOf(PLATFORM_API_HEADING);

  let next: string;
  if (at >= 0) {
    const afterHeading = at + PLATFORM_API_HEADING.length;
    const rest = text.slice(afterHeading);
    const nextHeading = rest.search(/\r?\n## /);
    const end = nextHeading >= 0 ? afterHeading + nextHeading + 1 : text.length;
    next = text.slice(0, at) + section + text.slice(end);
  } else {
    const anchor = text.indexOf("## First Run");
    next =
      anchor >= 0
        ? text.slice(0, anchor) + section + text.slice(anchor)
        : `${text.trimEnd()}\n\n${section}`;
  }

  if (next === text) return;
  try {
    // 原子覆盖：网关随时可能读这个文件。
    const tmp = `${file}.tmp-platform-api`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    console.warn("[user-agent] 写入平台接口章节失败：", (error as Error).message);
  }
}

/**
 * 每进程每 workspace 只补一次。
 *
 * 补这节要读一次 9K 的文件，聊天是热路径，不能每轮都做；
 * 但也不能只在「首次装配」时做 —— 老用户的 workspace 早就存在，
 * 只会在下次交互时补上，所以要绕过 knownAgents 的快速返回。
 */
const platformSectionSynced = new Set<string>();

function ensurePlatformSection(workspace: string, userId: string): void {
  const key = `${workspace}::${userId}`;
  if (platformSectionSynced.has(key)) return;
  upsertPlatformApiSection(path.join(workspace, "AGENTS.md"), userId);
  platformSectionSynced.add(key);
}

/**
 * 用 `next` 替换 [startMark, endMark) 区间。startMark 与 endMark 都支持多个候选，
 * 便于在「已替换过 / 未替换过」两种文档状态下都能定位。
 */
function replaceSection(
  text: string,
  startMarks: string[],
  endMarks: string[],
  next: string
): string | null {
  let start = -1;
  for (const m of startMarks) {
    const i = text.indexOf(m);
    if (i >= 0) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = -1;
  for (const m of endMarks) {
    const j = text.indexOf(m, start + 1);
    if (j > start && (end < 0 || j < end)) end = j;
  }
  if (end < 0) return null;
  return text.slice(0, start) + next + text.slice(end);
}

/** 把复制来的 main 版 AGENTS.md 改写成「单用户专属 agent」版（幂等）。 */
function personalizeAgentsMd(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const original = text;

  // 1) 服务边界：main 是兜底版（陌生外部通道只回一句「去平台网页端」），专属 agent 必须换掉。
  //    这里**不按「是否已替换过」跳过**：文案更新也要能推到已有的 10 多个 workspace，
  //    替换本身是幂等的，每次都算出同样的文本，写盘前还有 `text === original` 拦一层。
  text =
    replaceSection(
      text,
      [BOUNDARY_SECTION_START, BOUNDARY_SECTION_LEGACY],
      [BOUNDARY_SECTION_END],
      OWN_BOUNDARY_SECTION
    ) ?? text;

  // 2) 心跳章节：先删（它正好夹在「服务边界」与「多账号工作区」之间）
  if (text.includes(HEARTBEAT_SECTION_START)) {
    text =
      replaceSection(
        text,
        [HEARTBEAT_SECTION_START],
        [PRODUCT_SECTION_LEGACY, "## 产品归属", "## Make It Yours"],
        ""
      ) ?? text;
  }

  // 3) 多账号段落 → 中性版产品归属（原文点名了其他用户的账号与产品）
  if (text.includes(PRODUCT_SECTION_LEGACY)) {
    text =
      replaceSection(text, [PRODUCT_SECTION_LEGACY], ["## Make It Yours"], OWN_PRODUCT_SECTION) ?? text;
  }

  // 4) MEMORY.md 加载限制（两处：startup 清单里一行 + Memory 章节 4 条）
  if (text.includes(MEMORY_LIMIT_OLD)) {
    text = text.replace(MEMORY_LIMIT_OLD, MEMORY_LIMIT_NEW);
  }
  if (text.includes(MEMORY_RULE_START)) {
    text = replaceSection(text, [MEMORY_RULE_START], [MEMORY_RULE_END], OWN_MEMORY_RULE) ?? text;
  }

  if (text === original) return;
  try {
    // 原子覆盖：网关随时可能读这个文件，不能让它读到半个。
    const tmp = `${file}.tmp-personalize`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    console.warn("[user-agent] 改写 AGENTS.md 失败：", (error as Error).message);
  }
}

/**
 * TOOLS.md 里的「内容库」段只保留**平台注入块里没有的**稳定约定。
 *
 * 原本这里抄了一整套平台接口说明（令牌位置、三个 API 的请求体、phone 归属、渠道释义），
 * 这些每轮都由 `platform-auth-context.ts` 按当前用户的授权状态注入，属于重复：
 * 既白占 prompt，又容易和注入块说法不一致（尤其归属账号，写死就会串用户）。
 */
const TOOLS_LIBRARY_SECTION = `## AIWorker 内容库（稿件约定）

入库 / 发布 / 撤回 / 查询都用 \`C:\\Users\\zengr\\.openclaw\\workspace\\content-library\\\` 下的现成脚本
（\`ingest.mjs\` / \`publish.mjs\` / \`unpublish.mjs\` / \`list.mjs\`）。**具体命令、可用渠道、归属参数
以平台每轮注入的「平台授权」块为准，照着执行即可；不要自己写脚本，也不要自己拼 curl。**

- 稿件落盘约定：\`content-library/<YYYY-MM-DD>/NN-平台-方向-短标题.md\`，文件第一行必须是 \`# 标题\`。
- 文章不在约定目录也能入库：\`ingest.mjs "<文件.md>"\` 或 \`ingest.mjs --dir="<目录>"\`；
  加 \`--no-publish\` 只入库不发布，加 \`--category=小红书|公众号文章|头条号|视频\` 指定分类。
- 入库校验：单次最多 20 条；正文少于 200 字会被跳过；同一天 + 同账号 + 同标题去重跳过。
- 脚本连不上 \`${PLATFORM_BASE_URL}\` 时会提示「请先启动 AIWorker 平台」——平台没启动时入库和发布都无法完成。

`;

/** 旧版整段（含接口表 / 令牌位置 / 账号说明）——识别到就整段换成上面的精简版。 */
const TOOLS_LIBRARY_LEGACY = /## AIWorker（创星云 AI 数字员工平台）内容库[\s\S]*?(?=\n## Related)/;

/** 把复制来的 TOOLS.md 里的运营者姓名/账号示例清掉，并把内容库段收成精简版（幂等）。 */
function personalizeToolsMd(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const before = text;
  if (TOOLS_LIBRARY_LEGACY.test(text)) text = text.replace(TOOLS_LIBRARY_LEGACY, TOOLS_LIBRARY_SECTION);
  // 兜底：模板其他位置可能还写着运营者名字
  text = text.replace(/向大彬索要/g, "向当前用户索要");
  if (text === before) return;
  try {
    const tmp = `${file}.tmp-tools`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    console.warn("[user-agent] 改写 TOOLS.md 失败：", (error as Error).message);
  }
}

function seedWorkspace(
  workspace: string,
  mainWorkspace: string,
  account: string,
  userId: string
): void {
  mkdirSync(workspace, { recursive: true });
  mkdirSync(path.join(workspace, "memory"), { recursive: true });

  for (const name of SHARED_BOOTSTRAP) {
    const src = path.join(mainWorkspace, name);
    const dst = path.join(workspace, name);
    if (!existsSync(src) || existsSync(dst)) continue;
    try {
      copyFileSync(src, dst);
    } catch (error) {
      console.warn(`[user-agent] 复制引导文件 ${name} 失败：`, (error as Error).message);
    }
  }

  // 复制来的 AGENTS.md 是 main（兜底）版本，必须改成专属版。
  // 放在「仅当文件不存在才复制」之后，所以对已存在的 workspace 也会做一次幂等修正。
  personalizeAgentsMd(path.join(workspace, "AGENTS.md"));
  personalizeToolsMd(path.join(workspace, "TOOLS.md"));
  // 平台接口（定时任务）章节：微信入站不经过平台路由，只能靠这份文件把端点讲清楚。
  ensurePlatformSection(workspace, userId);

  const userMd = path.join(workspace, "USER.md");
  if (!existsSync(userMd)) {
    writeFileSync(userMd, USER_MD_TEMPLATE.replace(/\{account\}/g, account), "utf8");
  }
  const memoryMd = path.join(workspace, "MEMORY.md");
  if (!existsSync(memoryMd)) {
    writeFileSync(memoryMd, MEMORY_MD_TEMPLATE.replace(/\{account\}/g, account), "utf8");
  }
}

// 进程内缓存：聊天是热路径，不能每轮都读一次配置文件。
// 只缓存「已确认装配完成」的 id → workspace。外部脚本重写配置只会新增条目、
// 不会删，所以缓存不会把用户带到一个已失效的 agent 上。
const knownAgents = new Map<string, string>();

// 配置写入串行化：并发注册会同时读-改-写同一个 JSON，不排队必然丢条目。
let writeQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => T): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

export type EnsureUserAgentResult = {
  agentId: string;
  workspace: string;
  created: boolean;
  configChanged: boolean;
};

/**
 * 确保某个平台用户有专属 agent（幂等，可重复调用）。
 *
 * @param userId 平台用户 id
 * @param phone  手机号，仅用于 USER.md 的可读标识；聊天兜底时可缺省
 */
export async function ensureUserAgent(input: {
  userId: string;
  phone?: string | null;
}): Promise<EnsureUserAgentResult> {
  const userId = (input.userId ?? "").trim();
  if (!userId) throw new Error("ensureUserAgent 缺少 userId");
  const agentId = userAgentId(userId);
  const configPath = resolveOpenClawConfigPath();
  const account = (input.phone ?? "").trim() || `平台用户 ${agentId}`;

  // 快速路径：已装配过，直接返回（绝大多数聊天回合走这里，零 IO）。
  const cachedWorkspace = knownAgents.get(agentId);
  if (cachedWorkspace) {
    // 老 workspace 也要补上「平台接口」章节（每进程每 workspace 只做一次，有 Set 挡着）。
    ensurePlatformSection(cachedWorkspace, userId);
    return { agentId, workspace: cachedWorkspace, created: false, configChanged: false };
  }

  return serialize(() => {
    let cfg: OpenClawConfig;
    try {
      cfg = readConfig(configPath);
    } catch (error) {
      throw new Error(
        `无法读取 OpenClaw 配置（${configPath}）：${(error as Error).message}`
      );
    }

    const entries = (cfg.agents ??= {}).entries ?? ((cfg.agents.entries = {}));
    const mainWorkspace = mainWorkspaceOf(cfg);
    const existing = entries[agentId];

    // workspace 路径：优先沿用配置里已有的（可能被手工挪过），否则按约定生成。
    const wsFromConfig =
      existing && typeof existing.workspace === "string" ? String(existing.workspace).trim() : "";
    const workspace = wsFromConfig || path.join(defaultWorkspacesRoot(), agentId);

    const workspaceExisted = existsSync(path.join(workspace, "MEMORY.md"));
    seedWorkspace(workspace, mainWorkspace, account, userId);

    let configChanged = false;
    if (!existing) {
      entries[agentId] = {
        name: account.startsWith("平台用户") ? account : `平台用户 ${account}`,
        workspace: workspace.replace(/\\/g, "/"),
        model: resolveInheritedModel(cfg),
        // 心跳按 agent 展开，一个用户一份；平台不依赖它，直接关掉。
        heartbeat: { every: "0m" }
      };
      configChanged = true;
    } else if (wsFromConfig !== workspace) {
      existing.workspace = workspace.replace(/\\/g, "/");
      configChanged = true;
    }

    if (configChanged) {
      writeConfigAtomic(configPath, cfg);
      console.log(`[user-agent] 已装配 ${agentId}（新增条目，workspace=${workspace}）`);
    }

    knownAgents.set(agentId, workspace);
    return {
      agentId,
      workspace,
      created: !workspaceExisted,
      configChanged
    };
  });
}

/** 快速判定（带缓存）：该用户的 agent 是否已装配过。 */
export function isUserAgentKnown(userId: string): boolean {
  return knownAgents.has(userAgentId(userId));
}

/**
 * 微信渠道入站消息的 agent 分流。
 *
 * 默认 `bindings` 只把 `openclaw-weixin` 整体绑到 `main`，于是所有微信用户
 * 的对话都由 main agent 处理 —— 会话历史按 openid 分开，但 workspace、
 * USER.md、MEMORY.md 是 main 的（也就是平台运营者本人的档案）。这是真实的
 * 跨用户记忆泄露路径。
 *
 * 每个用户绑定的 bot 账号互不相同（`WechatBinding.wechatOpenId` 去 `@im.bot`
 * 后缀即是），所以可以按 `accountId` 精确把每个 bot 的入站消息路由到该用户
 * 自己的 `u-<id>` agent。
 *
 * 🔴 **不保留 `accountId:"*"` → main 兜底**：`main` 就是平台运营者主账号
 * （138001）的私有 workspace，任何未显式映射到具体用户 agent 的 bot 一旦落回
 * `*`，消息就会进 138001 的记忆 —— 这是真实的跨账号泄露（2026-11-03 串号事故）。
 * 所以未绑定 / 已解绑 / 无本地凭据的 bot **没有路由**，消息不投递，这才是安全的
 * fail-safe。所有真正生效的绑定都由 `refreshWeixinAgentBindings` 显式建出映射。
 *
 * bindings 变更会和 channels.openclaw-weixin.channelConfigUpdatedAt 一起原子写入，
 * 由后者触发网关重建微信通道（几秒，只影响微信通道，不重启整个网关）；
 * 写入失败只记日志不影响调用方。
 */
export async function syncWeixinAgentBindings(
  mappings: Array<{ agentId: string; accountId: string }>
): Promise<{ changed: boolean; bindings: number }> {
  const configPath = resolveOpenClawConfigPath();
  const concrete = mappings
    .filter((m) => m.agentId && m.accountId)
    .map((m) => ({
      agentId: m.agentId,
      match: { channel: "openclaw-weixin", accountId: m.accountId }
    }));

  return serialize(() => {
    const cfg = readConfig(configPath);
    // 🔴 不追加 `accountId:"*"` → main 兜底：未显式映射到具体用户 agent 的 bot
    // 一律不作路由（fail-safe），杜绝已解绑 / 无凭据的 bot 静默落回 main（138001）
    // 造成跨账号记忆泄露。只有 refreshWeixinAgentBindings 依据 DB 里 status=BOUND
    // 且有本地凭据的 bot 才会进入 `concrete`。
    const next = [...concrete];
    const before = JSON.stringify(cfg.bindings ?? null);
    const after = JSON.stringify(next);
    if (before === after) return { changed: false, bindings: next.length };

    cfg.bindings = next;
    // 🔴 必须和 bindings 同一次写入里更新 channels.openclaw-weixin.channelConfigUpdatedAt。
    // 网关只把 bindings 当「动态读取」，不会因此重建微信通道；真正触发通道重启的是这个时间戳。
    // 不一起改的话，新绑定的 bot 会一直报
    // `AgentSelectionRequiredError: ... routing has no explicit owner`（微信显示正常、发消息不回），
    // 直到整机重启网关才恢复（2026-11-05 实测：新用户 13800138005 绑完即失联）。
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const weixin = (channels["openclaw-weixin"] ?? {}) as Record<string, unknown>;
    cfg.channels = {
      ...channels,
      "openclaw-weixin": { ...weixin, channelConfigUpdatedAt: new Date().toISOString() }
    };
    writeConfigAtomic(configPath, cfg);
    console.log(
      `[user-agent] 微信入站分流已更新：${concrete.length} 个 bot → 各自 agent（无 * 兜底，已触发通道重载）`
    );
    return { changed: true, bindings: next.length };
  });
}

/** 预热缓存（进程启动后从配置里载入已有条目，避免首轮全量读文件）。 */
export function primeKnownUserAgents(): number {
  try {
    const cfg = readConfig(resolveOpenClawConfigPath());
    const entries = cfg.agents?.entries ?? {};
    for (const [id, entry] of Object.entries(entries)) {
      if (!id.startsWith("u-")) continue;
      const ws = typeof entry?.workspace === "string" ? entry.workspace : "";
      if (ws.trim()) knownAgents.set(id, ws);
    }
  } catch {
    // 配置缺失/不可读时留空，等到 ensureUserAgent 时再报具体错误。
  }
  return knownAgents.size;
}
