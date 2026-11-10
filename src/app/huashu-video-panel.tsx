"use client";

/**
 * 「图生视频」面板（huashu-motion 链路）。
 *
 * 结构（2026-10-24 重构）：
 * - `useHuashuVideoPanel()`：所有状态 + 提交/SSE/Studio 动作。它被 platform-client
 *   顶层调用（常驻不卸载），所以**切模块/切会话时面板从 DOM 消失，但状态与
 *   生成流都活着**——切回来原样继续，不会再被打回初始状态。
 * - 默认导出的 `HuashuVideoPanel`：纯展示组件，在对话输入区内联渲染。
 *
 * 链路说明：产品网站（可选）+ 参考图（可选）+ 创作需求 → huashu-motion 直接出片
 * （HTML+GSAP，非平台分镜管线）；成片后可打开 Studio 点画面改。
 */

import { useRef, useState } from "react";

type Phase = "form" | "running" | "done";

export type HuashuPanelImage = { file: File; url: string };

export type HuashuPanelController = {
  // 表单
  siteUrl: string;
  setSiteUrl: (value: string) => void;
  requirement: string;
  setRequirement: (value: string) => void;
  images: HuashuPanelImage[];
  addImages: (files: FileList | null) => void;
  removeImage: (index: number) => void;
  /** 外部直接灌入图片（热点流程已备好带 objectURL 的素材）。 */
  setImagesFromFiles: (files: HuashuPanelImage[]) => void;
  /** 清空全部状态回到初始；nextRequirement 作为新的创作需求（不传=清空）。
   *  overrides.siteUrl 可指定网站字段的初始值：知识库带分镜脚本过来时要传空串，
   *  否则会带着默认官网去抓素材，跟「按分镜脚本出片」冲突。 */
  reset: (nextRequirement?: string, overrides?: { siteUrl?: string }) => void;
  // 运行状态
  phase: Phase;
  progress: string[];
  error: string;
  videoUrl: string | null;
  projectToken: string | null;
  duration: number | null;
  studioUrl: string | null;
  busy: "" | "studio";
  notice: string;
  preview: string | null;
  setPreview: (value: string | null) => void;
  canSubmit: boolean;
  /** 手动同步：把项目当前版本回写到会话里的视频 / 内容库。 */
  syncTo: (targets: HuashuSyncTarget[]) => Promise<void>;
  syncing: "" | HuashuSyncTarget;
  syncNotice: string;
  // 动作
  submit: () => Promise<void>;
  openStudio: () => Promise<void>;
};

/** 同步目标：会话里那条视频消息 / 内容库条目。 */
export type HuashuSyncTarget = "conversation" | "content";

/**
 * 面板状态钩子。必须在常驻组件（platform-client）顶层调用。
 *
 * getConversationId 用 getter 是故意的：提交那一刻才解析归属会话
 * （platform-client 里它是 genVideoPanelFor，会随「在哪个会话点开」变化）。
 */
/**
 * 面板默认值：打开就能直接点「开始生成」（2026-10-30 要求）。
 * 用户仍可随时改；改过之后按用户输入走，不会每次重置。
 * 导出供 platform-client 复用，避免两处各写一套默认文案。
 *
 * 2026-11-01：本地与线上区分
 * - 线上（生产构建）维持「5s」短版：官网演示要秒开的短样片，长片会拖慢演示节奏。
 * - 本地开发（next dev）不写时长：targetSeconds=null，DSH 按内容自然展开，方便调长片。
 * 判定用 NODE_ENV：`next dev` = development，`next build` 产物 = production。
 * 二者都会被构建期替换成字面量 true/false（不会在浏览器里访问 process），所以安全。
 */
const DEFAULT_REQUIREMENT_PROD = "生成ai回忆录宣传片，5s";
const DEFAULT_REQUIREMENT_DEV = "生成ai回忆录宣传片";

export const DEFAULT_HUASHU_SITE_URL = "https://aimemory.cafe/";
export const DEFAULT_HUASHU_REQUIREMENT =
  process.env.NODE_ENV === "production" ? DEFAULT_REQUIREMENT_PROD : DEFAULT_REQUIREMENT_DEV;

