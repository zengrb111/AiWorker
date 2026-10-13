import { prisma } from "@/lib/prisma";
import { PLATFORM_META, loadHealingCredential, loadSiteCredential, loadFrontierCredential } from "@/lib/platform-sync";

/**
 * 平台授权上下文 —— 把「当前登录用户在平台授权管理里已授权了什么」整理成
 * 会话可读的文本，供对话（人设/发布意图）与定时任务发布使用。
 *
 * 设计要点：
 * - 只暴露「有哪些渠道、能做什么」，绝不把 Cookie / 令牌明文写进 prompt。
 * - 可程序化发布的渠道有三个：
 *     hgwx    官网（好物推荐）—— 需要用户授权 site 且 kind = hgwx
 *     healing 官网-AI回忆录（心灵驿站）—— 需要 healing 专用授权，或 site 授权指向 aimemory.cafe
 *     aiworker 官网-AI员工（AI最前沿）—— 需要 aiworker 专用授权（域名 + API Key）
 * - 小红书 / 头条号 / 公众号 / 视频号 目前只能做数据采集（平台未开放内容发布接口），会明确标注「仅数据采集」。
 */

export type PublishChannelKey = "hgwx" | "healing" | "aiworker";

export const PUBLISH_CHANNEL_LABEL: Record<PublishChannelKey, string> = {
  hgwx: "官网（好物推荐）",
  healing: "官网-AI回忆录（心灵驿站）",
  aiworker: "官网-AI员工（AI最前沿）"
};

export type PlatformAuthEntry = {
  /** 数据库里的平台键：site | healing | aiworker | xhs | toutiao | wechat | channels */
  platform: string;
  /** 展示名（授权管理卡片名 / 账号昵称 / 域名） */
  displayName: string;
  /** active | expired | error */
  status: string;
  statusMsg: string;
  lastSyncAt: Date | null;
  /** 该授权能用于自动/定时发布的渠道 */
  publishChannels: PublishChannelKey[];
  /** 人话能力描述，直接用于 prompt */
  capability: string;
};

function statusText(status: string): string {
  if (status === "active") return "有效";
  if (status === "expired") return "已过期";
  if (status === "error") return "校验失败";
  return status;
}

/** 读取当前用户已授权的渠道，并推导每个渠道能干什么。 */
export async function loadUserPlatformAuth(userId: string): Promise<PlatformAuthEntry[]> {
  const accounts = await prisma.platformAccount.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: {
      platform: true,
      displayName: true,
      status: true,
      statusMsg: true,
      lastSyncAt: true
    }
  });

  // 官网类型（hgwx / healing / aiworker）要解密凭据才知道，分别按站内既有读取函数取
  const [siteCred, healingCred, frontierCred] = await Promise.all([
    loadSiteCredential(userId).catch(() => null),
    loadHealingCredential(userId).catch(() => null),
    loadFrontierCredential(userId).catch(() => null)
  ]);
  const siteKind = siteCred?.credential.kind ?? null;
  const healingReady = Boolean(healingCred);
  const frontierReady = Boolean(frontierCred);

  return accounts.map((account) => {
    const meta = PLATFORM_META[account.platform];
    const base = {
      platform: account.platform,
      displayName: account.displayName || meta?.name || account.platform,
      status: account.status,
      statusMsg: account.statusMsg || "",
      lastSyncAt: account.lastSyncAt
    };

    if (account.platform === "healing") {
      return {
        ...base,
        publishChannels: healingReady ? (["healing"] as PublishChannelKey[]) : [],
        capability: healingReady
          ? "可把图文推送到 AI回忆录官网「心灵驿站」频道"
          : "心灵驿站授权不完整（缺少域名或令牌），暂不能推送"
      };
    }

    if (account.platform === "aiworker") {
      return {
        ...base,
        publishChannels: frontierReady ? (["aiworker"] as PublishChannelKey[]) : [],
        capability: frontierReady
          ? "可把资讯推送到 AI员工官网「AI最前沿」频道（标题 + 摘要 + 标签 + 原文链接）"
          : "AI最前沿授权不完整（缺少域名或 API Key），暂不能推送"
      };
    }

    if (account.platform === "site") {
      const isHealing = siteKind === "healing";
      const isHgwx = siteKind === "hgwx";
      const channels: PublishChannelKey[] = [];
      if (isHgwx) channels.push("hgwx");
      if (isHealing) channels.push("healing");
      const capability = isHealing
        ? "官网指向 AI回忆录（心灵驿站），可推送图文到「心灵驿站」频道，无流量统计"
        : "可发布图文到官网「好物推荐」板块，并拉取站点访问数据（PV/UV）";
      return { ...base, publishChannels: channels, capability };
    }

    if (account.platform === "xhs") {
      return {
        ...base,
        publishChannels: [] as PublishChannelKey[],
        capability: "仅数据采集：小红书浏览/点赞/收藏等效果数据（平台未开放内容发布接口，不能自动发笔记）"
      };
    }

    if (account.platform === "toutiao") {
      return {
        ...base,
        publishChannels: [] as PublishChannelKey[],
        capability: "仅数据采集：头条号阅读/展现/互动数据（平台未开放内容发布接口，不能自动发文）"
      };
    }

    if (account.platform === "wechat") {
      return {
        ...base,
        publishChannels: [] as PublishChannelKey[],
        capability: "仅数据采集：公众号阅读次数/阅读人数/在看/分享/收藏/涨粉数据（平台未开放内容发布接口，不能自动群发）"
      };
    }

    if (account.platform === "channels") {
      return {
        ...base,
        publishChannels: [] as PublishChannelKey[],
        capability: "仅数据采集：视频号播放/点赞/评论/转发/收藏/涨粉数据（平台未开放内容发布接口，不能自动发布视频）"
      };
    }

    return {
      ...base,
      publishChannels: [] as PublishChannelKey[],
      capability: "未识别的授权类型，暂无可用动作"
    };
  });
}

