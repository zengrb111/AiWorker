/**
 * 一次性存量迁移：把原先配置在平台公共环境里的模型服务与密钥，导入到指定用户名下。
 *
 * 用法（零项目依赖，只用 node 内置模块）：
 *   npx tsx scripts/migrate-global-model-config.mts --user=13800000000
 *   npx tsx scripts/migrate-global-model-config.mts --user=13800000000 --dry-run
 *
 * 数据源（**只读，绝不删除或改写**）：
 *   1) ~/.openclaw/openclaw.json 的 models.providers —— 只导入 baseUrl 与模型列表；
 *      它的 API Key 存在 OpenClaw agent 自己的 sqlite 凭证库里（格式未公开），
 *      强行解析风险高，因此改为在报告里提示手动补填。
 *   2) 项目 .env.local 的 DASHSCOPE_API_KEY / ZHIPU_API_KEY / DEEPSEEK_API_KEY /
 *      POLLINATIONS_API_KEY —— 这些密钥可读，按能力导入。
 *
 * 导入策略：一个 key 可以支撑多个服务（智谱 key 同时供对话/识图/配音，千问 key 同时供
 * 对话与配音），靠 apiFormat 区分；能力绑定写在每个 plan 的 capabilityBindings 里，
 * 报告会列出迁移后仍未绑定模型的能力，提示到系统配置手工补齐。
 *
 * 幂等：已存在同 (userId, providerId, label) 的服务会跳过。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 能力枚举与中文名就地复制一份：本脚本刻意只依赖 node 内置模块（不引 prisma client、
 * 不用路径别名），这样即使项目依赖没装好也能跑。改动时需与
 * src/lib/model-credentials.ts 的 CAPABILITY_LABELS 保持一致。
 */
const CAPABILITY_LABELS: Record<string, string> = {
  chat: "对话与写作",
  vision: "识图",
  ocr: "图片文字识别",
  tts: "配音",
  video: "文生视频",
  storyboard: "分镜规划",
  embedding: "向量化",
  search: "联网搜索"
};
const ALL_CAPABILITIES = Object.keys(CAPABILITY_LABELS);

type Row = Record<string, unknown>;

const PROJECT_ROOT = process.cwd();
const DB_PATH = path.join(PROJECT_ROOT, "prisma", "dev.db");
const KEY_FILE = path.join(PROJECT_ROOT, ".platform-cred.key");
const OPENCLAW_CONFIG = path.join(os.homedir(), ".openclaw", "openclaw.json");
const ENV_FILES = [".env.local", ".env"];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const userArg = args.find((a) => a.startsWith("--user="))?.slice("--user=".length)?.trim() ?? "";

type ImportPlan = {
  providerId: string;
  label: string;
  apiFormat: string;
  baseUrl: string;
  models: Array<{ id: string; name: string }>;
  /** 无法自动获得密钥时为 true，需要用户手动补填 */
  needManualKey: boolean;
  credential?: { apiKey: string; apiSecret?: string };
  /**
   * 导入后要自动指向的能力。一个服务可绑多项能力（如智谱 GLM 同时供对话与识图）；
   * 每项能力在库里只有一行（@@unique([userId, capability])），后绑的会覆盖先绑的，
   * 所以同一能力不要在多个 plan 里都写 bindings。
   */
  capabilityBindings?: Array<{ capability: string; model?: string }>;
  source: string;
};

const plans: ImportPlan[] = [];
const skipped: string[] = [];
const manual: string[] = [];

function log(line = "") {
  process.stdout.write(`${line}\n`);
}

