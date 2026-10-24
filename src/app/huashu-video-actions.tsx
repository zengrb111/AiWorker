"use client";

/**
 * 成片消息上的「修改入口」。
 *
 * 为什么挂在消息上而不是只放在生成面板里：出片要十几分钟，用户往往会切到别的会话
 * 或关掉面板；面板里的按钮随之消失，回来就只剩一条视频，找不到修改入口。
 * 视频 URL 本身带着项目 token（`/videos/huashu-<token>-vN.mp4`），
 * 所以刷新页面、换会话回来后仍然能从这里继续改。
 *
 * 这里**只有「打开 Studio」**：Studio 评论由后台自动接单（tick 每 30 秒扫一次），
 * 改完自动重新出片；手动按钮（同步 / 重新出片）只会让人以为必须点，
 * 还会和后台抢同一把锁。出片接口仍保留给运维与失败兜底用。
 */

import { useState } from "react";

type Props = {
  videoUrl: string;
  /** 点「去内容库查看」时交给上层：成片消息只带视频 URL，条目 id 由平台侧按 token 匹配 */
  onOpenContent?: (videoUrl: string) => void;
};

const TOKEN_RE = /\/videos\/huashu-([A-Za-z0-9-]+)-v(\d+)\.mp4/;

export default function HuashuVideoActions({ videoUrl, onOpenContent }: Props) {
  const match = TOKEN_RE.exec(videoUrl);
  const token = match?.[1] ?? null;

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  // 不是 huashu 出的视频（旧 Remotion 管线）不显示这组按钮
  if (!token) return null;

  async function openStudio() {
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch(`/api/video-motion/${token}/studio`, { method: "POST" });
      const payload = (await res.json()) as { ok?: boolean; data?: { url?: string }; error?: string };
      if (!res.ok || !payload?.data?.url) throw new Error(payload?.error || "Studio 启动失败。");
      window.open(payload.data.url, "_blank", "noopener,noreferrer");
      setNotice("Studio 已打开：在画面上按 C 点一下、写下要改什么，提交后会自动改片并出新版。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Studio 启动失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="huashu-actions">
      <div className="huashu-actions-row">
        {onOpenContent && (
          <button
            type="button"
            className="huashu-action-btn"
            onClick={() => onOpenContent(videoUrl)}
            title="打开内容库里这条视频（可以改标题、推送心灵驿站、继续用 Studio 改）"
          >
            去内容库查看
          </button>
        )}
        <button type="button" className="huashu-action-btn" onClick={() => void openStudio()} disabled={busy}>
          {busy ? "正在启动 Studio…" : "在 Studio 里修改"}
        </button>
      </div>
      <div className="huashu-actions-note">
        Studio 里提交的评论会<strong>自动</strong>改片并出新版（约 30 秒内接单，改一处几分钟），
        进度会显示在下方，不用回来点任何按钮。
      </div>
      {notice && <div className="huashu-actions-note">{notice}</div>}
    </div>
  );
}
