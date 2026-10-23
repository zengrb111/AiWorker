/**
 * 清洗任务提示词里「让 agent 自己发微信通知」的旧写法。
 *
 * 背景（2026-10-22 实测）：老任务的 prompt 里写着
 *   【微信通知】全部完成后用 exec 执行：openclaw message send -t ... -m "..."
 * 单 agent 时代这条能跑；改成每用户一个 agent 之后，message CLI 没有显式
 * owner，直接报 `Multiple agents are configured, but message CLI has no
 * explicit owner`。而通知本来就由平台调度器确定性投递（`deliverWechatMessage`），
 * 于是出现最坏组合：用户**收到了**通知，同时收到一句「微信通知没发出去」。
 *
 * 所以入库前统一改写：告诉 agent 通知由平台负责，你只管输出总结。
 *
 * 判定范围要宽：历史写法有三种变体，只看 `openclaw message send` 会漏掉后两种——
 *   1. `openclaw message send -t ... -m "..."`
 *   2. `node D:\OpenClaw\...\index.js message send --channel ... --announce --message "..."`
 *   3. 只带 `--announce`、没写完整命令的
 */
const NOTIFY_SECTION = /【微信通知[^】]*】[\s\S]*?(?=\n【|$)/;
const CLI_NOTIFY = /message\s+send|--announce/i;

const REPLACEMENT =
  "【微信通知】不需要你发送通知：任务完成后平台会自动把结果推送到本人微信，你只管输出总结。" +
  "禁止执行 message send，也不要用 --announce。";

export function sanitizeScheduledPrompt(prompt: string): string {
  const text = (prompt || "").trim();
  if (!text) return text;
  // 没有提到任何「自己发通知」的写法时原样返回，避免误伤正常描述。
  if (!CLI_NOTIFY.test(text)) return text;

  if (NOTIFY_SECTION.test(text)) {
    return text
      .replace(NOTIFY_SECTION, REPLACEMENT)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  // 提到了 CLI 但没用标准段落：在末尾补一条纪律，不改动原文。
  return `${text}\n\n${REPLACEMENT}`;
}
