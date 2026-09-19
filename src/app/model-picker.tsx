"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MODEL_PRESETS, findPreset } from "@/lib/model-presets";

export type ModelOption = { id: string; name: string; provider: string; available: boolean };
export type CurrentModel = { provider: string; model: string } | null;

type Props = {
  models: ModelOption[];
  current: CurrentModel;
  /** 正在切换模型（切换期间整个选择器与输入框都会锁住） */
  switching: boolean;
  /** 正在生成内容时也锁住，避免中途换模型 */
  busy?: boolean;
  onSwitch: (modelId: string, label: string) => void;
  onModelsChanged: (models: ModelOption[]) => void;
};

// ---------------------------------------------------------------------------
// 品牌图标：圆角方块 + 白色简化标识（无官方 logo 资源，用几何符号近似）
// ---------------------------------------------------------------------------

type Brand = { color: string; glyph: ReactNode };

const BRANDS: Record<string, Brand> = {
  deepseek: {
    color: "#4d6bfe",
    glyph: <path d="M12 4.5a7.5 7.5 0 1 0 5.2 12.8l2.3 2.2V7.4z" />
  },
  gemini: {
    color: "#1a73e8",
    glyph: <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
  },
  zhipu: {
    color: "#3b5bdb",
    glyph: (
      <>
        <rect x="4" y="4" width="7" height="7" rx="2" />
        <rect x="13" y="4" width="7" height="7" rx="2" />
        <rect x="4" y="13" width="7" height="7" rx="2" />
        <rect x="13" y="13" width="7" height="7" rx="2" />
      </>
    )
  },
  qwen: {
    color: "#7c3aed",
    glyph: <path d="M12 2.6l8.2 4.8v9.2L12 21.4l-8.2-4.8V7.4z" />
  },
  doubao: {
    color: "#2563eb",
    glyph: (
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="9" cy="11" r="1.4" fill="#2563eb" />
        <circle cx="15" cy="11" r="1.4" fill="#2563eb" />
      </>
    )
  },
  hunyuan: {
    color: "#0ea5e9",
    glyph: (
      <>
        <circle cx="12" cy="12" r="7.6" fill="none" stroke="currentColor" strokeWidth="2.6" />
        <circle cx="12" cy="12" r="2.6" />
      </>
    )
  },
  openai: { color: "#10a37f", glyph: <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" /> },
  anthropic: { color: "#d97757", glyph: <path d="M6.4 19h3l1.1-3h3l1.1 3h3L13.8 5h-3.6z" /> }
};

const DEFAULT_BRAND: Brand = { color: "#64748b", glyph: <circle cx="12" cy="12" r="7" /> };

function brandOf(provider?: string | null): Brand {
  const value = (provider ?? "").toLowerCase();
  if (value.includes("deepseek")) return BRANDS.deepseek;
  if (value.includes("google") || value.includes("gemini")) return BRANDS.gemini;
  if (value.includes("zhipu") || value.includes("glm")) return BRANDS.zhipu;
  if (value.includes("qwen") || value.includes("dashscope") || value.includes("aliyun"))
    return BRANDS.qwen;
  if (value.includes("doubao") || value.includes("volc")) return BRANDS.doubao;
  if (value.includes("hunyuan") || value.includes("tencent")) return BRANDS.hunyuan;
  if (value.includes("openai")) return BRANDS.openai;
  if (value.includes("anthropic")) return BRANDS.anthropic;
  return DEFAULT_BRAND;
}

function BrandIcon({ provider, size = 26 }: { provider?: string | null; size?: number }) {
  const brand = brandOf(provider);
  return (
    <span
      className="model-brand-icon"
      style={{
        background: brand.color,
        width: size,
        height: size,
        borderRadius: Math.max(6, Math.round(size * 0.3))
      }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.6} height={size * 0.6} fill="currentColor">
        {brand.glyph}
      </svg>
    </span>
  );
}

// ---------------------------------------------------------------------------

export default function ModelPicker({
  models,
  current,
  switching,
  busy,
  onSwitch,
  onModelsChanged
}: Props) {
  const [open, setOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configProvider, setConfigProvider] = useState<string>(MODEL_PRESETS[0].providerId);
  const [apiKey, setApiKey] = useState("");
  const [pickedModel, setPickedModel] = useState(MODEL_PRESETS[0].models[0].id);
  const [customModel, setCustomModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点击面板外部关闭（弹窗打开时不关面板，避免闪一下）
  useEffect(() => {
    if (!open || configOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, configOpen]);

  const currentOption = models.find((item) => item.id === current?.model) ?? null;
  const currentLabel = currentOption?.name ?? current?.model ?? "选择模型";

  function openConfig() {
    setConfigOpen(true);
    setError("");
    setApiKey("");
    setCustomModel("");
    const first = findPreset(configProvider) ?? MODEL_PRESETS[0];
    setPickedModel(first.models[0]?.id ?? "");
  }

  function pickProvider(providerId: string) {
    setConfigProvider(providerId);
    setError("");
    const preset = findPreset(providerId);
    setPickedModel(preset?.models[0]?.id ?? "");
  }

  async function submitProvider(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const preset = findPreset(configProvider);
    if (!preset) return;

    const modelId = customModel.trim() || pickedModel;
    if (!apiKey.trim()) {
      setError("请填写 API Key。");
      return;
    }
    if (!modelId) {
      setError("请选择或填写模型 id。");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/models/provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: preset.providerId,
          baseUrl: preset.baseUrl,
          modelId,
          modelName: preset.models.find((item) => item.id === modelId)?.name,
          apiKey: apiKey.trim()
        })
      });
      const payload = (await response.json()) as
        | { ok: true; data: { models: ModelOption[]; registered: boolean } }
        | { ok: false; error: string };
      if (!payload.ok) throw new Error(payload.error);

      onModelsChanged(payload.data.models);
      if (!payload.data.registered) {
        // 保存成功但网关还没认出来：留在弹窗里让用户看到原因
        setError("已保存，但网关暂未识别该模型，可能需要重启 OpenClaw 网关后生效。");
        return;
      }
      setConfigOpen(false);
      setOpen(true); // 回到列表，让用户看到新模型已经出现
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }

  const locked = switching || Boolean(busy);
  const activePreset = findPreset(configProvider) ?? MODEL_PRESETS[0];

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className={`model-chip ${open ? "open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        disabled={locked}
        title={switching ? "正在切换模型…" : `当前模型：${currentLabel}`}
      >
        <BrandIcon provider={currentOption?.provider ?? current?.provider} size={22} />
        <span className="model-chip-name">{switching ? "切换中…" : currentLabel}</span>
        <span className="model-chip-caret" aria-hidden="true">
          ⌃
        </span>
      </button>

      {open && (
        <div className="model-panel">
          <div className="model-panel-section-title">选择模型</div>
          <div className="model-panel-list">
            {models.length === 0 && <p className="model-panel-empty">网关尚未返回模型列表。</p>}
            {models.map((item) => {
              const active = item.id === current?.model;
              return (
                <button
                  key={`${item.provider}-${item.id}`}
                  type="button"
                  className={`model-option ${active ? "active" : ""}`}
                  disabled={switching || active || !item.available}
                  onClick={() => {
                    onSwitch(item.id, item.name);
                    setOpen(false);
                  }}
                >
                  <BrandIcon provider={item.provider} />
                  <span className="model-option-text">
                    <span className="model-option-name">{item.name}</span>
                    <span className="model-option-meta">{item.provider}</span>
                  </span>
                  {active && <span className="model-option-check">✓</span>}
                </button>
              );
            })}
          </div>

          <button type="button" className="model-config-entry" onClick={openConfig}>
            <span className="model-config-entry-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3.2" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 2.6 15H2.5a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 7a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 2.6V2.5a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 17 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 21.4 9h.1a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.2 2z" />
              </svg>
            </span>
            <span className="model-config-entry-text">配置自定义模型</span>
          </button>
        </div>
      )}

      {/* 弹窗用 Portal 渲染到 body：ModelPicker 会被放在聊天输入框表单内部，
          而 HTML 不允许表单嵌套 —— Portal 让弹窗彻底脱离外层 <form>。 */}
      {configOpen && typeof document !== "undefined" && createPortal(
        <div
          className="kb-modal-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) setConfigOpen(false);
          }}
        >
          <form className="kb-modal small model-config-modal" onSubmit={submitProvider}>
            <div className="kb-modal-head">
              <h4>配置自定义模型</h4>
              <button type="button" className="model-modal-close" onClick={() => setConfigOpen(false)}>
                ×
              </button>
            </div>

            <div className="kb-modal-body">
              <div className="model-config-field">
                <span>模型供应商</span>
                <div className="model-provider-grid">
                  {MODEL_PRESETS.map((preset) => (
                    <button
                      key={preset.providerId}
                      type="button"
                      className={`model-provider-tab ${configProvider === preset.providerId ? "active" : ""}`}
                      onClick={() => pickProvider(preset.providerId)}
                    >
                      <BrandIcon provider={preset.providerId} size={24} />
                      <span>{preset.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <label className="model-config-field">
                <span>API Key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="粘贴 API Key"
                  autoComplete="off"
                />
              </label>

              <label className="model-config-field">
                <span>模型</span>
                <select value={pickedModel} onChange={(event) => setPickedModel(event.target.value)}>
                  {activePreset.models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}（{item.id}）
                    </option>
                  ))}
                </select>
              </label>

              <label className="model-config-field">
                <span>自定义模型 id（可选）</span>
                <input
                  value={customModel}
                  onChange={(event) => setCustomModel(event.target.value)}
                  placeholder={`留空则用上面的选择，例如 ${activePreset.models[0]?.id ?? ""}`}
                  autoComplete="off"
                />
              </label>

              <p className="model-config-hint">
                {activePreset.hint}
                <a href={activePreset.consoleUrl} target="_blank" rel="noreferrer">
                  去获取 API Key →
                </a>
              </p>

              {error && <p className="error-text">{error}</p>}
            </div>

            <div className="kb-modal-foot">
              <button type="button" onClick={() => setConfigOpen(false)}>
                取消
              </button>
              <button type="submit" className="primary" disabled={saving}>
                {saving ? "保存中…" : "保存并接入"}
              </button>
            </div>
          </form>
        </div>,
        document.body
      )}
    </div>
  );
}
