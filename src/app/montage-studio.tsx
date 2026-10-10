"use client";

import { useRef, useState } from "react";

type StreamEvent = {
  type: string;
  text?: string;
  videoUrl?: string;
  error?: string;
};

/**
 * OpenMontage 独立工作台。
 * 提供「一键剪辑」（上传原视频自动加字幕/调色/配乐/片头）与
 * 「视频二创」（参考视频 + 素材，按参考节奏合成竖版成片）两个入口。
 * 这两个能力由本地 OpenMontage Python 工程（ffmpeg + tools/）驱动，无需 OpenClaw。
 */

function parseStream(buffer: string): { events: StreamEvent[]; rest: string } {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() || "";
  const events: StreamEvent[] = [];
  for (const block of blocks) {
    const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    try {
      events.push(JSON.parse(dataLine.slice(6)) as StreamEvent);
    } catch {
      // 忽略不完整的 JSON
    }
  }
  return { events, rest };
}

export default function MontageStudio() {
  const [tab, setTab] = useState<"montage" | "remake">("montage");

  // 一键剪辑
  const [montageFile, setMontageFile] = useState<File | null>(null);

  // 视频二创
  const [referenceUrl, setReferenceUrl] = useState("");
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [materials, setMaterials] = useState<File[]>([]);

  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  const abortRef = useRef<AbortController | null>(null);

  async function ensureConversation(): Promise<string> {
    const list = await fetch("/api/conversations").then((response) => response.json());
    if (list?.ok && list.data?.conversations?.length) {
      return list.data.conversations[0].id as string;
    }
    const created = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then((response) => response.json());
    return created.data.conversation.id as string;
  }

  async function consume(response: Response, onDelta: (text: string) => void): Promise<string | null> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("未返回进度流。");
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseStream(buffer);
      buffer = rest;
      for (const event of events) {
        if (event.type === "delta" && event.text) onDelta(event.text);
        else if (event.type === "final") return event.videoUrl ?? null;
        else if (event.type === "error") throw new Error(event.error || "处理失败。");
      }
    }
    return null;
  }

  async function runMontage() {
    if (!montageFile || sending) return;
    setSending(true);
    setProgress([]);
    setVideoUrl(null);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const conversationId = await ensureConversation();
      const form = new FormData();
      form.append("video", montageFile);
      const response = await fetch(`/api/conversations/${conversationId}/montage`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: "视频剪辑请求失败。" }))) as {
          error?: string;
        };
        throw new Error(payload.error || "视频剪辑请求失败。");
      }
      const url = await consume(response, (text) => setProgress((previous) => [...previous, text.trim()]));
      if (url) setVideoUrl(url);
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "视频剪辑失败。");
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  async function runRemake() {
    if (sending) return;
    if (!referenceUrl.trim() && !referenceFile) {
      setError("请填写参考视频链接或上传参考视频。");
      return;
    }
    if (!materials.length) {
      setError("请至少上传一个制作素材。");
      return;
    }
    setSending(true);
    setProgress([]);
    setVideoUrl(null);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const conversationId = await ensureConversation();
      const form = new FormData();
      if (referenceUrl.trim()) form.append("referenceUrl", referenceUrl.trim());
      if (referenceFile) form.append("referenceVideo", referenceFile);
      materials.forEach((file) => form.append("materials", file));
      const response = await fetch(`/api/conversations/${conversationId}/remake`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: "视频制作请求失败。" }))) as {
          error?: string;
        };
        throw new Error(payload.error || "视频制作请求失败。");
      }
      const url = await consume(response, (text) => setProgress((previous) => [...previous, text.trim()]));
      if (url) setVideoUrl(url);
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "视频制作失败。");
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  return (
    <section className="montage-studio">
      <header className="montage-header">
        <h2>OpenMontage 视频工作台</h2>
        <p className="montage-sub">
          由本地 OpenMontage 引擎（ffmpeg + Python 工具链）驱动，无需 OpenClaw 即可剪辑与二创。
        </p>
      </header>

      <div className="montage-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "montage"}
          className={tab === "montage" ? "active" : ""}
          onClick={() => setTab("montage")}
        >
          一键剪辑
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "remake"}
          className={tab === "remake" ? "active" : ""}
          onClick={() => setTab("remake")}
        >
          视频二创
        </button>
      </div>

      {tab === "montage" && (
        <div className="montage-card">
          <h3>一键剪辑</h3>
          <p className="montage-hint">
            上传一段原视频（MP4 / MOV / M4V / WebM，≤500MB），自动完成语音字幕烧录、音频增强、配背景乐、加片头与调色转场。
          </p>
          <input
            type="file"
            accept="video/mp4,video/quicktime,video/x-matroska,video/webm"
            onChange={(event) => setMontageFile(event.target.files?.[0] ?? null)}
            disabled={sending}
          />
          {montageFile && <p className="montage-file">已选择：{montageFile.name}</p>}
          <button type="button" className="montage-run" disabled={!montageFile || sending} onClick={() => void runMontage()}>
            {sending ? "剪辑中…" : "开始剪辑"}
          </button>
        </div>
      )}

      {tab === "remake" && (
        <div className="montage-card">
          <h3>视频二创（爆款复刻）</h3>
          <p className="montage-hint">
            提供一段参考视频（链接或上传），并上传你的素材（视频/图片），系统按参考节奏拼接成竖版 1080×1920 成片。
          </p>
          <label className="montage-label">参考视频链接（抖音/小红书/视频号分享口令）</label>
          <textarea
            value={referenceUrl}
            onChange={(event) => setReferenceUrl(event.target.value)}
            placeholder="粘贴分享链接或口令，系统会自动提取链接"
            rows={2}
            disabled={sending}
          />
          <label className="montage-label">或上传参考视频</label>
          <input
            type="file"
            accept="video/mp4,video/quicktime,video/x-matroska,video/webm"
            onChange={(event) => setReferenceFile(event.target.files?.[0] ?? null)}
            disabled={sending}
          />
          {referenceFile && <p className="montage-file">参考视频：{referenceFile.name}</p>}
          <label className="montage-label">制作素材（视频 / 图片，可多选）</label>
          <input
            type="file"
            accept="video/mp4,video/quicktime,video/x-matroska,video/webm,image/jpeg,image/png,image/webp"
            multiple
            onChange={(event) => setMaterials(Array.from(event.target.files ?? []))}
            disabled={sending}
          />
          {materials.length > 0 && (
            <p className="montage-file">已选 {materials.length} 个素材：{materials.map((file) => file.name).join("、")}</p>
          )}
          <button
            type="button"
            className="montage-run"
            disabled={sending || (!referenceUrl.trim() && !referenceFile) || materials.length === 0}
            onClick={() => void runRemake()}
          >
            {sending ? "制作中…" : "开始制作"}
          </button>
        </div>
      )}

      {error && <p className="montage-error">⚠ {error}</p>}

      {progress.length > 0 && (
        <div className="montage-progress">
          <h4>处理进度</h4>
          <ul>
            {progress.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {videoUrl && (
        <div className="montage-result">
          <h4>成片</h4>
          <video src={videoUrl} controls className="montage-video" />
          <p>
            <a href={videoUrl} target="_blank" rel="noreferrer">
              打开/下载原文件
            </a>
          </p>
        </div>
      )}
    </section>
  );
}
