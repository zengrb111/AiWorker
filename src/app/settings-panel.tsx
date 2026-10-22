"use client";

import { useCallback, useEffect, useState } from "react";
import { MODEL_PRESETS, findPreset } from "@/lib/model-presets";

/**
 * 「系统配置 → 模型配置」真实面板。
 *
 * 三段结构：模型服务列表（增删改 + 测试连接）→ 默认模型分配（8 项能力）→ 空状态引导。
 * 所有读写都只作用于当前登录用户：密钥由服务端加密存储，页面只拿到掩码。
 */

type ProviderModel = { id: string; name: string };

type ProviderItem = {
  id: string;
  providerId: string;
  label: string;
  apiFormat: string;
  apiFormatLabel: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasApiSecret: boolean;
  models: ProviderModel[];
  status: string;
  statusMsg: string;
  lastVerifyAt: string | null;
  usedBy: string[];
  createdAt: string;
};

type CapabilityItem = {
  capability: string;
  label: string;
  hint: string;
  providerRowId: string | null;
  providerLabel: string | null;
  model: string | null;
};

type DraftModel = {
  id: string | null;
  providerId: string;
  label: string;
  apiFormat: string;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  models: ProviderModel[];
  consoleUrl: string;
  hint: string;
};

const EMPTY_DRAFT: DraftModel = {
  id: null,
  providerId: "",
  label: "",
  apiFormat: "openai-completions",
  baseUrl: "",
  apiKey: "",
  apiSecret: "",
  models: [],
  consoleUrl: "",
  hint: ""
};

const STATUS_META: Record<string, { label: string; className: string }> = {
  untested: { label: "未验证", className: "muted" },
  ok: { label: "可用", className: "ok" },
  invalid: { label: "凭据无效", className: "bad" }
};

const CAPABILITY_ICON: Record<string, string> = {
  chat: "AI",
  vision: "IMG",
  ocr: "OCR",
  tts: "TTS",
  video: "VID",
  storyboard: "SB",
  embedding: "EMB",
  search: "WEB"
};

/** 能力 → 允许的接口形态：下拉只显示形态匹配的服务，避免把配音指到搜索服务。 */
const CAPABILITY_FORMAT: Record<string, string[]> = {
  chat: ["openai-completions"],
  vision: ["openai-completions"],
  ocr: ["openai-completions"],
  embedding: ["openai-completions"],
  storyboard: ["openai-completions"],
  tts: ["zhipu-tts", "dashscope-tts"],
  video: ["pollinations-video"],
  search: ["tavily-search", "bocha-search"]
};

/** 有内置零配置数据源的能力：未指定时仍可用，界面要说清免得用户以为坏了。 */
const CAPABILITY_FALLBACK_NOTE: Record<string, string> = {
  search: "未指定时使用内置公开热榜（百度 / 抖音 / 头条 / 知乎，零配置零密钥）；指定自己的搜索服务可获得按关键词检索的结果。",
  tts: "未指定时使用免费合成音（本地 edge-tts，零配置零密钥）；指定云端配音后出片将优先使用所选服务。"
};

/**
 * 主对话模型（chat）的 OpenClaw 同步说明（v3 方案）。
 *
 * 为什么必须加：会话改走 OpenClaw 后，模型选择权的实际生效点在 OpenClaw 侧。
 * 用户在这里改 chat 模型时，如果没有任何说明，会预期「立刻生效」；
 * 而 key 要经 `paste-api-key` 写进 OpenClaw 的私有 sqlite，模型切换也可能
 * 需要网关重载才完全生效 —— 不加这句，用户会以为平台坏了。
 */
const CAPABILITY_OPENCLAW_NOTE: Record<string, string> = {
  chat: "主对话模型的 API Key 保存后会同步到 OpenClaw，会话实际使用 OpenClaw 里的模型配置。修改后需重启 OpenClaw 网关方可生效。"
};