function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1) OpenClaw 全局配置：只取 baseUrl 与模型列表（密钥取不到，标记为需手工补填）
// ---------------------------------------------------------------------------
function planFromOpenClawConfig(): void {
  if (!fs.existsSync(OPENCLAW_CONFIG)) {
    log(`  · 未找到 ${OPENCLAW_CONFIG}，跳过。`);
    return;
  }
  let parsed: { models?: { providers?: Record<string, Row> } };
  try {
    parsed = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, "utf8")) as typeof parsed;
  } catch (error) {
    log(`  · 解析失败（${error instanceof Error ? error.message : String(error)}），跳过。`);
    return;
  }
  const providers = parsed.models?.providers ?? {};
  const entries = Object.entries(providers);
  if (!entries.length) {
    log("  · models.providers 为空，跳过。");
    return;
  }
  for (const [providerId, provider] of entries) {
    const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
    const rawModels = Array.isArray(provider.models) ? (provider.models as Row[]) : [];
    const models = rawModels
      .map((m) => ({
        id: typeof m?.id === "string" ? m.id : "",
        name: typeof m?.name === "string" ? m.name : ""
      }))
      .filter((m) => m.id)
      .map((m) => ({ id: m.id, name: m.name || m.id }));
    if (!baseUrl) continue;
    plans.push({
      providerId,
      label: String(provider.label ?? providerId),
      apiFormat: "openai-completions",
      baseUrl,
      models: models.length > 0 ? models : [{ id: "default", name: "默认模型" }],
      needManualKey: true,
      source: OPENCLAW_CONFIG
    });
  }
}

// ---------------------------------------------------------------------------
// 2) .env.local 里的公共密钥：按能力导入
// ---------------------------------------------------------------------------
function planFromEnvFile(): void {
  const env: Record<string, string> = {};
  for (const file of ENV_FILES) {
    const filePath = path.join(PROJECT_ROOT, file);
    if (!fs.existsSync(filePath)) continue;
    Object.assign(env, readEnvFile(filePath));
    log(`  · 已读取 ${filePath}`);
  }

  const add = (plan: ImportPlan, envKey: string) => {
    const apiKey = (env[envKey] ?? "").trim();
    if (!apiKey) {
      manual.push(`${plan.label}（${envKey} 在 env 文件中为空）`);
      plan.needManualKey = true;
      return;
    }
    plan.credential = { apiKey };
    plans.push(plan);
  };

  // 智谱：对话与识图共用同一个 key（.env.local 里 VISION_MODEL=glm-4.6v）
  add(
    {
      providerId: "zhipu",
      label: "智谱 GLM（迁移自 env）",
      apiFormat: "openai-completions",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      models: [
        { id: "glm-4.6", name: "GLM-4.6" },
        { id: "glm-4.6v", name: "GLM-4.6V（识图）" },
        { id: "glm-4-flash", name: "GLM-4-Flash" }
      ],
      needManualKey: false,
      capabilityBindings: [
        { capability: "chat", model: "glm-4.6" },
        { capability: "vision", model: "glm-4.6v" }
      ],
      source: ".env.local"
    },
    "ZHIPU_API_KEY"
  );

  // 智谱配音：与上面共用 ZHIPU_API_KEY，apiFormat 不同因此不会撞唯一约束
  add(
    {
      providerId: "zhipu-tts",
      label: "智谱配音（迁移自 env）",
      apiFormat: "zhipu-tts",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      models: [{ id: "glm-tts", name: "GLM-TTS" }],
      needManualKey: false,
      source: ".env.local"
    },
    "ZHIPU_API_KEY"
  );

  // 千问：只导入服务，不自动绑能力（OCR / 向量化由用户在系统配置里按需指定）
  add(
    {
      providerId: "qwen",
      label: "通义千问（迁移自 env）",
      apiFormat: "openai-completions",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: [
        { id: "qwen-max", name: "Qwen Max" },
        { id: "qwen-plus", name: "Qwen Plus" }
      ],
      needManualKey: false,
      source: ".env.local"
    },
    "DASHSCOPE_API_KEY"
  );

  // 千问配音：与 .env.local 的 TTS_PROVIDER=qwen 现状一致，绑到 tts 能力
  add(
    {
      providerId: "qwen-tts",
      label: "千问配音（迁移自 env）",
      apiFormat: "dashscope-tts",
      baseUrl: "https://dashscope.aliyuncs.com",
      models: [{ id: "qwen3-tts-flash", name: "Qwen3-TTS-Flash" }],
      needManualKey: false,
      capabilityBindings: [{ capability: "tts", model: "qwen3-tts-flash" }],
      source: ".env.local"
    },
    "DASHSCOPE_API_KEY"
  );

  add(
    {
      providerId: "deepseek",
      label: "DeepSeek（迁移自 env）",
      apiFormat: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      models: [
        { id: "deepseek-chat", name: "DeepSeek Chat" },
        { id: "deepseek-reasoner", name: "DeepSeek Reasoner" }
      ],
      needManualKey: false,
      capabilityBindings: [{ capability: "storyboard", model: "deepseek-chat" }],
      source: ".env.local"
    },
    "DEEPSEEK_API_KEY"
  );

  add(
    {
      providerId: "pollinations",
      label: "Pollinations 文生视频（迁移自 env）",
      apiFormat: "pollinations-video",
      baseUrl: "https://gen.pollinations.ai",
      models: [{ id: "wan-fast", name: "Wan Fast" }],
      needManualKey: false,
      capabilityBindings: [{ capability: "video", model: "wan-fast" }],
      source: ".env.local"
    },
    "POLLINATIONS_API_KEY"
  );
}

