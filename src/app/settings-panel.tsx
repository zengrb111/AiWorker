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
  search: "未指定时使用内置公开热榜（百度 / 抖音 / 头条 / 知乎，零配置零密钥）；指定自己的搜索服务可获得按关键词检索的结果。"
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
  const [items, setItems] = useState<ProviderItem[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<DraftModel | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [testingId, setTestingId] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [assignmentDraft, setAssignmentDraft] = useState<Record<string, { providerRowId: string; model: string }>>({});
  const [savingAssignments, setSavingAssignments] = useState(false);

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

  useEffect(() => {
    void refresh();
  }, [refresh, resetToken]);

  const assignedCount = capabilities.filter((row) => row.providerRowId && row.model).length;
  const missingCount = capabilities.filter((row) => !assignmentDraft[row.capability]?.providerRowId).length;

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
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        setNotice(json.error ?? "保存失败。");
        return;
      }
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
          <p className="pub-subtitle">模型服务与默认模型分配 · 密钥仅你本人可见可用</p>
        </div>
        <div className="pub-actions">
          <button className="pub-refresh" onClick={() => void refresh()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
          <button className="pub-refresh primary" onClick={openCreate} disabled={Boolean(draft)}>
            添加模型服务
          </button>
        </div>
      </div>

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
            const candidates = items.filter((item) => allowed.includes(item.apiFormat));
            const current = assignmentDraft[row.capability] ?? { providerRowId: "", model: "" };
            const provider = items.find((item) => item.id === current.providerRowId);
            return (
              <div key={row.capability} className="cfg-assign-row">
                <span className="cfg-assign-icon">{CAPABILITY_ICON[row.capability] ?? "CFG"}</span>
                <div className="cfg-assign-main">
                  <div className="cfg-assign-name">{row.label}</div>
                  <div className="cfg-assign-hint">{row.hint}</div>
                  {!current.providerRowId && CAPABILITY_FALLBACK_NOTE[row.capability] && (
                    <div className="cfg-assign-hint">{CAPABILITY_FALLBACK_NOTE[row.capability]}</div>
                  )}
                </div>
                <div className="cfg-assign-controls">
                  <select
                    className="cfg-select"
                    value={current.providerRowId}
                    disabled={candidates.length === 0}
                    onChange={(e) => changeAssignment(row.capability, e.target.value)}
                  >
                    <option value="">未指定</option>
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
                    disabled={!provider || provider.models.length === 0}
                    onChange={(e) => changeAssignmentModel(row.capability, e.target.value)}
                  >
                    <option value="">选择模型</option>
                    {(provider?.models ?? []).map((model) => (
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
