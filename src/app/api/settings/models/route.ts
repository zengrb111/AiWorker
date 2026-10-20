import { jsonError, jsonOk, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import {
  ALL_CAPABILITIES,
  API_FORMAT_LABELS,
  CAPABILITY_HINTS,
  CAPABILITY_LABELS,
  encodeCredential,
  invalidateUserCache,
  maskSecret,
  decryptProviderCredential,
  type ApiFormat,
  type Capability
} from "@/lib/model-credentials";
import { findPreset } from "@/lib/model-presets";
import { syncModelKeyToOpenClaw, syncOpenClawChatModel } from "@/lib/openclaw-settings-sync";

/**
 * /api/settings/models —— 当前登录用户的模型服务（GET 列表 / POST 保存）。
 *
 * 隔离红线：所有查询强制带 userId 条件；密钥加密存储，列表只回显掩码；
 * 写入后立即失效该用户的凭据缓存。
 */

export type ProviderModel = { id: string; name: string };

type ProviderBody = {
  id?: string;
  providerId?: string;
  label?: string;
  apiFormat?: string;
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  models?: ProviderModel[];
};

function parseModels(raw: unknown): ProviderModel[] {
  if (!Array.isArray(raw)) return [];
  const list = raw
    .map((item) => {
      if (typeof item === "string") return { id: item.trim(), name: item.trim() };
      const model = item as ProviderModel;
      const id = typeof model?.id === "string" ? model.id.trim() : "";
      if (!id) return null;
      return { id, name: (typeof model.name === "string" && model.name.trim()) || id };
    })
    .filter((item): item is ProviderModel => Boolean(item));
  // 去重（同一个模型 id 只保留第一条）
  return list.filter((item, index) => list.findIndex((m) => m.id === item.id) === index);
}

function isApiFormat(value: string): value is ApiFormat {
  return value in API_FORMAT_LABELS;
}

/** GET —— 列出当前用户的全部模型服务 + 8 项能力的当前分配。 */
export async function GET() {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  try {
    const [providers, assignments] = await Promise.all([
      prisma.userModelProvider.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" }
      }),
      prisma.userModelAssignment.findMany({ where: { userId: user.id } })
    ]);

    const usedBy = new Map<string, Capability[]>();
    for (const row of assignments) {
      const list = usedBy.get(row.providerRowId) ?? [];
      list.push(row.capability as Capability);
      usedBy.set(row.providerRowId, list);
    }

    const items = providers.map((provider) => {
      const credential = decryptProviderCredential(provider.credentialEnc);
      return {
        id: provider.id,
        providerId: provider.providerId,
        label: provider.label,
        apiFormat: provider.apiFormat,
        apiFormatLabel: API_FORMAT_LABELS[provider.apiFormat as ApiFormat] ?? provider.apiFormat,
        baseUrl: provider.baseUrl,
        apiKeyMasked: maskSecret(credential?.apiKey),
        hasApiSecret: Boolean(credential?.apiSecret),
        models: parseModels(JSON.parse(provider.modelsJson || "[]")),
        status: provider.status,
        statusMsg: provider.statusMsg,
        lastVerifyAt: provider.lastVerifyAt ? provider.lastVerifyAt.toISOString() : null,
        usedBy: usedBy.get(provider.id) ?? [],
        createdAt: provider.createdAt.toISOString()
      };
    });

    const assignmentMap = new Map(assignments.map((row) => [row.capability as Capability, row]));
    const capabilities = ALL_CAPABILITIES.map((capability) => {
      const row = assignmentMap.get(capability);
      const provider = row ? providers.find((p) => p.id === row.providerRowId) : undefined;
      return {
        capability,
        label: CAPABILITY_LABELS[capability],
        hint: CAPABILITY_HINTS[capability],
        providerRowId: provider?.id ?? null,
        providerLabel: provider?.label ?? null,
        model: provider ? row?.model ?? null : null
      };
    });

    return jsonOk({ items, capabilities });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "读取模型配置失败。", 500);
  }
}

