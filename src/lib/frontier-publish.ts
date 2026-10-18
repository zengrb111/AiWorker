import { prisma } from "@/lib/prisma";
import { loadFrontierCredential } from "@/lib/platform-sync";
import { buildSummary, mdToPlainText } from "@/lib/hgwx-publish";

/**
 * AI员工官网「AI最前沿」频道推送链路（aiworker.aimemory.cafe）。
 *
 * 官网对外接口（详见 https://aiworker.aimemory.cafe/frontier.html）：
 * - 读取列表：GET  {domain}/api/frontier（公开，无需鉴权）
 * - 读取单条：GET  {domain}/api/frontier/{id}（公开，详情页用）
 * - 新增：POST {domain}/api/frontier 头 x-api-key / Authorization: Bearer
 *         体 { date, tag, title, summary, content, link }
 *         content 为详情正文：详情页 article.html?id=xxx 展示；为空时回落显示 summary。
 * - 删除：DELETE {domain}/api/frontier/{id}
 *
 * 凭据来自「平台授权管理」里当前登录用户配置的官网-AI员工授权（域名 + API Key），
 * 因此推送能力按用户隔离；幂等：同一条内容（同标题）已成功推送过则跳过。
 */

export const FRONTIER_CHANNEL = "AI最前沿";

/** 频道页地址（作为发布记录的 remoteUrl 兜底） */
function channelUrl(domain: string): string {
  return `${domain.replace(/\/+$/, "")}/frontier.html`;
}