export function useHuashuVideoPanel(options: {
  getConversationId: () => string | null;
  onSaved?: () => void | Promise<void>;
}): HuashuPanelController {
  const [siteUrl, setSiteUrl] = useState(DEFAULT_HUASHU_SITE_URL);
  const [requirement, setRequirement] = useState(DEFAULT_HUASHU_REQUIREMENT);
  const [images, setImages] = useState<HuashuPanelImage[]>([]);
  const [phase, setPhase] = useState<Phase>("form");
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [projectToken, setProjectToken] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);

  const [studioUrl, setStudioUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "studio">("");
  const [notice, setNotice] = useState("");
  const [syncing, setSyncing] = useState<"" | HuashuSyncTarget>("");
  const [syncNotice, setSyncNotice] = useState("");

  // options 用 ref 存：回调体在调用时才解引用，避免渲染期 TDZ / 闭包过期。
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 能不能提交。
   *
   * 除了「有网站或有参考图」，还允许**纯分镜脚本**：知识库 Wiki 的「一键生成视频」
   * 带过来的需求是「标题 + 镜头/画面/口播」，本来就没有网站和图，硬卡素材
   * 会让用户以为功能坏了。判定就认「镜头 N」这种行首标记。
   */
  const hasStoryboard = /^镜头\s*\d+/m.test(requirement);
  const canSubmit =
    requirement.trim().length > 0 &&
    (hasStoryboard || siteUrl.trim().length > 0 || images.length > 0);

  function addImages(files: FileList | null) {
    if (!files?.length) return;
    setImages((previous) => [
      ...previous,
      ...Array.from(files).map((file) => ({ file, url: URL.createObjectURL(file) }))
    ]);
  }

  function setImagesFromFiles(files: HuashuPanelImage[]) {
    setImages(files);
  }

  function removeImage(index: number) {
    setImages((previous) => {
      const target = previous[index];
      if (target) URL.revokeObjectURL(target.url);
      return previous.filter((_, i) => i !== index);
    });
  }

  function reset(
    nextRequirement = DEFAULT_HUASHU_REQUIREMENT,
    overrides?: { siteUrl?: string }
  ) {
    for (const item of images) URL.revokeObjectURL(item.url);
    setImages([]);
    // 重置回默认值（而不是清空）：出片后再次打开面板依然能直接点「开始生成」
    setSiteUrl(overrides?.siteUrl ?? DEFAULT_HUASHU_SITE_URL);
    setRequirement(nextRequirement);
    setPhase("form");
    setProgress([]);
    setError("");
    setVideoUrl(null);
    setProjectToken(null);
    setDuration(null);
    setStudioUrl(null);
    setBusy("");
    setNotice("");
    setSyncing("");
    setSyncNotice("");
    setPreview(null);
  }

  async function submit() {
    const conversationId = optionsRef.current.getConversationId();
    if (!conversationId || !canSubmit || phase === "running") return;
    setPhase("running");
    setError("");
    setProgress([]);
    setVideoUrl(null);
    setProjectToken(null);
    setDuration(null);
    setStudioUrl(null);
    setNotice("");
    setSyncNotice("");

    // 兜底：上一条流还挂着（理论上 running 期间进不来）就掐掉，避免两条流互写状态。
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const form = new FormData();
      if (siteUrl.trim()) form.append("siteUrl", siteUrl.trim());
      form.append("requirement", requirement.trim());
      for (const item of images) form.append("image", item.file);

      const response = await fetch(`/api/conversations/${conversationId}/gen-video/huashu`, {
        method: "POST",
        body: form,
        signal: controller.signal
      });
      if (!response.ok) {
        const raw = await response.text();
        let message = `请求失败（HTTP ${response.status}）。`;
        try {
          const payload = JSON.parse(raw) as { ok?: boolean; error?: string };
          if (payload?.error) message = payload.error;
        } catch {
          const head = raw.replace(/\s+/g, " ").trim().slice(0, 160);
          if (head) message += ` ${head}`;
        }
        throw new Error(message);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("没有拿到进度流。");
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const data = JSON.parse(line.slice(6)) as {
            type: string;
            text?: string;
            error?: string;
            videoUrl?: string;
            projectToken?: string;
            duration?: number | null;
            contentSaved?: { id: string };
          };
          if (data.type === "delta" && data.text) {
            setProgress((previous) => [...previous, data.text!.trim()]);
          } else if (data.type === "final") {
            setVideoUrl(data.videoUrl || null);
            setProjectToken(data.projectToken || null);
            setDuration(data.duration ?? null);
            setPhase("done");
            if (data.contentSaved) void optionsRef.current.onSaved?.();
          } else if (data.type === "error") {
            throw new Error(data.error || "视频生成失败。");
          }
        }
      }
      setPhase((current) => (current === "done" ? current : "done"));
    } catch (submitError) {
      if (controller.signal.aborted) {
        // 被新一条生成顶掉或显式重置：不打扰用户，静默让位。
        if (abortRef.current !== controller) return;
        setError("已中断。");
      } else {
        setError(submitError instanceof Error ? submitError.message : "视频生成失败。");
      }
      setPhase("form");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  async function openStudio() {
    if (!projectToken) return;
    setBusy("studio");
    setNotice("");
    try {
      const res = await fetch(`/api/video-motion/${projectToken}/studio`, { method: "POST" });
      const payload = (await res.json()) as { ok?: boolean; data?: { url?: string }; error?: string };
      if (!res.ok || !payload?.data?.url) throw new Error(payload?.error || "Studio 启动失败。");
      setStudioUrl(payload.data.url);
      window.open(payload.data.url, "_blank", "noopener,noreferrer");
      setNotice("Studio 已打开：在画面上按 C 点一下、写下要改什么。");
    } catch (studioError) {
      setNotice(studioError instanceof Error ? studioError.message : "Studio 启动失败。");
    } finally {
      setBusy("");
    }
  }

  /**
   * 把「项目当前版本」同步到会话里的视频 / 内容库。
   *
   * 为什么要手动：Studio 改片会自动出新版，但那只是工作副本。用户可能连改几版才满意，
   * 自动回写会把聊天里那条视频和已发布的内容库条目一起刷成半成品。
   */
  async function syncTo(targets: HuashuSyncTarget[]) {
    if (!projectToken || syncing) return;
    setSyncing(targets[0]);
    setSyncNotice("");
    try {
      const res = await fetch(`/api/video-motion/${projectToken}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets })
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        error?: string;
        data?: {
          videoUrl?: string;
          version?: number | null;
          contentFound?: number;
          contentUpdated?: number;
          messagesFound?: number;
          messagesUpdated?: number;
        };
      };
      if (!res.ok || !payload?.ok || !payload.data) throw new Error(payload?.error || "同步失败。");
      const data = payload.data;
      const label = data.version ? `v${data.version}` : "当前版本";
      if (data.videoUrl) setVideoUrl(data.videoUrl);
      if (targets.includes("conversation")) {
        if (!data.messagesFound) {
          setSyncNotice("会话里没找到这条视频的消息——它可能是手动出片的，没有对应的对话记录。");
        } else if (!data.messagesUpdated) {
          setSyncNotice(`会话里的视频已经是最新版（${label}），不用再同步。`);
        } else {
          setSyncNotice(`已把 ${label} 同步到会话里的视频（${data.messagesUpdated} 条消息）。`);
        }
      }
      if (targets.includes("content")) {
        if (!data.contentFound) {
          setSyncNotice("内容库里没有这条视频的条目——只有从对话里一键生成、自动入库的片子才有。");
        } else if (!data.contentUpdated) {
          setSyncNotice(`内容库已经是最新版（${label}），不用再同步。`);
        } else {
          setSyncNotice(`已把 ${label} 同步到内容库（${data.contentUpdated} 条），封面按新开场重抽了。`);
        }
      }
      void optionsRef.current.onSaved?.();
    } catch (syncError) {
      setSyncNotice(syncError instanceof Error ? syncError.message : "同步失败。");
    } finally {
      setSyncing("");
    }
  }

  return {
    siteUrl, setSiteUrl,
    requirement, setRequirement,
    images, addImages, removeImage, setImagesFromFiles, reset,
    phase, progress, error, videoUrl, projectToken, duration,
    studioUrl, busy, notice, preview, setPreview, canSubmit,
    syncing, syncNotice,
    submit, openStudio, syncTo
  };
}

type PanelProps = {
  panel: HuashuPanelController;
  onClose: () => void;
};

export default function HuashuVideoPanel({ panel, onClose }: PanelProps) {
  const {
    siteUrl, setSiteUrl, requirement, setRequirement, images, addImages, removeImage,
    phase, progress, error, videoUrl, duration, studioUrl, busy, notice, preview,
    setPreview, canSubmit, submit, openStudio, syncing, syncNotice, syncTo
  } = panel;

  /** 需求里带了分镜脚本（知识库带过来的），此时不需要产品网站/参考图。 */
  const storyboardFilled = /^镜头\s*\d+/m.test(requirement);

  return (
    <div className="viral-remake-panel">
      <div className="viral-remake-title">一键生成视频</div>
      <p>
        填产品网站让 AI 抓真实素材，也可以只传参考图。点生成后由 AI 直接写片、配乐、渲染，
        成片竖版 1080×1920；时长按你的创作需求来（提示词里写「30 秒」「1 分钟」就用它，
        不写就不限制，AI 按内容自然展开），不满意可以打开 Studio 点着画面改。
      </p>

      <label className="viral-remake-file" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        产品网站（可选）
        <input
          type="text"
          value={siteUrl}
          onChange={(event) => setSiteUrl(event.target.value)}
          placeholder="https://aimemory.cafe —— 填了会抓真实截图、logo、配色与字体"
          disabled={phase === "running"}
          style={{ border: "1px solid var(--line)", borderRadius: 7, padding: "8px 10px", fontSize: 12 }}
        />
      </label>

      <label className="viral-remake-file">
        参考图（可选，可多选）
        <input
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => addImages(event.target.files)}
          disabled={phase === "running"}
        />
      </label>
      <div className="gen-video-thumbs">
        {images.map((item, index) => (
          <div className="gen-video-thumb" key={item.url}>
            <img src={item.url} alt={item.file.name} title={item.file.name} onClick={() => setPreview(item.url)} />
            <button type="button" className="gen-video-thumb-remove" onClick={() => removeImage(index)} aria-label="删除这张图">
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="viral-remake-summary">
        {images.length === 0
          ? siteUrl.trim()
            ? "只依据产品网站创作"
            : storyboardFilled
              ? "已按分镜脚本生成，无需产品网站或参考图"
              : "产品网站与参考图至少填一个"
          : `参考图 ${images.length} 张${siteUrl.trim() ? " + 产品网站" : ""}（点缩略图看大图）`}
      </div>

      <label className="viral-remake-file" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        整体创作需求（首行作为视频标题）
        <textarea
          value={requirement}
          onChange={(event) => setRequirement(event.target.value)}
          placeholder="例如：AI 回忆录，帮普通人把父母的故事做成一本可导出的书"
          disabled={phase === "running"}
          style={{
            // 知识库带来的需求是「标题 + 分镜脚本」，动辄十几行；
            // 固定 84px 只能看到镜头 1，用户以为没填全，所以按行数撑开（上限 460）。
            minHeight: Math.min(460, Math.max(84, requirement.split("\n").length * 21 + 30)),
            resize: "vertical",
            border: "1px solid var(--line)",
            borderRadius: 7,
            padding: "8px 10px",
            fontSize: 12,
            fontFamily: "inherit",
            lineHeight: 1.6
          }}
        />
      </label>

      <div className="gen-video-engine-hint">成片固定竖版 1080×1920；时长以创作需求为准（不写时长 AI 按内容自然展开），风格与配乐由 AI 按产品调性自选。</div>

      {phase === "running" && (
        <div className="gen-video-plan-loading" style={{ marginTop: 10 }}>
          <span className="video-preparing-dot" />
          <span>正在创作：抓素材 → AI 写片 → 自检 → 渲染，通常 5~15 分钟。可以切到别的模块或会话，回来进度还在。</span>
        </div>
      )}

      {progress.length > 0 && (
        <div className="viral-remake-summary" style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, marginTop: 8 }}>
          {progress.map((line, index) => (
            <div key={`${index}-${line.slice(0, 8)}`}>· {line}</div>
          ))}
        </div>
      )}

      {error && <div className="viral-remake-summary" style={{ color: "var(--danger)" }}>{error}</div>}

      {videoUrl && (
        <div style={{ marginTop: 12 }}>
          <video
            key={videoUrl}
            src={videoUrl}
            controls
            playsInline
            style={{ width: "100%", maxWidth: 300, borderRadius: 10, background: "#000" }}
          />
          <div className="viral-remake-summary">
            成片已生成{duration ? ` · ${duration.toFixed(1)} 秒` : ""} ·{" "}
            <a href={videoUrl} target="_blank" rel="noreferrer">
              新窗口打开
            </a>
          </div>

          <div className="viral-remake-summary" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            <button type="button" onClick={() => void openStudio()} disabled={busy !== ""}>
              {busy === "studio" ? "正在启动 Studio…" : studioUrl ? "再次打开 Studio" : "在 Studio 里修改"}
            </button>
            <button type="button" onClick={() => void syncTo(["conversation"])} disabled={syncing !== ""}>
              {syncing === "conversation" ? "同步中…" : "同步修改到视频"}
            </button>
            <button type="button" onClick={() => void syncTo(["content"])} disabled={syncing !== ""}>
              {syncing === "content" ? "同步中…" : "同步修改到内容库"}
            </button>
          </div>
          {notice && <div className="viral-remake-summary">{notice}</div>}
          {syncNotice && <div className="viral-remake-summary">{syncNotice}</div>}
          <div className="gen-video-engine-hint">
            Studio 里提交的评论会<strong>自动改片出新版</strong>（约 30 秒内接单，进度显示在会话里），
            但<strong>不会</strong>自动改会话里的视频和内容库——确认这版可以后，点上面
            「同步修改到视频」/「同步修改到内容库」再发布出去。
          </div>
        </div>
      )}

      <div className="viral-remake-actions">
        <button type="button" onClick={onClose} disabled={phase === "running"}>
          关闭
        </button>
        {phase !== "done" && (
          <button type="button" disabled={!canSubmit || phase === "running"} onClick={() => void submit()}>
            {phase === "running" ? "生成中…" : "生成视频"}
          </button>
        )}
        {phase === "done" && videoUrl && (
          <button type="button" onClick={() => void submit()} disabled={busy !== ""}>
            用同一组素材再做一条
          </button>
        )}
      </div>

      {preview && (
        <div className="gen-video-lightbox" onClick={() => setPreview(null)}>
          <img src={preview} alt="参考图预览" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