/** 该用户可用于自动发布的渠道（去重、保持稳定顺序）。 */
export function resolvePublishChannels(entries: PlatformAuthEntry[]): PublishChannelKey[] {
  const order: PublishChannelKey[] = ["hgwx", "healing", "aiworker"];
  const set = new Set<PublishChannelKey>();
  for (const entry of entries) {
    if (entry.status === "expired") continue; // 过期授权不参与发布
    for (const channel of entry.publishChannels) set.add(channel);
  }
  return order.filter((channel) => set.has(channel));
}

/** 生成注入会话 prompt 的文本块（不含任何密钥）。 */
export function renderPlatformAuthBlock(entries: PlatformAuthEntry[]): string {
  if (entries.length === 0) {
    return "当前登录用户在「平台授权管理」中还没有任何平台授权，因此不能自动发布到任何渠道，也不要以已完成授权的口吻作答。";
  }
  const lines: string[] = [];
  for (const entry of entries) {
    const meta = PLATFORM_META[entry.platform];
    const title = meta?.name ?? entry.platform;
    const auto =
      entry.publishChannels.length > 0
        ? `可自动发布 → ${entry.publishChannels.map((c) => PUBLISH_CHANNEL_LABEL[c]).join("、")}`
        : "不可自动发布";
    lines.push(
      `- ${title}｜账号「${entry.displayName}」｜状态：${statusText(entry.status)}｜${auto}｜能力：${entry.capability}`
    );
  }
  const channels = resolvePublishChannels(entries);
  lines.push("");
  lines.push(
    channels.length > 0
      ? `可自动发布的渠道：${channels.map((c) => PUBLISH_CHANNEL_LABEL[c]).join("、")}。发布动作由平台服务端完成（凭据已加密存放在服务端），你只需要告诉用户内容会发到哪些渠道、不要向用户索要或展示任何令牌/Cookie。`
      : "当前没有任何「可自动发布」的渠道：小红书、头条号、公众号、视频号只用于数据采集。若用户要求发布，请说明需要先在「平台授权管理」授权官网（好物推荐）、官网-AI回忆录（心灵驿站）或官网-AI员工（AI最前沿）。"
  );
  if (channels.length > 0) {
    lines.push(
      "内容库的入库 / 发布 / 撤回 / 查询都有现成脚本，**不要自己写脚本、不要自己拼 curl**（自己造脚本极易失败），直接执行下面这些绝对路径命令即可，也不需要向用户索要任何 API Key、Cookie 或 Token："
    );
    lines.push(
      [
        '· 入库（含按授权自动发布）：`node C:\\Users\\zengr\\.openclaw\\workspace\\content-library\\ingest.mjs`',
        '· 补发/重发某篇：`node C:\\Users\\zengr\\.openclaw\\workspace\\content-library\\publish.mjs "标题关键词"`（`--channels=healing,aiworker` 收窄渠道，`--dry` 只查不发）',
        '· 查最近条目与发布情况：`node C:\\Users\\zengr\\.openclaw\\workspace\\content-library\\list.mjs`（`--days=3` 查最近三天；会列出每个渠道的发布状态与线上 id）',
        '· 从线上撤回（删除）：`node C:\\Users\\zengr\\.openclaw\\workspace\\content-library\\unpublish.mjs "标题关键词"`（`--channels=healing,aiworker`；`--dry` 只查会删哪篇）'
      ].join("\n")
    );
    lines.push(
      "清理重复内容的正确顺序：先 `list.mjs` 看今天发了哪些、哪几篇是同一选题的重复版本 → 跟用户确认保留哪篇 → 对要删的那几篇执行 `unpublish.mjs \"标题关键词\"` → 删完再用 `list.mjs` 复核一次，并把结果如实汇报（删了几篇、保留了哪篇）。"
    );
    if (!channels.includes("healing") && !channels.includes("aiworker")) {
      lines.push("注意：当前账号未授权支持撤回的渠道（心灵驿站 / AI最前沿），撤回功能不可用。");
    } else {
      const deletable = channels.filter((c) => c === "healing" || c === "aiworker").map((c) => PUBLISH_CHANNEL_LABEL[c]);
      lines.push(
        `删除范围限制：目前只有「${deletable.join("、")}」支持撤回；官网好物推荐、小红书、头条号、公众号、视频号暂不支持删除。`
      );
    }
  }
  return lines.join("\n");
}

/** 便捷方法：一次拿到「授权条目 + prompt 文本 + 可用发布渠道」。 */
export async function loadPlatformAuthContext(userId: string): Promise<{
  entries: PlatformAuthEntry[];
  promptBlock: string;
  publishChannels: PublishChannelKey[];
}> {
  const entries = await loadUserPlatformAuth(userId);
  return {
    entries,
    promptBlock: renderPlatformAuthBlock(entries),
    publishChannels: resolvePublishChannels(entries)
  };
}
