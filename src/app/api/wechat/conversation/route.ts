import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { readSessionUserId } from "@/lib/session";
import { deliverWechatMessage, deriveWeixinSessionKey, openClawClient } from "@/lib/openclaw";
import { appendTurn, listTurns, type WechatTurnRole } from "@/lib/wechat-conversation-store";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type WechatMessage = {
  role: WechatTurnRole;
  body: string;
  createdAt: string;
  mediaPath: string | null;
  mediaMime: string | null;
};

function weixinStateDir(): string {
  return path.join(os.homedir(), ".openclaw", "openclaw-weixin");
}

function normalizeAccountId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "default";
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return trimmed.toLowerCase();
  return (
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || "default"
  );
}

/**
 * 微信插件自己收发的消息存档。
 *
 * `direction` 是**机器人视角**：inbound = 用户发给 bot，outbound = bot 回给用户。
 * 统一翻译成对话视角的 `role`（user = 用户说的，assistant = AI 说的），
 * 前端只认 role，避免两套方向语义混在一起。
 */
function readWechatMessages(
  accountId: string,
  conversationId: string
): WechatMessage[] {
  const dbPath = path.join(weixinStateDir(), "ref-messages.sqlite");
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath);
    const rows = db
      .prepare(
        `SELECT direction, body, media_path, media_mime, created_at
         FROM quote_messages
         WHERE lower(account_id) = lower(?) AND lower(conversation_id) = lower(?)
         ORDER BY created_at ASC`
      )
      .all(accountId, conversationId) as Array<{
      direction: string;
      body: string | null;
      media_path: string | null;
      media_mime: string | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      role: (row.direction === "outbound" ? "assistant" : "user") as WechatTurnRole,
      body: row.body ?? "",
      createdAt: new Date(row.created_at).toISOString(),
      mediaPath: row.media_path ?? null,
      mediaMime: row.media_mime ?? null
    }));
  } catch (error) {
    console.error("[wechat/conversation] 读取微信参考消息库失败：", error);
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * 合并两处消息源并按时间升序。
 *
 * 平台直投的回复不会被微信插件存档（插件只记自己收发的），所以两处基本不重叠；
 * 万一出现同一条被记两次（同角色、同正文、时间相差 2 分钟内），只保留一条。
 */
function mergeMessages(plugin: WechatMessage[], platform: WechatMessage[]): WechatMessage[] {
  const all = [...plugin, ...platform].sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta - tb;
  });
  const out: WechatMessage[] = [];
  for (const item of all) {
    const dup = out.some((prev) => {
      if (prev.role !== item.role) return false;
      if (prev.body.trim() !== item.body.trim()) return false;
      const gap = Math.abs(Date.parse(prev.createdAt) - Date.parse(item.createdAt));
      return Number.isFinite(gap) && gap < 120_000;
    });
    if (!dup) out.push(item);
  }
  return out;
}

type BoundTarget = {
  userId: string;
  accountId: string;
  /** 收件人（用户微信 openid，原始大小写，投递时必须用它） */
  to: string;
  /** bot 标识（`xxx@im.bot` 原始值，投递时由 deliverWechatMessage 反查账号） */
  accountRef: string;
};

async function resolveBoundTarget(userId: string): Promise<BoundTarget | null> {
  const binding = await prisma.wechatBinding
    .findFirst({
      where: { userId, status: "BOUND" },
      orderBy: { boundAt: "desc" }
    })
    .catch(() => null);
  if (!binding) return null;
  const to = (binding.wechatNo || "").trim();
  const accountRef = (binding.wechatOpenId || "").trim();
  // 形状不合规宁可不投：投错人比不投更糟。
  if (!to.endsWith("@im.wechat") || !accountRef.endsWith("@im.bot")) return null;
  return { userId, accountId: normalizeAccountId(accountRef), to, accountRef };
}

