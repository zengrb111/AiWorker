import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { writeHitBreakdownFile } from "@/lib/breakdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/breakdowns/[id] —— 单条拆解详情 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const row = await prisma.contentBreakdown.findUnique({ where: { id: params.id } });
  if (!row) return NextResponse.json({ ok: false, message: "拆解不存在" }, { status: 404 });
  return NextResponse.json({ ok: true, item: row });
}

/** PUT /api/breakdowns/[id] —— 人工二次编辑 / 标记为每日任务参考 */
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const row = await prisma.contentBreakdown.findUnique({ where: { id: params.id } });
  if (!row) return NextResponse.json({ ok: false, message: "拆解不存在" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const update: Record<string, unknown> = {};
  if (typeof body?.editedBreakdown === "string") {
    update.editedBreakdown = body.editedBreakdown;
    if (body?.status !== "active") update.status = "edited";
  }
  if (body?.status === "active" || body?.status === "edited" || body?.status === "draft") {
    update.status = body.status;
  }

  const saved = await prisma.contentBreakdown.update({ where: { id: params.id }, data: update });

  // 标记/取消「每日任务参考」后，重新汇总拆解文件
  if (saved.status === "active" || row.status === "active") {
    try {
      const res = await writeHitBreakdownFile();
      const final = await prisma.contentBreakdown.update({
        where: { id: params.id },
        data: { usedByCron: saved.status === "active" },
      });
      // 返回写入参考文件之后的最终行，客户端据此同步状态，不靠本地猜
      return NextResponse.json({ ok: true, item: final, file: res });
    } catch (e) {
      return NextResponse.json({
        ok: true,
        item: saved,
        fileError: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return NextResponse.json({ ok: true, item: saved });
}
