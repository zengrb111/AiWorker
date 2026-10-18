import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getSyncState, startSync } from "@/lib/sync-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/collectors/tick —— 每日自动采集调度。
 *
 * 由 instrumentation 每 30 秒本机调用一次；到达配置时间（默认 08:30）后，
 * 对每个「有授权账号」的用户触发一次全渠道同步（公众号 / 视频号 / 小红书 / 头条号）。
 * 每个用户每天只跑一次，结果记录在 .collector-daily-state.json。
 *
 * 为什么需要它：内容型平台（小红书 / 头条）没有官方窗口汇总，只能靠
 * 「今天快照 − 昨天快照」算增量；采集一旦断档，近7天/近30天就会失真。
 */
const STATE_FILE = path.join(process.cwd(), ".collector-daily-state.json");
const DAILY_AT = (process.env.DAILY_COLLECT_AT || "08:30").trim();
const pad = (n: number) => String(n).padStart(2, "0");

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const nowHM = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function readState(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}
function writeState(state: Record<string, string>) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* 状态写失败不影响采集 */
  }
}

export async function POST(req: Request) {
  const token = (process.env.SCHEDULE_API_TOKEN || process.env.CONTENT_INGEST_TOKEN || "").trim();
  const auth = req.headers.get("authorization") || "";
  if (!token || auth !== `Bearer ${token}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const now = nowHM();
  if (now < DAILY_AT) {
    return NextResponse.json({ ok: true, skipped: true, reason: `未到采集时间（${DAILY_AT}）`, now });
  }

  const date = todayKey();
  const state = readState();
  const users = await prisma.user.findMany({
    where: { platformAccounts: { some: {} } },
    select: { id: true },
  });

  // ?dry=1 只返回「本来会启动哪些用户」，不真正触发（排查用）
  const dry = new URL(req.url).searchParams.get("dry") === "1";

  const started: string[] = [];
  const skipped: string[] = [];
  for (const u of users) {
    if (state[u.id] === date) {
      skipped.push(u.id);
      continue;
    }
    if (getSyncState(u.id)?.running) {
      skipped.push(u.id);
      continue;
    }
    if (!dry) {
      startSync(u.id);
      state[u.id] = date;
    }
    started.push(u.id);
  }
  if (!dry && started.length > 0) writeState(state);

  return NextResponse.json({ ok: true, date, at: DAILY_AT, dry, started, skipped: skipped.length });
}

/** GET：查看今天的自动采集状态（便于排查） */
export async function GET() {
  const state = readState();
  return NextResponse.json({ ok: true, at: DAILY_AT, today: todayKey(), state });
}
