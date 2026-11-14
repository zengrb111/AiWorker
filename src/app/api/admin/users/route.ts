import { jsonError, jsonOk } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { isAdminSession } from "@/lib/admin-session";
import { Prisma } from "@/generated/prisma";

/**
 * GET /api/admin/users —— 运营后台「用户管理」列表。
 * 支持按注册手机号模糊搜索、按注册时间（北京时区日期）区间筛选、分页。
 * 只返回手机号与注册时间，不返回密码哈希等敏感字段。
 */
export const dynamic = "force-dynamic";

/** 把 yyyy-MM-dd 当作北京时间的当天起止点，转成 UTC Date。 */
function beijingDay(date: string, endOfDay: boolean): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const clock = endOfDay ? "23:59:59.999" : "00:00:00.000";
  const parsed = new Date(`${date}T${clock}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const beijingFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

function formatBeijing(value: Date): string {
  return beijingFormatter.format(value).replace(/\//g, "-");
}

export async function GET(request: Request) {
  if (!isAdminSession()) return jsonError("未登录或登录已过期，请重新登录。", 401);

  const params = new URL(request.url).searchParams;
  const phone = (params.get("phone") || "").trim();
  const from = (params.get("from") || "").trim();
  const to = (params.get("to") || "").trim();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(params.get("pageSize")) || 20));

  const where: Prisma.UserWhereInput = {};
  if (phone) where.phone = { contains: phone };

  const gte = from ? beijingDay(from, false) : null;
  const lte = to ? beijingDay(to, true) : null;
  if (gte || lte) {
    where.createdAt = {
      ...(gte ? { gte } : {}),
      ...(lte ? { lte } : {})
    };
  }

  try {
    const [total, rows] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { phone: true, createdAt: true }
      })
    ]);

    return jsonOk({
      total,
      page,
      pageSize,
      items: rows.map((row, index) => ({
        index: (page - 1) * pageSize + index + 1,
        phone: row.phone,
        createdAt: formatBeijing(row.createdAt)
      }))
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "查询用户失败。", 500);
  }
}
