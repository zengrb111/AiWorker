"use client";

/**
 * 「图生视频」面板（huashu-motion 链路）。
 *
 * 与旧的「参考图 / 参考文章」双 Tab 面板的区别：
 * - 只剩一条链路：产品网站（可选）+ 参考图（可选）+ 创作需求 → 直接出片；
 * - 出片由 DSH 里的 huashu-motion 技能完成（HTML+GSAP），不是平台自己的分镜管线；
 * - 成片后可以在 Studio 里点画面改：打开 Studio → 写完评论 → 回来点「同步修改」→「重新出片」。
 *
 * 为什么单独一个组件：原来那块 JSX 400 多行，混在 platform-client 里既难读也容易误改
 * 旧管线的状态。这里只依赖 conversationId 与两个回调，边界清楚。
 */

import { useEffect, useRef, useState } from "react";

type Props = {
  conversationId: string;
  /** 默认创作需求（沿用原来的「生成ai回忆录宣传片」）。 */
  defaultRequirement: string;
  onClose: () => void;
  /** 出片成功并入库后通知外层刷新内容库。 */
  onSaved?: () => void | Promise<void>;
};

type Phase = "form" | "running" | "done";


export default function HuashuVideoPanel({ conversationId, defaultRequirement, onClose, onSaved }: Props) {
  const [siteUrl, setSiteUrl] = useState("");
  const [requirement, setRequirement] = useState(defaultRequirement);
  const [images, setImages] = useState<Array<{ file: File; url: string }>>([]);
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

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const canSubmit = requirement.trim().length > 0 && (siteUrl.trim().length > 0 || images.length > 0);

  function addImages(files: FileList | null) {
    if (!files?.length) return;
    setImages((previous) => [
      ...previous,
      ...Array.from(files).map((file) => ({ file, url: URL.createObjectURL(file) }))
    ]);
  }

  function removeImage(index: number) {
    setImages((previous) => {
      const target = previous[index];
      if (target) URL.revokeObjectURL(target.url);
      return previous.filter((_, i) => i !== index);
    });
  }

  async function submit() {
    if (!canSubmit || phase === "running") return;
    setPhase("running");
    setError("");
    setProgress([]);
    setVideoUrl(null);
    setProjectToken(null);
    setDuration(null);
    setStudioUrl(null);

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
            if (data.contentSaved) void onSaved?.();
          } else if (data.type === "error") {
            throw new Error(data.error || "视频生成失败。");
          }
        }
      }
      setPhase((current) => (current === "done" ? current : "done"));
    } catch (submitError) {
      if (controller.signal.aborted) {
        setError("已中断。");
      } else {
        setError(submitError instanceof Error ? submitError.message : "视频生成失败。");
      }
      setPhase("form");
    } finally {
      abortRef.current = null;
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

  return (
    <div className="viral-remake-panel">
      <div className="viral-remake-title">一键生成视频</div>
      <p>
        填产品网站让 AI 抓真实素材，也可以只传参考图。点生成后由 AI 直接写片、配乐、渲染，
        成片竖版 1080×1920、20 秒以内；不满意可以打开 Studio 点着画面改。
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
            : "产品网站与参考图至少填一个"
          : `参考图 ${images.length} 张${siteUrl.trim() ? " + 产品网站" : ""}（点缩略图看大图）`}
      </div>

      <label className="viral-remake-file" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        整体创作需求（作为产品名称）
        <textarea
          value={requirement}
          onChange={(event) => setRequirement(event.target.value)}
          placeholder="例如：AI 回忆录，帮普通人把父母的故事做成一本可导出的书"
          disabled={phase === "running"}
          style={{
            minHeight: 84,
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

      <div className="gen-video-engine-hint">成片固定竖版 1080×1920、时长 20 秒以内；风格与配乐由 AI 按产品调性自选。</div>

      {phase === "running" && (
        <div className="gen-video-plan-loading" style={{ marginTop: 10 }}>
          <span className="video-preparing-dot" />
          <span>正在创作：抓素材 → AI 写片 → 自检 → 渲染，通常 5~15 分钟，可以切到别的会话等。</span>
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
          </div>
          {notice && <div className="viral-remake-summary">{notice}</div>}
          <div className="gen-video-engine-hint">
            Studio 里提交的评论会<strong>自动</strong>改片并出新版（约 30 秒内接单），进度会显示在会话里，不用回来点按钮。
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