// ---------------------------------------------------------------------------
// 加密：与 src/lib/platform-creds.ts 完全一致（AES-256-GCM，密钥文件 .platform-cred.key）
// ---------------------------------------------------------------------------
function loadKey(): Buffer {
  let hex = "";
  try {
    hex = fs.readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    hex = "";
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    hex = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(KEY_FILE, hex, { mode: 0o600 });
    log(`  · 未找到可用的 ${KEY_FILE}，已生成新的 256 位密钥。`);
  }
  return Buffer.from(hex, "hex");
}

function encryptCredential(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

function cuid(prefix: string): string {
  return `${prefix}${crypto.randomBytes(12).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  log("=== 存量模型配置迁移（导入到指定用户名下，源文件只读） ===");
  log(`数据库：${DB_PATH}`);
  log(`密钥文件：${KEY_FILE}`);
  log(`OpenClaw 全局配置：${OPENCLAW_CONFIG}`);
  log("");

  if (!fs.existsSync(DB_PATH)) {
    log(`✗ 找不到数据库 ${DB_PATH}，请先在项目根执行 prisma db push。`);
    process.exitCode = 1;
    return;
  }
  const db = new DatabaseSync(DB_PATH);

  // 目标用户：--user 指定（手机号 / 登录标识），缺省取第一个用户
  const userCols = db.prepare("PRAGMA table_info(User)").all() as Row[];
  const phoneCol = userCols.find((c) => c.name === "phone") ?? userCols.find((c) => c.name === "username");
  const phoneField = phoneCol?.name ?? "id";
  if (!userCols.some((c) => c.name === "id")) {
    log("✗ User 表结构异常（缺少 id 列）。");
    process.exitCode = 1;
    return;
  }

  let userRow: Row | undefined;
  if (userArg) {
    userRow = db
      .prepare(`SELECT id, ${phoneField} AS ident FROM User WHERE ${phoneField} = ?`)
      .get(userArg) as Row | undefined;
    if (!userRow) {
      log(`✗ 找不到用户 ${userArg}（按 ${phoneField} 匹配）。`);
      process.exitCode = 1;
      return;
    }
  } else {
    userRow = db
      .prepare(`SELECT id, ${phoneField} AS ident FROM User ORDER BY createdAt ASC LIMIT 1`)
      .get() as Row | undefined;
    if (!userRow) {
      log("✗ 数据库里没有任何用户，请先注册一个用户。");
      process.exitCode = 1;
      return;
    }
    log(`⚠ 未指定 --user，按创建时间取第一个用户：${String(userRow.ident)}`);
  }
  const userId = String(userRow.id);
  log(`目标用户：${String(userRow.ident)}（id=${userId}）`);
  log("");

  log("[1/3] 扫描源配置…");
  planFromOpenClawConfig();
  planFromEnvFile();
  log("");

  log("[2/3] 逐项导入…");
  const key = loadKey();
  const existsStmt = db.prepare(
    "SELECT id FROM UserModelProvider WHERE userId = ? AND providerId = ? AND label = ?"
  );
  const insertProvider = db.prepare(
    `INSERT INTO UserModelProvider
       (id, userId, providerId, label, apiFormat, baseUrl, credentialEnc, modelsJson, status, statusMsg, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'untested', '', ?, ?)`
  );
  const findAssignment = db.prepare(
    "SELECT id FROM UserModelAssignment WHERE userId = ? AND capability = ?"
  );
  const upsertAssignment = db.prepare(
    `INSERT INTO UserModelAssignment (id, userId, capability, providerRowId, model, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(userId, capability) DO UPDATE SET providerRowId = excluded.providerRowId, model = excluded.model, updatedAt = excluded.updatedAt`
  );

  const now = new Date().toISOString();
  for (const plan of plans) {
    if (existsStmt.get(userId, plan.providerId, plan.label)) {
      skipped.push(`${plan.label}（已存在）`);
      log(`  · 跳过：${plan.label}`);
      continue;
    }
    if (plan.needManualKey || !plan.credential) {
      manual.push(`${plan.label}（${plan.source} 无法自动取得密钥）`);
      log(`  ? 待手工补填：${plan.label} ← ${plan.source}`);
      continue;
    }
    const rowId = cuid("ump_");
    const credentialEnc = encryptCredential(
      JSON.stringify({ apiKey: plan.credential.apiKey, apiSecret: plan.credential.apiSecret ?? "" }),
      key
    );
    const modelsJson = JSON.stringify(plan.models);
    if (dryRun) {
      const bindHint = (plan.capabilityBindings ?? [])
        .map((b) => `${b.capability}=${b.model ?? plan.models[0]?.id ?? "?"}`)
        .join(", ");
      log(
        `  ~ [dry-run] 将插入 ${plan.label}（${plan.models.length} 个模型）` +
          (bindHint ? `，并绑定能力 ${bindHint}` : "，不绑定能力")
      );
      continue;
    }
    insertProvider.run(
      rowId,
      userId,
      plan.providerId,
      plan.label,
      plan.apiFormat,
      plan.baseUrl,
      credentialEnc,
      modelsJson,
      now,
      now
    );
    log(`  ✓ 已导入：${plan.label}（${plan.models.length} 个模型，密钥来自 ${plan.source}）`);

    for (const binding of plan.capabilityBindings ?? []) {
      const model = binding.model ?? plan.models[0]?.id ?? "";
      if (!model) continue;
      const existed = Boolean(findAssignment.get(userId, binding.capability));
      upsertAssignment.run(cuid("uma_"), userId, binding.capability, rowId, model, now, now);
      log(`    ${existed ? "↻" : "→"} 已把「${binding.capability}」能力指向该服务（${model}）`);
    }
  }
  log("");

  log("[3/3] 迁移报告");
  log("  导入来源文件（均未被修改）：");
  log(`    - ${OPENCLAW_CONFIG}`);
  for (const file of ENV_FILES) log(`    - ${path.join(PROJECT_ROOT, file)}`);
  log(`  可自动导入：${plans.filter((p) => !p.needManualKey && p.credential).length} 项`);
  if (skipped.length) log(`  已跳过：${skipped.join("；")}`);
  if (manual.length) {
    log("  待手工补填（请到「系统配置 → 模型配置」添加并填写密钥）：");
    for (const item of manual) log(`    - ${item}`);
  }

  // 迁移完成后核对哪些能力还没有指向任何服务 —— 这些能力使用时会在界面上明确提示。
  const bound = new Set<string>();
  for (const plan of plans) {
    if (plan.needManualKey || !plan.credential) continue;
    for (const binding of plan.capabilityBindings ?? []) bound.add(binding.capability);
  }
  const unbound = ALL_CAPABILITIES.filter((c) => !bound.has(c));
  if (unbound.length > 0) {
    log("  迁移后仍未绑定模型的能力（使用时会提示去系统配置）：");
    for (const capability of unbound) log(`    - ${CAPABILITY_LABELS[capability]}`);
  }

  log("");
  log(
    dryRun
      ? "dry-run 结束，未写入任何数据。"
      : "迁移完成。到「系统配置」逐项点「测试连接」核对后再投入使用。"
  );

  db.close();
}

main();