/** POST —— 新增或更新一个模型服务（apiKey 留空表示不修改）。 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return jsonError("未登录。", 401);

  const body = await readJson<ProviderBody>(request);
  const providerId = (body.providerId ?? "").trim();
  if (!providerId) return jsonError("请选择模型供应商。");

  const preset = findPreset(providerId);
  const apiFormatRaw = (body.apiFormat ?? "openai-completions").trim();
  if (!isApiFormat(apiFormatRaw)) return jsonError("不支持的接口形态。");
  const apiFormat = apiFormatRaw;

  const label = (body.label ?? preset?.label ?? providerId).trim();
  const baseUrl = (body.baseUrl ?? preset?.baseUrl ?? "").trim();
  if (!baseUrl) return jsonError("请填写接口地址。");

  const models = parseModels(body.models);
  if (models.length === 0) return jsonError("请至少填写一个模型 id。");

  const apiKey = (body.apiKey ?? "").trim();
  const apiSecret = (body.apiSecret ?? "").trim();
  const isSearchProvider = apiFormat === "tavily-search" || apiFormat === "bocha-search";

  // 编辑既有服务时按 id 定位（并强制校验归属），新增时按 (providerId, label) 唯一键。
  const existing = body.id
    ? await prisma.userModelProvider.findFirst({ where: { id: body.id, userId: user.id } })
    : await prisma.userModelProvider.findFirst({
        where: { userId: user.id, providerId, label }
      });

  if (!apiKey && !existing) return jsonError("请填写 API Key。");
  if (apiFormat === "bocha-search" && !apiSecret && !existing) {
    return jsonError("博查联网搜索需要同时填写 Access-Key 与 Secret-Key。");
  }

  const status = "untested";
  const statusMsg = "";
  const lastVerifyAt = null;
  const modelsJson = JSON.stringify(models);
  const credentialEnc =
    apiKey || apiSecret
      ? encodeCredential({
          apiKey: apiKey || "",
          apiSecret: apiSecret || undefined
        })
      : existing!.credentialEnc;

  if (!credentialEnc) return jsonError("请填写 API Key。");

  const saved = existing
    ? await prisma.userModelProvider.update({
        where: { id: existing.id },
        data: { baseUrl, apiFormat, modelsJson, credentialEnc, status, statusMsg, lastVerifyAt }
      })
    : await prisma.userModelProvider.create({
        data: {
          userId: user.id,
          providerId,
          label,
          apiFormat,
          baseUrl,
          modelsJson,
          credentialEnc,
          status,
          statusMsg
        }
      });

  invalidateUserCache(user.id);

  // ---- OpenClaw 同步（v3：只同步主对话模型）----
  //
  // 会话改走 OpenClaw 后，「主对话模型」的权威来源是 OpenClaw 自己。
  // 用户在平台保存模型服务时，若该服务正被分配为 chat 能力，就把 key 也交给
  // OpenClaw；否则不碰 —— 识图/TTS/搜索/向量等能力由平台直连消费，
  // 写过去只会造成两份无用配置。
  //
  // 失败不阻断保存：Prisma 已是平台侧事实来源，OpenClaw 同步失败只提示，
  // 用户可以之后重试或手动在 OpenClaw 侧配置。
  let openclawSync: { ok: boolean; reason?: string } | undefined;
  if (!isSearchProvider) {
    const chatAssignment = await prisma.userModelAssignment.findFirst({
      where: { userId: user.id, capability: "chat", providerRowId: saved.id }
    });
    if (chatAssignment) {
      const profileId = `${saved.providerId}:manual`;
      // 只有真的填了新 key 才同步；编辑时留空 apiKey 表示不修改，
      // 此时 OpenClaw 侧的 key 也无需更新。
      if (apiKey) {
        const credential = decryptProviderCredential(saved.credentialEnc);
        const outcome = await syncModelKeyToOpenClaw({
          provider: saved.providerId,
          apiKey: credential?.apiKey ?? "",
          profileId
        });
        openclawSync = outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
      }
      // 模型 id 变化时同步模型（让会话立刻用上新选的模型）。
      // defaults 与 agent 级配置一起改 —— 只改 defaults 不够，agent 级优先级更高。
      if (openclawSync?.ok !== false && chatAssignment.model) {
        const modelOutcome = await syncOpenClawChatModel({
          provider: saved.providerId,
          model: chatAssignment.model,
          profileId
        });
        if (!modelOutcome.ok) {
          openclawSync = { ok: false, reason: modelOutcome.reason };
        }
      }
    }
  }

  return jsonOk({
    item: {
      id: saved.id,
      providerId: saved.providerId,
      label: saved.label,
      apiFormat: saved.apiFormat,
      baseUrl: saved.baseUrl,
      models,
      status: saved.status,
      statusMsg: saved.statusMsg,
      usedBy: [],
      createdAt: saved.createdAt.toISOString()
    },
    isSearchProvider,
    openclawSync
  });
}
