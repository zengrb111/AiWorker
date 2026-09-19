"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ---------------------------------- types --------------------------------- */

type KbSummary = {
  id: string;
  name: string;
  description: string;
  vectorModel: string;
  chunkStrategy: string;
  chunkSize: number;
  chunkOverlap: number;
  visibility: string;
  topK: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  documentCount: number;
  chunkCount: number;
  trainedCount: number;
};

type KbDocument = {
  id: string;
  filename: string;
  mimeType: string;
  kind: string;
  sizeBytes: number;
  parseStatus: string;
  parseNote: string;
  chunkCount: number;
  createdAt?: string;
};

type KbChunkPreview = {
  id: string;
  documentId: string;
  seq: number;
  content: string;
  charCount: number;
  enabled: boolean;
  trained: boolean;
};

type KbDetailPayload = {
  knowledgeBase: KbSummary;
  documents: KbDocument[];
  stats: { chunkTotal: number; chunkTrained: number; chunkEnabled: number };
  sampleChunks: KbChunkPreview[];
};

type SearchHit = {
  chunkId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  filename: string;
  seq: number;
  content: string;
  score: number;
};

type SearchStats = {
  took: number;
  total: number;
  matched: number;
  kbCount: number;
  max: number;
  avg: number;
  topK: number;
  scope: string;
  atTopK: boolean;
};

type KbForm = {
  name: string;
  description: string;
  vectorModel: string;
  chunkStrategy: string;
  chunkSize: number;
  chunkOverlap: number;
  visibility: string;
  topK: number;
};

const VECTOR_MODELS = [
  { value: "local-hash-256", label: "本地哈希向量（256 维 · 免联网）" },
  { value: "embedding-3", label: "智谱 embedding-3（2048 维 · 需 API Key）" },
  { value: "embedding-2", label: "智谱 embedding-2（1024 维 · 需 API Key）" }
];

const ACCEPT_TYPES =
  ".txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.xml,.log,.yaml,.yml,.docx,.pdf,.zip,.png,.jpg,.jpeg,.webp,.gif,.bmp";

const emptyForm: KbForm = {
  name: "",
  description: "",
  vectorModel: "embedding-3",
  chunkStrategy: "semantic",
  chunkSize: 600,
  chunkOverlap: 80,
  visibility: "private",
  topK: 5
};

/* --------------------------------- helpers -------------------------------- */

async function kbApi<T>(path: string, init?: RequestInit, timeoutMs = 300000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
    });
    const json = (await response.json().catch(() => null)) as
      | { ok: true; data: T }
      | { ok: false; error: string }
      | null;
    if (!json) throw new Error("服务返回异常");
    if (!json.ok) throw new Error(json.error);
    return json.data;
  } finally {
    window.clearTimeout(timer);
  }
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function statusMeta(status: string, docCount: number) {
  if (status === "READY") return { cls: "ready", text: "已就绪" };
  if (status === "TRAINING") return { cls: "running", text: "训练中" };
  return { cls: "todo", text: docCount > 0 ? "待训练" : "待添加文件" };
}

function kindMeta(kind: string) {
  if (kind === "image") return { cls: "img", text: "图片" };
  if (kind === "rich") return { cls: "rich", text: "图文" };
  return { cls: "txt", text: "文本" };
}

function parseMeta(status: string) {
  if (status === "PARSED") return { cls: "ok", text: "已解析" };
  if (status === "FAILED") return { cls: "fail", text: "解析失败" };
  if (status === "EMPTY") return { cls: "warn", text: "无文字" };
  return { cls: "wait", text: "待解析" };
}

function highlightSegments(text: string, terms: string[]): Array<{ text: string; hit: boolean }> {
  const escaped = terms
    .filter((term) => term.length >= 2)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .slice(0, 12);
  if (escaped.length === 0) return [{ text, hit: false }];

  const re = new RegExp(`(${escaped.join("|")})`, "g");
  const parts = text.split(re).filter((part) => part !== "");
  return parts.map((part) => ({ text: part, hit: re.test(part) }));
}