export async function GET() {
  const userId = readSessionUserId();
  if (!userId) {
    return jsonError("未登录或会话已过期。", 401);
  }

  const target = await resolveBoundTarget(userId);
  if (!target) {
    return jsonOk({ bound: false, conversationId: null, messages: [] });
  }

  const plugin = readWechatMessages(target.accountId, target.to);
  const platform = listTurns(userId, target.to).map((turn) => ({
    role: turn.role,
    body: turn.body,
    createdAt: turn.createdAt,
    mediaPath: null,
    mediaMime: null
  }));

  return jsonOk({
    bound: true,
    conversationId: target.to,
    accountId: target.accountId,
    messages: mergeMessages(plugin, platform)
  });
}

/** 同一用户在同一时刻只允许一轮在跑，避免连点造成重复回复/重复推送。 */
const inFlight = new Set<string>();

/**
 * 在平台侧继续追问。
 *
 * 刻意**复用微信入站会话 key**：这样这一句就是接在微信那条对话后面，而不是另开一条。
 * 回复拿到后由平台直接调微信接口推回去，用户在微信里能接着看到。
 */
export async function POST(request: Request) {
  const userId = readSessionUserId();
  if (!userId) {
    return jsonError("未登录或会话已过期。", 401);
  }

  const body = await readJson<{ message?: string }>(request);
  const text = (body.message || "").trim();
  if (!text) {
    return jsonError("消息不能为空。", 400);
  }
  if (text.length > 4000) {
    return jsonError("单条消息过长（上限 4000 字）。", 400);
  }

  const target = await resolveBoundTarget(userId);
  if (!target) {
    return jsonError("当前账号还没有完成微信绑定，无法在此继续对话。", 400);
  }

  if (inFlight.has(userId)) {
    return jsonError("上一条还在回复中，请稍候。", 429);
  }
  inFlight.add(userId);

  const sessionKey = deriveWeixinSessionKey(userId, target.accountId, target.to);

  // 先落用户这句：等 AI 回复期间刷新页面也能看到自己发过什么。
  appendTurn({ userId, conversationId: target.to, role: "user", body: text });

  // 推送失败的原因集中收集，一并回给前端（问句、回复可能各失败一次）。
  const deliverErrors: string[] = [];

  // 追问本身也要推到微信侧：否则用户在微信里只能看到 AI 的回复，看不到问的是什么。
  // 加前缀标明来源——微信客户端会把它显示成 bot 发的一条，不加前缀会让人以为是自己刚打的字。
  // 放在 AI 之前推，用户在微信里能立刻看到这句，不用干等几分钟。
  let questionDelivered = false;
  try {
    await deliverWechatMessage(target.accountRef, target.to, `【平台追问】${text}`);
    questionDelivered = true;
  } catch (error) {
    deliverErrors.push(error instanceof Error ? error.message : String(error));
    console.error(`[wechat/conversation] 追问推送微信失败（user=${userId}）：`, error);
  }

  try {
    const result = await openClawClient.sendTask({
      userId,
      sessionKey,
      message: text,
      // 微信链路里 agent 可能要调工具（查资料/取数），给足 4 分钟。
      timeoutMs: 240_000
    });
    const reply = (result.content || "").trim();
    if (!reply) {
      return jsonError("AI 没有返回内容，请重试。", 502);
    }

    appendTurn({ userId, conversationId: target.to, role: "assistant", body: reply });

    // 推回微信：失败不影响平台侧已经拿到的回复，但要把原因如实带回前端。
    let delivered = false;
    try {
      await deliverWechatMessage(target.accountRef, target.to, reply);
      delivered = true;
    } catch (error) {
      deliverErrors.push(error instanceof Error ? error.message : String(error));
      console.error(`[wechat/conversation] 回复推送微信失败（user=${userId}）：`, error);
    }

    return jsonOk({
      reply,
      delivered,
      questionDelivered,
      deliverError: deliverErrors.length ? deliverErrors.join("；") : null,
      sessionKey
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[wechat/conversation] 平台侧追问失败（user=${userId}）：`, error);
    // 微信侧已经先看到那句追问了，这里补一条失败提示，别让它悬着没下文。
    if (questionDelivered) {
      try {
        await deliverWechatMessage(target.accountRef, target.to, `⚠️ AI 回复失败：${message}`);
      } catch {
        /* 补偿提示也发不出去就算了，前端仍有报错 */
      }
    }
    return jsonError(`AI 回复失败：${message}`, 502);
  } finally {
    inFlight.delete(userId);
  }
}
