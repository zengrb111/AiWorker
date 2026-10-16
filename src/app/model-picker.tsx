"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 模型选择器。
 *
 * 数据源改为「当前用户自己在系统配置里添加的模型服务」（/api/models），
 * 切换写的是该用户的 chat 能力分配（/api/models/switch）。
 * 新增模型服务统一到「系统配置 → 模型配置」页，不再在本组件里填密钥。
 */

export type ModelOption = {
  id: string;
  name: string;
  provider: string;
  providerId: string;
  /** UserModelProvider 行 id：切换时要一起带上，避免同模型名跨服务歧义 */
  providerRowId: string;
  /** 该服务上次的校验结论 */
  status: string;
  /** 该模型当前被哪项能力占用（未占用为 null） */
  capability: string | null;
  available: boolean;
};

export type CurrentModel = {
  provider: string;
  providerId: string;
  providerRowId: string;
  model: string;
  available?: boolean;
} | null;

type Props = {
  models: ModelOption[];
  current: CurrentModel;
  /** 正在切换模型（切换期间整个选择器与输入框都会锁住） */
  switching: boolean;
  /** 正在生成内容时也锁住，避免中途换模型 */
  busy?: boolean;
  onSwitch: (modelId: string, label: string, providerRowId: string) => void;
  /** 前往「系统配置 → 模型配置」新增服务 */
  onGoToSettings?: () => void;
  /** 列表为空时，打开面板会触发重新拉取 */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** 上次拉取失败的原因，展示给用户 */
  errorText?: string;
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
  onGoToSettings,
  onRefresh,
  refreshing,
  errorText
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点击面板外部关闭
  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const currentOption =
    models.find((item) => item.id === current?.model && item.providerRowId === current?.providerRowId) ??
    models.find((item) => item.id === current?.model) ??
    null;
  const currentLabel = currentOption?.name ?? current?.model ?? "选择模型";
  const locked = switching || Boolean(busy);

  /** 展开面板：列表为空（尚未在系统配置添加服务）时顺手重拉一次。 */
  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && models.length === 0) onRefresh?.();
  }

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className={`model-chip ${open ? "open" : ""}`}
        onClick={toggleOpen}
        disabled={locked}
        title={switching ? "正在切换模型…" : `当前模型：${currentLabel}`}
      >
        <BrandIcon provider={currentOption?.providerId ?? current?.providerId} size={22} />
        <span className="model-chip-name">{switching ? "切换中…" : currentLabel}</span>
        <span className="model-chip-caret" aria-hidden="true">
          ⌃
        </span>
      </button>

      {open && (
        <div className="model-panel">
          <div className="model-panel-section-title">选择模型</div>
          <div className="model-panel-list">
            {models.length === 0 && (
              <p className="model-panel-empty">
                {refreshing
                  ? "正在读取你配置的模型服务…"
                  : errorText
                    ? `读取失败：${errorText}`
                    : "还没有配置模型服务。前往「系统配置」添加模型服务并填写 API Key 后即可使用 AI 对话。"}
                {!refreshing && onRefresh && (
                  <button type="button" className="model-panel-retry" onClick={() => onRefresh()}>
                    重试
                  </button>
                )}
              </p>
            )}
            {models.map((item) => {
              const active = item.id === current?.model && item.providerRowId === current?.providerRowId;
              return (
                <button
                  key={`${item.providerRowId}-${item.id}`}
                  type="button"
                  className={`model-option ${active ? "active" : ""}`}
                  disabled={switching || active || !item.available}
                  onClick={() => {
                    onSwitch(item.id, item.name, item.providerRowId);
                    setOpen(false);
                  }}
                >
                  <BrandIcon provider={item.providerId || item.provider} />
                  <span className="model-option-text">
                    <span className="model-option-name">{item.name}</span>
                    <span className="model-option-meta">
                      {item.provider}
                      {item.capability ? ` · 已用于${item.capability}` : ""}
                    </span>
                  </span>
                  {active && <span className="model-option-check">✓</span>}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            className="model-config-entry"
            onClick={() => {
              setOpen(false);
              onGoToSettings?.();
            }}
          >
            <span className="model-config-entry-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3.2" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 2.6 15H2.5a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 7a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 2.6V2.5a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 17 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 21.4 9h.1a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.2 2z" />
              </svg>
            </span>
            <span className="model-config-entry-text">前往系统配置添加模型服务</span>
          </button>
        </div>
      )}
    </div>
  );
}
