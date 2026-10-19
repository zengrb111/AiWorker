/**
 * 方案回显：把规划阶段的视频方案写进对话流（assistant 消息），
 * 让用户在聊天里直接看到 AI 给出的方案，而不只是弹一个面板。
 *
 * 需求背景：用户要求「一键生成视频时，让 DSH 生成方案，然后回显到对话中」。
 * 规划阶段（gen-video/plan、gen-article-video/plan）已经算出完整方案（draft），
 * 这里只负责把 draft 翻译成人话文本并落一条 assistant 消息。
 *
 * 回显失败绝对不影响出片主流程：它只是「把方案写进聊天」，不是出片必需。
 */

import { prisma } from "@/lib/prisma";
import type { VideoPlanDraft } from "./pipeline";

const CAPTION_LABELS: Record<string, string> = {
  classic: "经典白字",
  "bold-yellow": "醒目黄",
  "boxed-dark": "黑底白字",
  "minimal-line": "极简细描边",
};

function captionLabel(key: string): string {
  return CAPTION_LABELS[key] ?? key;
}

/** 把方案 draft 翻译成一段人话文本（与方案面板同源，但用聊天可读的纯文本组织）。 */
export function buildPlanEchoText(draft: VideoPlanDraft): string {
  const s = draft.summary;
  const lines: string[] = [];
  lines.push("🎬 已为你生成视频方案：");
  lines.push(`标题：《${draft.title || "（未命名）"}》`);
  lines.push(
    `风格：${s.themeLabel}${draft.themeReason ? `（${draft.themeReason}）` : ""}`,
  );
  lines.push(
    `时长：约 ${Math.round(s.durationSeconds)}s · ${s.beatCount} 句旁白 · ${s.scenes.length} 个镜头 · 字幕：${captionLabel(s.captionStyle)}`,
  );
  if (s.effects?.length) lines.push(`特效：${s.effects.join("、")}`);
  if (s.outroText) lines.push(`片尾：${s.outroText}`);
  lines.push("");
  lines.push("📝 旁白文案：");
  lines.push(draft.narration || "（无旁白）");
  lines.push("");
  lines.push("🖼 镜头安排：");
  s.scenes.forEach((sc, i) => {
    const imgs = sc.imageIndexes.length ? `图${sc.imageIndexes.join("·图")}` : "（配图）";
    const extra = sc.particles && sc.particles !== "无" ? ` / ${sc.particles}` : "";
    lines.push(`${i + 1}. ${sc.startSeconds}s–${sc.outSeconds}s  ${imgs}  ${sc.motion}${extra}`);
  });

  const insights = draft.insights.filter((it) => it.caption);
  if (insights.length) {
    lines.push("");
    lines.push("💡 素材理解：");
    insights.forEach((it, k) =>
      lines.push(`图${k + 1}：${[it.caption, it.mood].filter(Boolean).join(" · ")}`),
    );
  }

  if (draft.newsItems?.length) {
    lines.push("");
    lines.push("📰 文案依据：");
    draft.newsItems.forEach((n) => lines.push(`- ${n.title}`));
  }

  if (s.fallback) {
    lines.push("");
    lines.push("⚠ 本次分镜使用了默认节奏（AI 分镜规划不可用），其余方案照常。");
  }

  lines.push("");
  lines.push("满意的话点击「生成视频」即可开始渲染；也可以调整风格 / 字幕样式后重新生成方案。");
  return lines.join("\n");
}

/** 把方案回显进指定对话（assistant 消息）。任何失败都静默忽略，不影响出片。返回回显文本（供接口下发给前端即时展示）。 */
export async function echoPlanToConversation(
  conversationId: string,
  draft: VideoPlanDraft,
): Promise<string> {
  const text = buildPlanEchoText(draft);
  try {
    await prisma.message.create({
      data: { conversationId, role: "assistant", content: text },
    });
  } catch (err) {
    console.error(
      `[plan-echo] 写入对话失败（忽略）：${err instanceof Error ? err.message : err}`,
    );
  }
  return text;
}