function formatTime(iso?: string | null): string {
  if (!iso) return "未验证";
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export default function SettingsPanel({ resetToken }: { resetToken: number }) {
  /** 页签：模型配置（日常）/ 安全配置（凭据）。默认模型配置，避免刷新页面就跳到换密钥。 */
  const [tab, setTab] = useState<"model" | "security">("model");
  const [items, setItems] = useState<ProviderItem[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /**
   * OpenClaw 同步失败信息（v3：仅 chat 能力会同步）。
   * 保存成功但同步失败时在此展示，避免用户以为配置已生效。
   */
  const [syncError, setSyncError] = useState<{ capability: string; reason: string } | null>(null);
  const [draft, setDraft] = useState<DraftModel | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [testingId, setTestingId] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [assignmentDraft, setAssignmentDraft] = useState<Record<string, { providerRowId: string; model: string }>>({});
  const [savingAssignments, setSavingAssignments] = useState(false);
  /** 平台 Agent 令牌（龙虾回调平台接口的鉴权凭据，收编到系统配置里管理）。 */
  const [agentToken, setAgentToken] = useState<{ enabled: boolean; masked: string } | null>(null);
  const [agentTokenBusy, setAgentTokenBusy] = useState(false);
  const [agentTokenNotice, setAgentTokenNotice] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings/models", { cache: "no-store" });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { items?: ProviderItem[]; capabilities?: CapabilityItem[] };
        error?: string;
      };
      if (!json.ok || !json.data) throw new Error(json.error || "加载模型配置失败。");
      setItems(json.data.items ?? []);
      setCapabilities(json.data.capabilities ?? []);
      setAssignmentDraft(
        Object.fromEntries(
          (json.data.capabilities ?? []).map((row) => [
            row.capability,
            { providerRowId: row.providerRowId ?? "", model: row.model ?? "" }
          ])
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAgentToken = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/agent-token", { cache: "no-store" });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { enabled: boolean; masked: string };
      };
      if (json.ok && json.data) setAgentToken(json.data);
    } catch {
      /* 读不到不影响模型配置主流程 */
    }
  }, []);

  /** 重新生成平台 Agent 令牌，并尝试复制明文到剪贴板（接口只在本次响应回显明文）。 */
  async function regenerateAgentToken() {
    setAgentTokenBusy(true);
    setAgentTokenNotice("");
    try {
      const res = await fetch("/api/settings/agent-token", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { enabled: boolean; masked: string; token: string };
        error?: string;
      };
      if (!json.ok || !json.data) throw new Error(json.error || "生成失败。");
      setAgentToken({ enabled: json.data.enabled, masked: json.data.masked });
      let copied = false;
      try {
        await navigator.clipboard.writeText(json.data.token);
        copied = true;
      } catch {
        /* 剪贴板不可用时仍展示成功，明文可通过接口重新生成一次获取 */
      }
      setAgentTokenNotice(
        copied
          ? "已生成新令牌并复制到剪贴板。龙虾会自动读取新令牌，无需再改任何配置文件。"
          : "已生成新令牌。龙虾会自动读取新令牌，无需再改任何配置文件。"
      );
    } catch (err) {
      setAgentTokenNotice(`生成失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAgentTokenBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
    void loadAgentToken();
  }, [refresh, loadAgentToken, resetToken]);

  const assignedCount = capabilities.filter((row) => row.providerRowId && row.model).length;
  // 配音有零配置免费默认（本地 edge-tts），未指定不算缺失，不进警告计数。
  const missingCount = capabilities.filter(
    (row) => row.capability !== "tts" && !assignmentDraft[row.capability]?.providerRowId,
  ).length;

  function openCreate() {
    setFormError("");
    setDraft({ ...EMPTY_DRAFT });
  }

  function openEdit(item: ProviderItem) {
    setFormError("");
    const preset = findPreset(item.providerId);
    setDraft({
      id: item.id,
      providerId: item.providerId,
      label: item.label,
      apiFormat: item.apiFormat,
      baseUrl: item.baseUrl,
      // 密钥不回传明文：留空即不修改
      apiKey: "",
      apiSecret: "",
      models: item.models.length > 0 ? item.models : [],
      consoleUrl: preset?.consoleUrl ?? "",
      hint: preset?.hint ?? ""
    });
  }

  function applyPreset(providerId: string) {
    const preset = findPreset(providerId);
    setDraft((prev) => {
      if (!prev) return prev;
      if (!preset) return { ...prev, providerId };
      return {
        ...prev,
        providerId,
        label: prev.id ? prev.label : preset.label,
        apiFormat: preset.apiFormat,
        baseUrl: preset.baseUrl,
        models: prev.id ? prev.models : preset.models,
        consoleUrl: preset.consoleUrl,
        hint: preset.hint
      };
    });
  }

  function toggleModel(modelId: string) {
    setDraft((prev) => {
      if (!prev) return prev;
      const exists = prev.models.some((m) => m.id === modelId);
      return {
        ...prev,
        models: exists
          ? prev.models.filter((m) => m.id !== modelId)
          : [...prev.models, { id: modelId, name: modelId }]
      };
    });
  }

  function addCustomModel() {
    const input = window.prompt("填写模型 id（如 glm-4.6、qwen-max）");
    const trimmed = (input ?? "").trim();
    if (!trimmed || !draft) return;
    setDraft({
      ...draft,
      models: draft.models.some((m) => m.id === trimmed)
        ? draft.models
        : [...draft.models, { id: trimmed, name: trimmed }]
    });
  }

  async function saveDraft() {
    if (!draft) return;
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch("/api/settings/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft)
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        setFormError(json.error || "保存失败，请检查填写内容。");
        return;
      }
      setDraft(null);
      setNotice("模型服务已保存，建议点「测试连接」确认密钥可用。");
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection(item: ProviderItem) {
    setTestingId(item.id);
    setNotice("");
    try {
      const res = await fetch("/api/settings/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerRowId: item.id })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { status: string; message: string };
        error?: string;
      };
      setNotice(json.ok ? json.data?.message ?? "连接正常。" : json.error ?? "测试失败。");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestingId("");
    }
  }

  async function removeProvider(id: string) {
    if (confirmRemove?.id === id) {
      clearTimeout(confirmRemove.timer);
      setConfirmRemove(null);
      const res = await fetch(`/api/settings/models/${id}`, { method: "DELETE" });
      const json = (await res.json()) as { ok: boolean; error?: string };
      setNotice(json.ok ? "模型服务及其能力分配已删除。" : json.error ?? "删除失败。");
      await refresh();
      return;
    }
    if (confirmRemove) clearTimeout(confirmRemove.timer);
    const timer = setTimeout(() => setConfirmRemove(null), 4000);
    setConfirmRemove({ id, timer });
  }

  function changeAssignment(capability: string, providerRowId: string) {
    const provider = items.find((item) => item.id === providerRowId);
    setAssignmentDraft((prev) => ({
      ...prev,
      [capability]: { providerRowId, model: provider?.models[0]?.id ?? "" }
    }));
  }

  function changeAssignmentModel(capability: string, model: string) {
    setAssignmentDraft((prev) => ({ ...prev, [capability]: { ...prev[capability], model } }));
  }

  async function saveAssignments() {
    setSavingAssignments(true);
    try {
      const res = await fetch("/api/settings/assignments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignments: capabilities.map((row) => ({
            capability: row.capability,
            providerRowId: assignmentDraft[row.capability]?.providerRowId || null,
            model: assignmentDraft[row.capability]?.model || null
          }))
        })
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        openclawSync?: { ok: boolean; reason?: string };
      };
      if (!json.ok) {
        setNotice(json.error ?? "保存失败。");
        return;
      }
      // OpenClaw 同步失败不阻断保存（Prisma 已是事实来源），但要让用户看见。
      setSyncError(
        json.openclawSync && !json.openclawSync.ok
          ? { capability: "chat", reason: json.openclawSync.reason ?? "未知原因" }
          : null
      );
      setNotice(
        missingCount > 0
          ? "分配已保存，未指定的能力在使用时会提示去系统配置。"
          : "默认模型分配已保存并立即生效。"
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAssignments(false);
    }
  }

  const needsSecret = draft?.apiFormat === "bocha-search";

  return (
    <div className="pub-root">
      <div className="pub-toolbar">
        <div className="pub-title-group">
          <h2>系统配置</h2>
          <p className="pub-subtitle">
            {tab === "model"
              ? "模型服务与默认模型分配 · 密钥仅你本人可见可用"
              : "平台接口鉴权凭据 · 仅你本人可见可用"}
          </p>
        </div>
        <div className="pub-actions">
          <button
            className="pub-refresh"
            onClick={() => {
              void refresh();
              void loadAgentToken();
            }}
            disabled={loading}
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
          {tab === "model" && (
            <button className="pub-refresh primary" onClick={openCreate} disabled={Boolean(draft)}>
              添加模型服务
            </button>
          )}
        </div>
      </div>

      {/* 页签：默认落在「模型配置」，令牌这类凭据收进「安全配置」，
          两者改动频率与心态完全不同（一个是日常调模型，一个是偶尔换密钥），混在一页容易误操作。 */}
      <div className="cfg-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "model"}
          className={`cfg-tab ${tab === "model" ? "active" : ""}`}
          onClick={() => setTab("model")}
        >
          <span className="cfg-tab-label">模型配置</span>
          <span className="cfg-tab-hint">
            {items.length} 个服务 · 已分配 {assignedCount}/{capabilities.length} 项能力
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "security"}
          className={`cfg-tab ${tab === "security" ? "active" : ""}`}
          onClick={() => setTab("security")}
        >
          <span className="cfg-tab-label">安全配置</span>
          <span className="cfg-tab-hint">
            平台 Agent 令牌{agentToken?.enabled ? "已启用" : "未配置"}
          </span>
        </button>
      </div>

      {tab === "model" && (
        <div className="cfg-tab-panel">
          <div className="cfg-overview">
            <span>已配置 {items.length} 个模型服务</span>
            <span className="cfg-dot" />
            <span>
              已分配 {assignedCount} / {capabilities.length} 项能力
            </span>
            {missingCount > 0 && (
              <>
                <span className="cfg-dot" />
                <span className="cfg-warn">还有 {missingCount} 项能力未指定模型</span>
              </>
            )}
          </div>

          {error && <div className="pub-alert">{error}</div>}
          {notice && <div className="pub-alert ok">{notice}</div>}

          {items.length === 0 && !loading ? (
            <div className="cfg-empty">
              <div className="cfg-empty-icon">CFG</div>
              <h3>还没有配置模型服务</h3>
              <p>
                配置后即可使用 AI 对话、今日热点、识图、OCR、配音与文生视频等能力。平台不再提供公共密钥，每个人的 token 都只归自己使用。
              </p>
              <button className="pub-refresh primary" onClick={openCreate}>
                添加模型服务
              </button>
            </div>
          ) : (
            <div className="cfg-cards">
              {items.map((item) => {
                const meta = STATUS_META[item.status] ?? STATUS_META.untested;
                const preset = findPreset(item.providerId);
                return (
                  <div key={item.id} className="cfg-card">
                    <div className="cfg-card-head">
                      <span className="cfg-badge" style={{ background: preset?.brandColor ?? "#2b7cff" }}>
                        {preset?.badge ?? "自"}
                      </span>
                      <div className="cfg-card-main">
                        <div className="cfg-name">{item.label}</div>
                        <div className="cfg-sub">
                          {item.apiFormatLabel} · {item.models.length} 个模型
                          {item.usedBy.length > 0 && ` · 用于 ${item.usedBy.length} 项能力`}
                        </div>
                      </div>
                      <span className={`cfg-status ${meta.className}`}>{meta.label}</span>
                    </div>

                    <div className="cfg-meta">
                      <span className="cfg-url" title={item.baseUrl}>
                        {item.baseUrl}
                      </span>
                      <span className="cfg-key">{item.apiKeyMasked || "未填写密钥"}</span>
                      {item.hasApiSecret && <span className="cfg-key">Secret：****已保存</span>}
                      <span className="cfg-time">最近验证：{formatTime(item.lastVerifyAt)}</span>
                    </div>

                    {item.status === "invalid" && item.statusMsg && <div className="cfg-error">{item.statusMsg}</div>}
                    {item.status === "ok" && item.statusMsg && <div className="cfg-hint-ok">{item.statusMsg}</div>}

                    <div className="cfg-models">
                      {item.models.slice(0, 4).map((model) => (
                        <span key={model.id} className="cfg-chip">
                          {model.name || model.id}
                        </span>
                      ))}
                      {item.models.length > 4 && <span className="cfg-chip muted">+{item.models.length - 4}</span>}
                    </div>

                    <div className="cfg-ops">
                      <button
                        className="acct-btn primary"
                        onClick={() => void testConnection(item)}
                        disabled={testingId === item.id}
                      >
                        {testingId === item.id ? "测试中…" : "测试连接"}
                      </button>
                      <button className="acct-btn" onClick={() => openEdit(item)} disabled={Boolean(draft)}>
                        编辑
                      </button>
                      <button className="acct-btn danger" onClick={() => void removeProvider(item.id)}>
                        {confirmRemove?.id === item.id ? "4 秒内再点一次确认删除" : "删除"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="cfg-assign">
            <div className="cfg-assign-head">
              <h3>默认模型分配</h3>
              <p>每项能力用哪个服务的哪个模型，保存后立即对你生效。未指定的能力在使用时会明确提示缺哪一项。</p>
            </div>

            <div className="cfg-assign-list">
              {capabilities.map((row) => {
                const allowed = CAPABILITY_FORMAT[row.capability] ?? ["openai-completions"];
                const matched = items.filter((item) => {
                  if (allowed.includes(item.apiFormat)) return true;
                  // 配音：DashScope 的通用 provider（openai-completions + dashscope 域名）也能跑
                  // 千问 TTS（qwen3-tts-flash），不该被 apiFormat 白名单挡住 —— 用户常只建一个
                  // DashScope provider 同时用于对话与配音，再单独建一个 tts 专用 provider 很反直觉。
                  if (
                    row.capability === "tts" &&
                    item.apiFormat === "openai-completions" &&
                    /dashscope\.aliyuncs\.com/i.test(item.baseUrl)
                  ) {
                    return true;
                  }
                  return false;
                });
                // 配音已默认走免费合成音（本地 edge-tts），云端配音只是可选增强：
                // 没有形态匹配的服务时也不能把下拉禁死（那会被当成「配置项坏了」），
                // 回退列出全部服务，选不选、选哪个都交给用户自己决定。
                const candidates = row.capability === "tts" && !matched.length ? items : matched;
                const current = assignmentDraft[row.capability] ?? { providerRowId: "", model: "" };
                const provider = items.find((item) => item.id === current.providerRowId);
                // 配音优先只列 TTS 模型（如 qwen3-tts-flash）；没有匹配再回退全部模型。
                const allModels = provider?.models ?? [];
                const ttsModels =
                  row.capability === "tts"
                    ? allModels.filter(
                        (model) => /tts/i.test(model.id) || /tts|配音/i.test(model.name || ""),
                      )
                    : [];
                const modelChoices = ttsModels.length ? ttsModels : allModels;
                return (
                  <div key={row.capability} className="cfg-assign-row">
                    <span className="cfg-assign-icon">{CAPABILITY_ICON[row.capability] ?? "CFG"}</span>
                    <div className="cfg-assign-main">
                      <div className="cfg-assign-name">{row.label}</div>
                      <div className="cfg-assign-hint">{row.hint}</div>
                      {!current.providerRowId && CAPABILITY_FALLBACK_NOTE[row.capability] && (
                        <div className="cfg-assign-hint">{CAPABILITY_FALLBACK_NOTE[row.capability]}</div>
                      )}
                      {CAPABILITY_OPENCLAW_NOTE[row.capability] && (
                        <div className="cfg-assign-hint cfg-assign-hint-openclaw">
                          {CAPABILITY_OPENCLAW_NOTE[row.capability]}
                        </div>
                      )}
                      {syncError?.capability === row.capability && (
                        <div className="cfg-assign-hint cfg-assign-hint-error">
                          同步到 OpenClaw 失败：{syncError.reason}
                        </div>
                      )}
                    </div>
                    <div className="cfg-assign-controls">
                      <select
                        className="cfg-select"
                        value={current.providerRowId}
                        disabled={candidates.length === 0}
                        onChange={(e) => changeAssignment(row.capability, e.target.value)}
                      >
                        <option value="">{row.capability === "tts" ? "未指定（免费合成音）" : "未指定"}</option>
                        {candidates.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                            {item.status === "invalid" ? "（凭据无效）" : ""}
                          </option>
                        ))}
                      </select>
                      <select
                        className="cfg-select"
                        value={current.model}
                        disabled={!provider || modelChoices.length === 0}
                        onChange={(e) => changeAssignmentModel(row.capability, e.target.value)}
                      >
                        <option value="">选择模型</option>
                        {modelChoices.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name || model.id}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="cfg-assign-bar">
              <span className={missingCount > 0 ? "cfg-warn" : "cfg-ok"}>
                {missingCount > 0 ? `有 ${missingCount} 项能力未指定模型` : "全部能力均已指定模型"}
              </span>
              <button
                className="pub-refresh primary"
                onClick={() => void saveAssignments()}
                disabled={savingAssignments || items.length === 0}
              >
                {savingAssignments ? "保存中…" : "保存分配"}
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "security" && (
        <div className="cfg-tab-panel">
          {/* 平台 Agent 令牌：龙虾（OpenClaw 里的 AI）回调平台接口的鉴权凭据。
              收编到系统配置管理，避免散落在 .env.local，也避免模型复抄长串导致 401。 */}
          <div className="cfg-assign">
            <div className="cfg-assign-head">
              <h3>平台 Agent 令牌</h3>
              <p>
                龙虾（OpenClaw 会话里的 AI）调平台接口——定时任务增删改、立即执行——时用的鉴权令牌。
                在这里配置后平台会自动同步到本地令牌文件，龙虾直接读取即可，不用再改 <code>.env.local</code>。
              </p>
            </div>
            <div className="cfg-card">
              <div className="cfg-card-head">
                <span className="cfg-badge" style={{ background: "#19b35c" }}>
                  KEY
                </span>
                <div className="cfg-card-main">
                  <div className="cfg-name">当前令牌</div>
                  <div className="cfg-sub">
                    {agentToken?.enabled
                      ? "已启用 · 龙虾可正常调用平台接口"
                      : "未配置 · 龙虾无法调用平台接口（定时任务会 401）"}
                  </div>
                </div>
                <span className={`cfg-status ${agentToken?.enabled ? "ok" : "bad"}`}>
                  {agentToken?.enabled ? "已启用" : "未启用"}
                </span>
              </div>
              <div className="cfg-meta">
                <span className="cfg-key">{agentToken?.masked || "未配置"}</span>
                <span className="cfg-time">来源：系统配置（数据库）</span>
              </div>
              {agentTokenNotice && <div className="cfg-hint-ok">{agentTokenNotice}</div>}
              <div className="cfg-ops">
                <button
                  className="acct-btn primary"
                  onClick={() => void regenerateAgentToken()}
                  disabled={agentTokenBusy}
                >
                  {agentTokenBusy ? "生成中…" : agentToken?.enabled ? "重新生成" : "生成令牌"}
                </button>
              </div>
            </div>
          </div>

          {/* 令牌不是"配了就好"的东西：换掉之后旧令牌仍可用的窗口、龙虾从哪读，
              这两件事不问清楚就会重复踩 401，所以直接写在页面上。 */}
          <div className="cfg-sec-notes">
            <div className="cfg-sec-note">
              <strong>龙虾怎么拿到它</strong>
              <span>
                平台会把令牌同步写入本机 <code>data/.agent-token</code>，龙虾按这个路径读取，不需要你手工粘给它。
              </span>
            </div>
            <div className="cfg-sec-note">
              <strong>重新生成的后果</strong>
              <span>
                旧令牌立即失效，但 <code>.env.local</code> 里仍在用的旧值会被平台兼容放行，
                所以内容库等既有脚本不会因为换令牌而中断。
              </span>
            </div>
            <div className="cfg-sec-note">
              <strong>谁能看到</strong>
              <span>明文只在生成的那一刻返回一次，之后页面只显示掩码。别人登录自己的账号看不到你的令牌。</span>
            </div>
          </div>
        </div>
      )}

      {draft && (
        <div className="acct-mask" onClick={() => !saving && setDraft(null)}>
          <div className="acct-dialog cfg-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{draft.id ? `编辑「${draft.label}」` : "添加模型服务"}</h3>

            <div className="cfg-field">
              <label className="cfg-label">供应商</label>
              <div className="cfg-preset-grid">
                {MODEL_PRESETS.map((preset) => (
                  <button
                    key={preset.providerId}
                    type="button"
                    className={`cfg-preset ${draft.providerId === preset.providerId ? "active" : ""}`}
                    onClick={() => applyPreset(preset.providerId)}
                    disabled={Boolean(draft.id)}
                  >
                    <span className="cfg-badge sm" style={{ background: preset.brandColor }}>
                      {preset.badge}
                    </span>
                    <span>{preset.label}</span>
                  </button>
                ))}
              </div>
              {!draft.id && (
                <input
                  className="acct-input"
                  placeholder="或直接填写自定义 OpenAI 兼容服务标识"
                  value={draft.providerId}
                  onChange={(e) => setDraft({ ...draft, providerId: e.target.value })}
                  disabled={saving}
                />
              )}
            </div>

            <div className="cfg-field">
              <label className="cfg-label">显示名称</label>
              <input
                className="acct-input"
                placeholder="如 智谱 GLM（主号）"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                disabled={saving}
              />
            </div>

            <div className="cfg-field">
              <label className="cfg-label">可用模型（至少选一个）</label>
              <div className="cfg-model-grid">
                {draft.models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    className="cfg-chip toggle"
                    onClick={() => toggleModel(model.id)}
                    disabled={saving}
                  >
                    {model.name || model.id}
                  </button>
                ))}
                <button type="button" className="cfg-chip add" onClick={addCustomModel} disabled={saving}>
                  + 自定义模型 id
                </button>
              </div>
              {draft.models.length === 0 && <p className="cfg-field-error">请至少选择一个模型。</p>}
            </div>

            <div className="cfg-field">
              <label className="cfg-label">API Key</label>
              <input
                className="acct-input"
                type="password"
                placeholder={draft.id ? "留空表示不修改" : "粘贴你在服务商控制台创建的 API Key"}
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                disabled={saving}
                autoComplete="off"
              />
              <p className="cfg-security">密钥经 AES-256-GCM 加密后存入数据库，仅你本人可见可用。</p>
              {draft.hint && <p className="cfg-field-hint">{draft.hint}</p>}
              {draft.consoleUrl && (
                <a className="cfg-link" href={draft.consoleUrl} target="_blank" rel="noreferrer">
                  打开 {draft.label} 控制台申请密钥 →
                </a>
              )}
            </div>

            {needsSecret && (
              <div className="cfg-field">
                <label className="cfg-label">Secret Key</label>
                <input
                  className="acct-input"
                  type="password"
                  placeholder={draft.id ? "留空表示不修改" : "博查的 Secret-Key"}
                  value={draft.apiSecret}
                  onChange={(e) => setDraft({ ...draft, apiSecret: e.target.value })}
                  disabled={saving}
                  autoComplete="off"
                />
              </div>
            )}

            <details className="cfg-advanced">
              <summary>高级项（接口地址与接口形态）</summary>
              <div className="cfg-field">
                <label className="cfg-label">接口地址</label>
                <input
                  className="acct-input"
                  placeholder="https://api.example.com/v1"
                  value={draft.baseUrl}
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  disabled={saving}
                />
              </div>
              <div className="cfg-field">
                <label className="cfg-label">接口形态</label>
                <select
                  className="cfg-select wide"
                  value={draft.apiFormat}
                  onChange={(e) => setDraft({ ...draft, apiFormat: e.target.value })}
                  disabled={saving}
                >
                  <option value="openai-completions">OpenAI 兼容接口（对话 / 识图 / OCR）</option>
                  <option value="zhipu-tts">智谱配音</option>
                  <option value="dashscope-tts">阿里云百炼配音</option>
                  <option value="tavily-search">Tavily 联网搜索</option>
                  <option value="bocha-search">博查联网搜索</option>
                  <option value="pollinations-video">文生视频</option>
                </select>
              </div>
            </details>

            {formError && <div className="acct-msg bad">{formError}</div>}

            <div className="acct-dialog-ops">
              <button className="acct-btn" onClick={() => setDraft(null)} disabled={saving}>
                取消
              </button>
              <button className="acct-btn primary" onClick={() => void saveDraft()} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
