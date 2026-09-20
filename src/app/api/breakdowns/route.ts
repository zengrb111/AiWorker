import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { decomposeContent, writeHitBreakdownFile } from "@/lib/breakdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/breakdowns —— 拆解库列表 */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const rows = await prisma.contentBreakdown.findMany({
    orderBy: [{ metricViews: "desc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      platform: true,
      contentKey: true,
      title: true,
      category: true,
      metricViews: true,
      status: true,
      usedByCron: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return NextResponse.json({ ok: true, items: rows });
}

/** POST /api/breakdowns —— 对某条爆款内容触发 AI 拆解并落库 */
export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const platform = String(body?.platform || "").trim();
  const contentKey = String(body?.contentKey || "").trim();
  const title = String(body?.title || "").trim();
  const views = Number(body?.views || 0);
  if (!["xhs", "toutiao", "site"].includes(platform) || !contentKey || !title) {
    return NextResponse.json({ ok: false, message: "缺少 platform / contentKey / title" }, { status: 400 });
  }
  let aiBreakdown: string;
  try {
    aiBreakdown = await decomposeContent({ platform, contentKey, title, views });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      message: `拆解生成失败：${e instanceof Error ? e.message : String(e)}`,
    }, { status: 502 });
  }
  // 重新拆解会把这条打回草稿，同时清掉「每日任务参考」标记，
  // 避免出现 status=draft 却仍被当作参考、参考文件里也还留着它的不一致。
  const prev = await prisma.contentBreakdown.findUnique({
    where: { platform_contentKey: { platform, contentKey } },
    select: { status: true },
  });
  const row = await prisma.contentBreakdown.upsert({
    where: { platform_contentKey: { platform, contentKey } },
    update: {
      title,
      category: body?.category ?? null,
      metricViews: views,
      aiBreakdown,
      status: "draft",
      editedBreakdown: null,
      usedByCron: false,
    },
    create: {
      platform,
      contentKey,
      title,
      category: body?.category ?? null,
      metricViews: views,
      aiBreakdown,
      status: "draft",
      usedByCron: false,
    },
  });
  // 原本是参考中的，重新拆解后要从参考文件里撤下来
  if (prev?.status === "active") {
    try {
      await writeHitBreakdownFile();
    } catch {
      /* 文件重写失败不影响拆解结果本身 */
    }
  }
  return NextResponse.json({ ok: true, item: row });
}