function termsFromQuery(query: string): string[] {
  const flat = query.replace(/[，。！？、,.!?；;：:（）()\[\]【】"'`]/g, " ");
  return Array.from(new Set(flat.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2)));
}

/* -------------------------------- component ------------------------------- */

export default function KnowledgePanel({ resetToken = 0 }: { resetToken?: number }) {
  const [view, setView] = useState<"list" | "detail" | "search">("list");
  const [items, setItems] = useState<KbSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState<"all" | "ready" | "todo">("all");

  const [form, setForm] = useState<KbForm>(emptyForm);
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KbSummary | null>(null);

  const [detail, setDetail] = useState<KbDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const editTargetRef = useRef<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"hybrid" | "vector" | "bm25">("hybrid");
  const [searchTopK, setSearchTopK] = useState(5);
  const [searchThreshold, setSearchThreshold] = useState(0);
  const [searchScope, setSearchScope] = useState("all");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searchStats, setSearchStats] = useState<SearchStats | null>(null);
  const [searchMessage, setSearchMessage] = useState("");

  const loadList = useCallback(async () => {
    try {
      const data = await kbApi<{ knowledgeBases: KbSummary[] }>("/api/knowledge");
      setItems(data.knowledgeBases);
      setListError("");
    } catch (error) {
      setListError(error instanceof Error ? error.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // 点左侧「知识库」菜单时回到知识库列表页：即使正停在某个知识库详情、或检索测试页也要退出，
  // 并关掉可能开着的弹层。首次挂载（从其它分区切进来）跳过，避免重复刷新。
  const skipFirstResetRef = useRef(true);
  useEffect(() => {
    if (skipFirstResetRef.current) {
      skipFirstResetRef.current = false;
      return;
    }
    setView("list");
    setDetail(null);
    setStep(1);
    setNotice("");
    setFormMode(null);
    setDeleteTarget(null);
    setHits(null);
    setSearchStats(null);
    setSearchMessage("");
    void loadList();
  }, [resetToken, loadList]);

  // 训练/切片的假进度条，让等待过程可感知
  useEffect(() => {
    if (!busy) {
      setProgress(0);
      return;
    }
    setProgress(6);
    const timer = window.setInterval(() => {
      setProgress((value) => (value >= 93 ? value : value + Math.max(1, Math.round((93 - value) / 12))));
    }, 320);
    return () => window.clearInterval(timer);
  }, [busy]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const data = await kbApi<KbDetailPayload>(`/api/knowledge/${id}`);
      setDetail(data);
      return data;
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const stats = useMemo(() => {
    const documents = items.reduce((sum, item) => sum + item.documentCount, 0);
    const chunks = items.reduce((sum, item) => sum + item.trainedCount, 0);
    const todo = items.filter((item) => item.status !== "READY").length;
    return { total: items.length, documents, chunks, todo };
  }, [items]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === "ready" && item.status !== "READY") return false;
      if (filter === "todo" && item.status === "READY") return false;
      if (!kw) return true;
      return item.name.toLowerCase().includes(kw) || item.description.toLowerCase().includes(kw);
    });
  }, [items, keyword, filter]);

  /* --------------------------------- actions -------------------------------- */

  function openCreate() {
    setForm(emptyForm);
    setFormError("");
    setFormMode("create");
  }

  function openEdit(target: KbSummary) {
    setForm({
      name: target.name,
      description: target.description,
      vectorModel: target.vectorModel,
      chunkStrategy: target.chunkStrategy,
      chunkSize: target.chunkSize,
      chunkOverlap: target.chunkOverlap,
      visibility: target.visibility,
      topK: target.topK
    });
    setFormError("");
    setFormMode("edit");
  }

  async function submitForm() {
    if (!form.name.trim()) {
      setFormError("请填写知识库名称。");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const editId = formMode === "edit" ? editTargetRef.current ?? detail?.knowledgeBase.id ?? null : null;

      if (editId) {
        await kbApi(`/api/knowledge/${editId}`, { method: "PATCH", body: JSON.stringify(form) });
        await loadList();
        if (detail?.knowledgeBase.id === editId) await loadDetail(editId);
        setFormMode(null);
        setNotice("已保存知识库信息。");
      } else {
        const data = await kbApi<{ knowledgeBase: KbSummary }>("/api/knowledge", {
          method: "POST",
          body: JSON.stringify(form)
        });
        await loadList();
        setFormMode(null);
        setNotice(`知识库「${data.knowledgeBase.name}」已创建，去上传文件吧。`);
        await openDetail(data.knowledgeBase.id);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await kbApi(`/api/knowledge/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      setNotice("知识库已删除。");
      if (detail?.knowledgeBase.id === deleteTarget.id) {
        setDetail(null);
        setView("list");
      }
      await loadList();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败");
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(id: string) {
    setDetail(null);
    setStep(1);
    setNotice("");
    setView("detail");
    const data = await loadDetail(id);
    if (data && data.stats.chunkTotal === 0) setStep(data.documents.length > 0 ? 2 : 1);
    else if (data && data.stats.chunkTotal > 0 && data.stats.chunkTrained < data.stats.chunkEnabled) setStep(3);
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0 || !detail) return;
    setUploading(true);
    setNotice("");
    try {
      const body = new FormData();
      list.forEach((file) => body.append("files", file));
      const response = await fetch(`/api/knowledge/${detail.knowledgeBase.id}/documents`, { method: "POST", body });
      const json = (await response.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "上传失败");
      await loadDetail(detail.knowledgeBase.id);
      await loadList();
      setNotice(`已上传 ${list.length} 个文件，解析完成即可进入切片。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function removeDocument(documentId: string) {
    if (!detail) return;
    setBusy("正在删除文档");
    try {
      await kbApi(`/api/knowledge/${detail.knowledgeBase.id}/documents/${documentId}`, { method: "DELETE" });
      await loadDetail(detail.knowledgeBase.id);
      await loadList();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy("");
    }
  }

  async function runChunk() {
    if (!detail) return;
    setBusy("正在切片");
    setNotice("");
    try {
      const data = await kbApi<{ chunkCount: number }>(`/api/knowledge/${detail.knowledgeBase.id}/chunk`, {
        method: "POST",
        body: JSON.stringify({
          strategy: form.chunkStrategy,
          size: form.chunkSize,
          overlap: form.chunkOverlap
        })
      });
      await loadDetail(detail.knowledgeBase.id);
      await loadList();
      setNotice(`切片完成，共生成 ${data.chunkCount} 条切片。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "切片失败");
    } finally {
      setBusy("");
    }
  }

  async function runTrain() {
    if (!detail) return;
    setBusy("正在训练");
    setNotice("");
    try {
      const data = await kbApi<{ chunkCount: number; dimension: number; model: string; remote: boolean; durationMs: number }>(
        `/api/knowledge/${detail.knowledgeBase.id}/train`,
        { method: "POST" }
      );
      await loadDetail(detail.knowledgeBase.id);
      await loadList();
      setNotice(
        `训练完成：${data.chunkCount} 条切片 · ${data.dimension} 维 · ${data.remote ? "远端模型" : "本地向量"} ${data.model} · 耗时 ${(data.durationMs / 1000).toFixed(1)}s`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "训练失败");
    } finally {
      setBusy("");
    }
  }

  async function runSearch() {
    const query = searchQuery.trim();
    if (!query) {
      setNotice("请输入要检索的问题。");
      return;
    }
    setSearching(true);
    setSearchMessage("");
    try {
      const data = await kbApi<{ hits: SearchHit[]; stats: SearchStats; message?: string }>("/api/knowledge/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          mode: searchMode,
          topK: searchTopK,
          threshold: searchThreshold,
          scope: searchScope
        })
      });
      setHits(data.hits);
      setSearchStats(data.stats);
      setSearchMessage(data.message ?? "");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "检索失败");
    } finally {
      setSearching(false);
    }
  }

  /* --------------------------------- render -------------------------------- */

  const activeKb = detail?.knowledgeBase;

  return (
    <div className="kb-root">
      {view === "list" && (
        <div className="kb-page">
          <div className="kb-toolbar">
            <div className="kb-search">
              <span aria-hidden>⌕</span>
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索知识库名称 / 描述…"
              />
            </div>
            <div className="kb-seg">
              {([
                ["all", "全部"],
                ["ready", "已就绪"],
                ["todo", "需处理"]
              ] as const).map(([key, label]) => (
                <button key={key} className={filter === key ? "on" : ""} onClick={() => setFilter(key)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="kb-spacer" />
            <button className="kb-btn ghost" onClick={() => { setView("search"); setHits(null); setSearchStats(null); }}>
              <span aria-hidden>⌕</span> 检索测试
            </button>
            <button className="kb-btn primary" onClick={openCreate}>
              <span aria-hidden>＋</span> 新建知识库
            </button>
          </div>

          <div className="kb-stats">
            <div className="kb-stat"><div className="k">知识库总数</div><div className="v">{stats.total}<small>个</small></div></div>
            <div className="kb-stat"><div className="k">文档总数</div><div className="v">{stats.documents}<small>份</small></div></div>
            <div className="kb-stat"><div className="k">已训练切片</div><div className="v">{stats.chunks.toLocaleString()}<small>条</small></div></div>
            <div className="kb-stat"><div className="k">待处理</div><div className="v warn">{stats.todo}<small>个库</small></div></div>
          </div>

          {listError && <div className="kb-alert error">{listError}</div>}
          {notice && <div className="kb-alert">{notice}</div>}

          {loading ? (
            <div className="kb-empty">正在加载知识库…</div>
          ) : filtered.length === 0 ? (
            <div className="kb-empty-card">
              <div className="ic">＋</div>
              <b>还没有知识库</b>
              <p>把素材文档传进来，切片训练后 AI 员工写作时就能检索引用。</p>
              <button className="kb-btn primary" onClick={openCreate}>新建知识库</button>
            </div>
          ) : (
            <div className="kb-grid">
              {filtered.map((item) => {
                const meta = statusMeta(item.status, item.documentCount);
                return (
                  <article key={item.id} className="kb-card" onClick={() => void openDetail(item.id)}>
                    <div className="kb-card-top">
                      <div className="kb-ico">▤</div>
                      <div className="kb-card-name">{item.name}</div>
                      <span className={`kb-pill ${meta.cls}`}>{meta.text}</span>
                    </div>
                    <p className="kb-card-desc">{item.description || "暂无描述"}</p>
                    <div className="kb-chips">
                      <span className="kb-chip">{VECTOR_MODELS.find((m) => m.value === item.vectorModel)?.label.split("（")[0] ?? item.vectorModel}</span>
                      <span className="kb-chip">{item.chunkStrategy === "fixed" ? "固定长度切片" : "智能语义切片"}</span>
                    </div>
                    <div className="kb-card-foot">
                      <span>{item.documentCount} 份文档</span>
                      <span>{item.chunkCount} 条切片</span>
                      <span className="kb-time">{new Date(item.updatedAt).toLocaleDateString("zh-CN")}</span>
                    </div>
                    <div className="kb-card-ops">
                      <button
                        className="kb-icon-btn"
                        title="编辑"
                        onClick={(event) => {
                          event.stopPropagation();
                          editTargetRef.current = item.id;
                          openEdit(item);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className="kb-icon-btn danger"
                        title="删除"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDeleteTarget(item);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {view === "detail" && (
        <div className="kb-page">
          <button className="kb-back" onClick={() => { setView("list"); setDetail(null); void loadList(); }}>
            ← 返回知识库
          </button>

          {detailLoading || !activeKb ? (
            <div className="kb-empty">正在加载知识库详情…</div>
          ) : (
            <>
              <div className="kb-detail-head">
                <div className="kb-ico big">▤</div>
                <div className="kb-detail-title">
                  <div className="row">
                    <h3>{activeKb.name}</h3>
                    <span className={`kb-pill ${statusMeta(activeKb.status, detail!.documents.length).cls}`}>
                      {statusMeta(activeKb.status, detail!.documents.length).text}
                    </span>
                  </div>
                  <p>{activeKb.description || "暂无描述"}</p>
                </div>
                <button className="kb-btn ghost" onClick={() => { setForm({ ...emptyForm, ...activeKb } as KbForm); setFormError(""); setFormMode("edit"); }}>
                  ✎ 编辑信息
                </button>
              </div>

              <div className="kb-steps">
                {([[1, "上传文件"], [2, "切片"], [3, "训练"]] as const).map(([index, label], position) => (
                  <div key={index} className="kb-step-wrap">
                    <button
                      className={`kb-step ${step === index ? "active" : ""} ${step > index ? "done" : ""}`}
                      onClick={() => setStep(index)}
                    >
                      <span className="no">{step > index ? "✓" : index}</span>
                      <span className="lb">{label}</span>
                    </button>
                    {position < 2 && <span className={`kb-line ${step > index ? "on" : ""}`} />}
                  </div>
                ))}
              </div>

              {notice && <div className="kb-alert">{notice}</div>}

              {step === 1 && (
                <div className="kb-panel">
                  <div className="kb-panel-head">
                    <div>
                      <h4>上传文件</h4>
                      <p>支持文本（.txt/.md/.docx/.pdf）、图片（.png/.jpg/.webp）与图文（.docx 含图 / .zip）文件</p>
                    </div>
                  </div>

                  <div
                    className={`kb-drop ${dragging ? "dragging" : ""}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragging(false);
                      if (event.dataTransfer.files.length > 0) void uploadFiles(event.dataTransfer.files);
                    }}
                  >
                    <div className="ic">⇪</div>
                    <b>{uploading ? "正在上传并解析…" : "点击选择文件，或把文件拖到这里"}</b>
                    <span>单个文件不超过 30MB，可一次多选</span>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={ACCEPT_TYPES}
                    style={{ display: "none" }}
                    onChange={(event) => event.target.files && void uploadFiles(event.target.files)}
                  />

                  {detail!.documents.length > 0 && (
                    <div className="kb-doc-list">
                      {detail!.documents.map((doc) => {
                        const kind = kindMeta(doc.kind);
                        const parse = parseMeta(doc.parseStatus);
                        return (
                          <div key={doc.id} className="kb-doc-row">
                            <span className={`kb-kind ${kind.cls}`}>{kind.text}</span>
                            <div className="kb-doc-main">
                              <div className="kb-doc-name">{doc.filename}</div>
                              <div className="kb-doc-meta">{formatBytes(doc.sizeBytes)} · {doc.parseNote}</div>
                            </div>
                            <span className={`kb-tag ${parse.cls}`}>{parse.text}</span>
                            <span className="kb-doc-chunks">{doc.chunkCount} 条切片</span>
                            <button className="kb-icon-btn danger" title="移除" onClick={() => void removeDocument(doc.id)}>✕</button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="kb-step-foot">
                    <span className="hint">至少上传 1 个可解析的文本文件后才能切片</span>
                    <button className="kb-btn primary" disabled={detail!.documents.length === 0} onClick={() => setStep(2)}>
                      下一步：切片
                    </button>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="kb-panel">
                  <div className="kb-panel-head">
                    <div>
                      <h4>切片设置</h4>
                      <p>把文档切成更适合检索的小块，图片与图文会在解析后合并进切片</p>
                    </div>
                    <button className="kb-btn primary" disabled={Boolean(busy) || detail!.documents.length === 0} onClick={() => void runChunk()}>
                      {busy === "正在切片" ? "切片中…" : "开始切片"}
                    </button>
                  </div>

                  {busy === "正在切片" && <div className="kb-progress"><i style={{ width: `${progress}%` }} /></div>}

                  <div className="kb-form-grid">
                    <div className="kb-field">
                      <label>切片方式</label>
                      <div className="kb-radio-row">
                        <button className={`kb-radio ${form.chunkStrategy === "semantic" ? "on" : ""}`} onClick={() => setForm({ ...form, chunkStrategy: "semantic" })}>智能语义切片</button>
                        <button className={`kb-radio ${form.chunkStrategy === "fixed" ? "on" : ""}`} onClick={() => setForm({ ...form, chunkStrategy: "fixed" })}>固定长度切片</button>
                      </div>
                    </div>
                    <div className="kb-field">
                      <label>切片长度 <span>{form.chunkSize} 字</span></label>
                      <input type="range" min={200} max={1500} step={50} value={form.chunkSize}
                        onChange={(event) => setForm({ ...form, chunkSize: Number(event.target.value) })} />
                    </div>
                    <div className="kb-field">
                      <label>重叠长度 <span>{form.chunkOverlap} 字</span></label>
                      <input type="range" min={0} max={300} step={10} value={form.chunkOverlap}
                        onChange={(event) => setForm({ ...form, chunkOverlap: Number(event.target.value) })} />
                    </div>
                  </div>

                  <div className="kb-split">
                    <div className="kb-split-left">
                      <div className="kb-sub-head">
                        <b>切片预览</b>
                        <span>{detail!.stats.chunkTotal} 条</span>
                      </div>
                      {detail!.sampleChunks.length === 0 ? (
                        <div className="kb-empty small">还没有切片，点右上角「开始切片」</div>
                      ) : (
                        <div className="kb-chunk-list">
                          {detail!.sampleChunks.map((chunk) => (
                            <div key={chunk.id} className="kb-chunk">
                              <span className="kb-chunk-no">#{String(chunk.seq).padStart(3, "0")}</span>
                              <span className="kb-chunk-text">{chunk.content}</span>
                              <span className="kb-chunk-len">{chunk.charCount} 字</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="kb-step-foot">
                    <button className="kb-btn ghost" onClick={() => setStep(1)}>上一步</button>
                    <button className="kb-btn primary" disabled={detail!.stats.chunkTotal === 0} onClick={() => setStep(3)}>
                      下一步：训练
                    </button>
                  </div>
                </div>
              )}

              {step === 3 && (
                <div className="kb-panel">
                  <div className="kb-panel-head">
                    <div>
                      <h4>训练（向量化）</h4>
                      <p>把切片转成可检索的向量，训练完成后即可用于写作检索与检索测试</p>
                    </div>
                    <button className="kb-btn primary" disabled={Boolean(busy) || detail!.stats.chunkTotal === 0} onClick={() => void runTrain()}>
                      {busy === "正在训练" ? "训练中…" : detail!.stats.chunkTrained > 0 ? "重新训练" : "开始训练"}
                    </button>
                  </div>

                  {busy === "正在训练" && <div className="kb-progress"><i style={{ width: `${progress}%` }} /></div>}

                  <div className="kb-form-grid">
                    <div className="kb-field">
                      <label>向量模型</label>
                      <select value={form.vectorModel} onChange={(event) => setForm({ ...form, vectorModel: event.target.value })}>
                        {VECTOR_MODELS.map((model) => (
                          <option key={model.value} value={model.value}>{model.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="kb-field">
                      <label>默认召回条数 TopK <span>{form.topK}</span></label>
                      <input type="range" min={1} max={10} value={form.topK}
                        onChange={(event) => setForm({ ...form, topK: Number(event.target.value) })} />
                    </div>
                  </div>

                  <div className="kb-train-stats">
                    <div><span>切片总数</span><b>{detail!.stats.chunkTotal}</b></div>
                    <div><span>已向量化</span><b>{detail!.stats.chunkTrained}</b></div>
                    <div><span>参与训练</span><b>{detail!.stats.chunkEnabled}</b></div>
                    <div><span>索引状态</span><b>{detail!.stats.chunkTrained >= detail!.stats.chunkEnabled && detail!.stats.chunkEnabled > 0 ? "已就绪" : "待训练"}</b></div>
                  </div>

                  <div className="kb-step-foot">
                    <button className="kb-btn ghost" onClick={() => setStep(2)}>上一步</button>
                    <button className="kb-btn ghost" onClick={() => { setView("list"); setDetail(null); void loadList(); }}>
                      完成，返回列表
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {view === "search" && (
        <div className="kb-page">
          <button className="kb-back" onClick={() => { setView("list"); setHits(null); setSearchStats(null); }}>
            ← 返回知识库
          </button>

          <div className="kb-detail-head">
            <div className="kb-ico big">⌕</div>
            <div className="kb-detail-title">
              <div className="row"><h3>知识库检索测试</h3></div>
              <p>对当前账号全部知识库做召回测试，看看 AI 员工写作时会命中哪些片段、相似度多高。</p>
            </div>
          </div>

          {notice && <div className="kb-alert">{notice}</div>}

          <div className="kb-split search">
            <div className="kb-search-form">
              <label className="kb-label">问题</label>
              <textarea
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="输入一个真实问题，例如：爆款标题怎么起？"
              />

              <label className="kb-label">检索方式</label>
              <div className="kb-radio-row">
                <button className={`kb-radio ${searchMode === "hybrid" ? "on" : ""}`} onClick={() => setSearchMode("hybrid")}>向量 + 关键词</button>
                <button className={`kb-radio ${searchMode === "vector" ? "on" : ""}`} onClick={() => setSearchMode("vector")}>纯向量</button>
                <button className={`kb-radio ${searchMode === "bm25" ? "on" : ""}`} onClick={() => setSearchMode("bm25")}>关键词</button>
              </div>

              <label className="kb-label">检索范围</label>
              <select value={searchScope} onChange={(event) => setSearchScope(event.target.value)}>
                <option value="all">全部知识库（{items.length}）</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>

              <label className="kb-label">召回条数 TopK <span>{searchTopK}</span></label>
              <input type="range" min={1} max={10} value={searchTopK} onChange={(event) => setSearchTopK(Number(event.target.value))} />

              <label className="kb-label">相似度阈值 <span>{searchThreshold.toFixed(2)}</span></label>
              <input type="range" min={0} max={0.9} step={0.05} value={searchThreshold}
                onChange={(event) => setSearchThreshold(Number(event.target.value))} />

              <button className="kb-btn primary block" disabled={searching} onClick={() => void runSearch()}>
                {searching ? "检索中…" : "开始检索"}
              </button>
            </div>

            <div className="kb-results">
              {hits === null ? (
                <div className="kb-empty small">输入问题后点击「开始检索」，这里会展示召回的切片与相似度。</div>
              ) : hits.length === 0 ? (
                <div className="kb-empty small error">
                  {searchMessage || `没有召回任何片段，当前阈值 ${searchThreshold.toFixed(2)} 偏高，可下调阈值或补充文档。`}
                </div>
              ) : (
                <>
                  <div className="kb-result-sum">
                    <b>命中 {hits.length} 条</b>
                    {searchStats && (
                      <span>
                        耗时 <b>{searchStats.took} ms</b> · 最高相似度 <b>{searchStats.max.toFixed(2)}</b> · 平均 <b>{searchStats.avg.toFixed(2)}</b>
                        {searchStats.kbCount > 1 ? ` · 来自 ${searchStats.kbCount} 个知识库` : ""}
                        {searchStats.atTopK ? " · 已达 TopK 上限" : ""}
                      </span>
                    )}
                  </div>
                  {hits.map((hit, index) => (
                    <div key={hit.chunkId} className="kb-result-card">
                      <div className="kb-result-top">
                        <span className={`kb-rank ${index === 0 ? "top" : ""}`}>{index + 1}</span>
                        <span className="kb-result-src">
                          <span className="kb-kb-tag">{hit.knowledgeBaseName}</span>
                          📄 {hit.filename} <span className="loc">· 切片 #{String(hit.seq).padStart(3, "0")}</span>
                        </span>
                        <span className="kb-score">
                          <span className="kb-score-bar"><i style={{ width: `${Math.round(hit.score * 100)}%` }} /></span>
                          <span className="kb-score-val">{hit.score.toFixed(2)}</span>
                        </span>
                      </div>
                      <div className="kb-result-body">
                        {highlightSegments(hit.content, termsFromQuery(searchQuery)).map((segment, segmentIndex) =>
                          segment.hit ? <mark key={segmentIndex}>{segment.text}</mark> : <span key={segmentIndex}>{segment.text}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {formMode && (
        <div className="kb-modal-overlay" onClick={() => !saving && setFormMode(null)}>
          <div className="kb-modal" onClick={(event) => event.stopPropagation()}>
            <div className="kb-modal-head">
              <h4>{formMode === "create" ? "新建知识库" : "编辑知识库"}</h4>
              <button className="kb-icon-btn" onClick={() => setFormMode(null)}>✕</button>
            </div>
            <div className="kb-modal-body">
              <div className="kb-field">
                <label>名称</label>
                <input value={form.name} maxLength={60} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：银发内容素材库" />
              </div>
              <div className="kb-field">
                <label>描述</label>
                <textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="这个知识库收纳什么内容，供什么场景检索" />
              </div>
              <div className="kb-field">
                <label>向量模型</label>
                <select value={form.vectorModel} onChange={(event) => setForm({ ...form, vectorModel: event.target.value })}>
                  {VECTOR_MODELS.map((model) => (
                    <option key={model.value} value={model.value}>{model.label}</option>
                  ))}
                </select>
              </div>
              <div className="kb-field">
                <label>切片策略</label>
                <div className="kb-radio-row">
                  <button className={`kb-radio ${form.chunkStrategy === "semantic" ? "on" : ""}`} onClick={() => setForm({ ...form, chunkStrategy: "semantic" })}>智能语义</button>
                  <button className={`kb-radio ${form.chunkStrategy === "fixed" ? "on" : ""}`} onClick={() => setForm({ ...form, chunkStrategy: "fixed" })}>固定长度</button>
                </div>
              </div>
              <div className="kb-form-grid">
                <div className="kb-field">
                  <label>切片长度</label>
                  <input type="number" min={120} max={2000} value={form.chunkSize}
                    onChange={(event) => setForm({ ...form, chunkSize: Number(event.target.value) })} />
                </div>
                <div className="kb-field">
                  <label>重叠长度</label>
                  <input type="number" min={0} max={600} value={form.chunkOverlap}
                    onChange={(event) => setForm({ ...form, chunkOverlap: Number(event.target.value) })} />
                </div>
                <div className="kb-field">
                  <label>可见范围</label>
                  <select value={form.visibility} onChange={(event) => setForm({ ...form, visibility: event.target.value })}>
                    <option value="private">仅自己可见</option>
                    <option value="team">团队可见</option>
                  </select>
                </div>
                <div className="kb-field">
                  <label>默认 TopK</label>
                  <input type="number" min={1} max={20} value={form.topK}
                    onChange={(event) => setForm({ ...form, topK: Number(event.target.value) })} />
                </div>
              </div>
              {formError && <div className="kb-alert error">{formError}</div>}
            </div>
            <div className="kb-modal-foot">
              <button className="kb-btn ghost" onClick={() => setFormMode(null)} disabled={saving}>取消</button>
              <button className="kb-btn primary" onClick={() => void submitForm()} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="kb-modal-overlay" onClick={() => !saving && setDeleteTarget(null)}>
          <div className="kb-modal small" onClick={(event) => event.stopPropagation()}>
            <div className="kb-modal-head">
              <h4>删除知识库</h4>
              <button className="kb-icon-btn" onClick={() => setDeleteTarget(null)}>✕</button>
            </div>
            <div className="kb-modal-body">
              <p className="kb-danger-text">确定删除「{deleteTarget.name}」吗？该知识库下的
                {deleteTarget.documentCount} 份文档与 {deleteTarget.chunkCount} 条切片会一并删除，且不可恢复。</p>
            </div>
            <div className="kb-modal-foot">
              <button className="kb-btn ghost" onClick={() => setDeleteTarget(null)} disabled={saving}>取消</button>
              <button className="kb-btn danger" onClick={() => void confirmDelete()} disabled={saving}>
                {saving ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