/** 单条详情页地址（官网 article.html?id=xxx） */
function detailUrl(domain: string, id: string): string {
  return `${domain.replace(/\/+$/, "")}/article.html?id=${encodeURIComponent(id)}`;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 内容库分类 → AI最前沿标签（频道现有标签风格：大模型 / 起号实战 / 开源项目 / 最新创业项目）。
 * 内容库分类多为来源平台（小红书/公众号/头条/视频），这里按来源给一个合理默认标签，可覆盖。
 */
function frontierTag(category?: string | null, override?: string): string {
  const custom = (override || "").trim();
  if (custom) return custom;
  const value = (category || "").trim();
  if (value.includes("小红书")) return "起号实战";
  if (value.includes("公众号")) return "大模型";
  if (value.includes("头条") || value.includes("微头条")) return "开源项目";
  return "最新创业项目";
}

export type FrontierPublishOptions = {
  /** 覆盖频道标签（默认按内容库分类映射） */
  tag?: string;
  /** 覆盖日期 YYYY-MM-DD（默认今天） */
  date?: string;
  /** 原文链接（默认空） */
  link?: string;
  /** 强制重新推送（忽略幂等记录） */
  force?: boolean;
};

export type FrontierPublishResult = {
  recordId: string;
  remoteId: string | null;
  remoteUrl: string | null;
  title: string;
  skipped?: boolean;
  message?: string;
};

/**
 * 把一条内容库条目推送到 AI员工官网「AI最前沿」频道。
 * 使用当前登录用户在「平台授权管理」配置的官网-AI员工授权（域名 + API Key）。
 */
export async function publishContentToFrontier(
  contentItemId: string,
  userId: string,
  publisher: string,
  options: FrontierPublishOptions = {}
): Promise<FrontierPublishResult> {
  const item = await prisma.contentItem.findFirst({ where: { id: contentItemId, userId } });
  if (!item) throw new Error("内容不存在。");

  const loaded = await loadFrontierCredential(userId);
  if (!loaded) {
    throw new Error(
      "尚未配置 AI最前沿授权。请到「平台授权管理」给「官网-AI员工」填写 https://aiworker.aimemory.cafe 与频道 API Key（x-api-key）。"
    );
  }
  const base = loaded.credential.domain.replace(/\/+$/, "");
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": loaded.credential.token,
    Authorization: `Bearer ${loaded.credential.token}`
  };

  // 幂等：同一篇内容（同标题）已成功推送过 → 直接跳过
  if (!options.force) {
    const existed = await prisma.publishRecord.findFirst({
      where: { contentItemId: item.id, channel: FRONTIER_CHANNEL, status: "SUCCESS", title: item.title },
      orderBy: { publishedAt: "desc" }
    });
    if (existed) {
      return {
        recordId: existed.id,
        remoteId: existed.remoteId,
        remoteUrl: existed.remoteUrl,
        title: existed.title,
        skipped: true,
        message: "该内容已推送到 AI最前沿，跳过重复推送。"
      };
    }
  }

  try {
    const summary = buildSummary(item.body || "", 140);
    // 详情页正文：Markdown → 空行分段纯文本；正文为空时回落 summary，保证详情页不空白。
    const content = mdToPlainText(item.body || "") || summary;
    const payload = {
      date: options.date || todayStr(),
      tag: frontierTag(item.category, options.tag),
      title: item.title,
      summary,
      content,
      link: options.link || ""
    };

    const res = await fetch(`${base}/api/frontier`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("AI最前沿 API Key 无效（401/403），请到「平台授权管理」重新配置。");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AI最前沿推送失败 ${res.status}${text ? `：${text.slice(0, 200)}` : ""}`);
    }
    const created = (await res.json().catch(() => ({}))) as { id?: string };
    const remoteId = created?.id || null;

    const record = await prisma.publishRecord.create({
      data: {
        contentItemId: item.id,
        channel: FRONTIER_CHANNEL,
        remoteId,
        remoteUrl: remoteId ? detailUrl(base, remoteId) : channelUrl(base),
        title: item.title,
        publisher,
        status: "SUCCESS",
        publishedAt: new Date()
      }
    });

    return {
      recordId: record.id,
      remoteId,
      remoteUrl: record.remoteUrl,
      title: item.title,
      message: `已推送到 AI最前沿（标签：${payload.tag}）`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.publishRecord.create({
      data: {
        contentItemId: item.id,
        channel: FRONTIER_CHANNEL,
        title: item.title,
        publisher,
        status: "FAILED",
        error: message.slice(0, 500),
        publishedAt: new Date()
      }
    });
    throw error;
  }
}

export type FrontierDeleteResult = {
  ok: boolean;
  /** 线上频道侧的条目 id */
  remoteId: string | null;
  title: string | null;
  /** 已经不在线上（可能是被手动删过） */
  alreadyGone?: boolean;
  message: string;
};

/**
 * 从 AI员工官网「AI最前沿」频道删除一条已发布的资讯。
 *
 * 删除依据是本地的发布记录（PublishRecord）：取这条内容在该频道最近一次
 * 发布成功的 remoteId，调官网 `DELETE /api/frontier/{id}`。
 * 成功/已不存在都会把记录状态标记为 DELETED，这样之后再点发布不会被幂等规则拦住。
 */
export async function deleteContentFromFrontier(
  contentItemId: string,
  userId: string,
  options: { remoteId?: string } = {}
): Promise<FrontierDeleteResult> {
  const item = await prisma.contentItem.findFirst({
    where: { id: contentItemId, userId },
    select: { id: true, title: true }
  });
  if (!item) throw new Error("内容不存在。");

  const loaded = await loadFrontierCredential(userId);
  if (!loaded) {
    throw new Error(
      "尚未配置 AI最前沿授权。请到「平台授权管理」给「官网-AI员工」填写 https://aiworker.aimemory.cafe 与频道 API Key（x-api-key）。"
    );
  }

  const record = await prisma.publishRecord.findFirst({
    where: {
      contentItemId: item.id,
      channel: FRONTIER_CHANNEL,
      status: "SUCCESS",
      ...(options.remoteId ? { remoteId: options.remoteId } : {})
    },
    orderBy: { publishedAt: "desc" }
  });

  const remoteId = options.remoteId || record?.remoteId || null;
  const base = loaded.credential.domain.replace(/\/+$/, "");
  if (!remoteId) {
    return {
      ok: false,
      remoteId: null,
      title: item.title,
      message: "本地没有该内容的推送成功记录，无法确定线上条目；请到 AI最前沿后台确认。"
    };
  }

  const headers = {
    "x-api-key": loaded.credential.token,
    Authorization: `Bearer ${loaded.credential.token}`
  };
  const res = await fetch(`${base}/api/frontier/${encodeURIComponent(remoteId)}`, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(20_000)
  });

  if (res.ok) {
    if (record) {
      await prisma.publishRecord.update({ where: { id: record.id }, data: { status: "DELETED" } });
    }
    return { ok: true, remoteId, title: item.title, message: `已从 AI最前沿删除（${remoteId}）` };
  }

  if (res.status === 404) {
    if (record) {
      await prisma.publishRecord.update({ where: { id: record.id }, data: { status: "DELETED" } });
    }
    return {
      ok: true,
      remoteId,
      title: item.title,
      alreadyGone: true,
      message: `线上已不存在该条目（${remoteId}），本地记录已标记为已删除`
    };
  }

  const text = await res.text().catch(() => "");
  throw new Error(`AI最前沿删除失败 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ""}`);
}
