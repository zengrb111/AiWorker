import { prisma } from "./prisma";

export type OwnerLookupBody = {
  /** 账号 id（最精确） */
  userId?: string;
  /** 会话标识，形如 agent:u-<账号id>:c<会话id>（旧格式 agent:main:user-<账号id> 仍兼容） */
  sessionKey?: string;
  /** 手机号 */
  phone?: string;
};

/**
 * 从请求体解析「归属账号」—— 入库（/api/content/ingest）与取知识库上下文
 * （/api/knowledge/context）共用，避免两处规则漂移。
 *
 * 优先级：显式 userId > sessionKey 里的账号 id > 显式 phone > 环境变量默认 > 库里最早的账号。
 *
 * sessionKey 支持两种形态：
 *   · 旧：`agent:main:user-<账号id>`（单 agent 时代）
 *   · 新：`agent:u-<账号id>:c<会话id>`（每用户独立 agent，2026-10-21 起）
 * 两者都从 `user-<id>` 或 `u-<id>` 段里取账号 id。
 *
 * 关键约束：**显式指定了归属却查不到账号时返回错误**，绝不静默退回默认账号 ——
 * 否则内容会悄悄写进别人的库（2026-10-13「13800138003 的产出跑到 13800138001」事故）。
 */
export async function resolveOwnerFromBody(body: OwnerLookupBody) {
  const rawKey = (body.sessionKey || "").trim();
  const sessionUserId =
    /(?:^|[:\s])user-([A-Za-z0-9_-]+)/.exec(rawKey)?.[1] ||
    /(?:^|:)u-([A-Za-z0-9_-]+)/.exec(rawKey)?.[1] ||
    "";
  const wantedUserId = ((body.userId || "").trim() || sessionUserId).trim();
  const wantedPhone = wantedUserId
    ? ""
    : ((body.phone || "").trim() || (process.env.CONTENT_INGEST_PHONE || "").trim());

  const user = wantedUserId
    ? await prisma.user.findUnique({ where: { id: wantedUserId } })
    : wantedPhone
      ? await prisma.user.findUnique({ where: { phone: wantedPhone } })
      : await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });

  if (!user) {
    if (wantedUserId) {
      return {
        ok: false as const,
        error: `找不到 id 为 ${wantedUserId} 的账号（请检查传入的 sessionKey / userId 是否正确）。`,
        status: 404 as const
      };
    }
    if (wantedPhone) {
      return {
        ok: false as const,
        error: `找不到手机号为 ${wantedPhone} 的账号。`,
        status: 404 as const
      };
    }
    return { ok: false as const, error: "库里还没有任何账号，无法确定归属。", status: 404 as const };
  }

  return { ok: true as const, user };
}
