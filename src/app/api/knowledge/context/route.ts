import { NextRequest } from "next/server";
import { jsonError, jsonOk, readJson } from "@/lib/http";
import { resolveOwnerFromBody } from "@/lib/ingest-owner";
import { getIngestToken, isValidAgentToken } from "@/lib/platform-config";
import { extractKeywords, loadUserKbContext, retrieveReferenceChunks } from "@/lib/kb-hot-topics";

/**
 * POST /api/knowledge/context —— 供 OpenClaw 定时任务按账号取「知识库上下文」。
 *
 * 为什么需要：定时任务跑在 OpenClaw 侧的 cron 会话里，不是平台的 Web 会话，
 * 拿不到平台在对话中注入的知识库内容；而内容生成必须参考**该账号自己的**产品知识
 * 与人设（不同账号的产品/人设/卖点完全不同，共用一套就会互相串内容）。
 *
 * 鉴权：Bearer CONTENT_INGEST_TOKEN（与 /api/content/ingest 一致，定时任务没有 Web 会话）。
 * 请求体：{ userId? , sessionKey?, phone?, query?, topK? }
 * 返回：{ account, context, chunkCount, knowledgeBases }
 */

export const dynamic = "force-dynamic";

/** 上下文上限，避免把整库塞进提示词。 */
const MAX_CONTEXT_CHARS = 6000;
const DEFAULT_QUERY = "产品介绍 核心卖点 产品功能 账号定位 人设 目标用户 品牌";

type Body = {
  userId?: string;
  sessionKey?: string;
  phone?: string;
  query?: string;
  topK?: number;
};

function extractToken(request: NextRequest): string {
  const header = request.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return (request.headers.get("x-ingest-token") || "").trim();
}

export async function POST(request: NextRequest) {
  const expected = getIngestToken();
  if (!expected) {
    return jsonError("服务端未配置平台 Agent 令牌（系统配置 → 平台 Agent 令牌），接口未启用。", 503);
  }
  if (!isValidAgentToken(extractToken(request))) {
    return jsonError("令牌无效。", 401);
  }

  const body = await readJson<Body>(request);
  const owner = await resolveOwnerFromBody(body);
  if (!owner.ok) {
    return jsonError(owner.error, owner.status);
  }
  const user = owner.user;

  const topK = Math.min(20, Math.max(1, Math.round(Number(body.topK) || 8)));
  const query = (body.query || "").trim() || DEFAULT_QUERY;

  const kbCtx = await loadUserKbContext(user.id);
  if (!kbCtx) {
    return jsonOk({
      account: user.phone,
      context: "",
      chunkCount: 0,
      knowledgeBases: [],
      message: "该账号还没有可用的知识库切片，内容生成将使用通用产品知识。"
    });
  }

  const context = await retrieveReferenceChunks([query], kbCtx, topK);
  const trimmed =
    context.length > MAX_CONTEXT_CHARS
      ? `${context.slice(0, MAX_CONTEXT_CHARS)}\n…（内容较长，已截断）`
      : context;

  // 顺带把该账号知识库的关键词吐给调用方：定时任务用它筛选题，
  // 否则所有账号都会套同一份硬编码词表（38003 是「营销数字员工」，却被挑出「回忆/照片」类选题）。
  // 注意 extractKeywords 是 2~4 字滑动窗口，会切出「数字员」「字员工」这类碎片 ——
  // 这里去掉「是更长关键词子串」的项，只留下有意义的词。
  const rawKeywords = extractKeywords(
    kbCtx.candidates.map((c) => c.content),
    40
  );
  const keywords = rawKeywords.filter(
    (w) => !rawKeywords.some((other) => other !== w && other.includes(w))
  );

  return jsonOk({
    account: user.phone,
    context: trimmed,
    keywords,
    chunkCount: kbCtx.candidates.length,
    knowledgeBases: [...new Set([...kbCtx.kbNameMap.values()])]
  });
}
