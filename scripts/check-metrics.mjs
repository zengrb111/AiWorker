import { PrismaClient } from "../src/generated/prisma/index.js";

const prisma = new PrismaClient();
try {
  const total = await prisma.platformContentMetric.count();
  console.log("TOTAL rows:", total);
  const byPlat = await prisma.platformContentMetric.groupBy({
    by: ["platform"],
    _count: { _all: true },
    _max: { metricDate: true },
  });
  console.log("BY PLATFORM:", JSON.stringify(byPlat, null, 2));
  const byDate = await prisma.platformContentMetric.groupBy({
    by: ["platform", "metricDate"],
    _count: { _all: true },
    orderBy: [{ platform: "asc" }, { metricDate: "desc" }],
    take: 30,
  });
  console.log("BY PLAT+DATE:", JSON.stringify(byDate, null, 2));
  const top = await prisma.platformContentMetric.findMany({
    orderBy: { updatedAt: "desc" },
    take: 8,
    select: { platform: true, contentKey: true, title: true, metricDate: true, views: true },
  });
  console.log("LATEST 8 rows:", JSON.stringify(top, null, 2));
  const accounts = await prisma.platformAccount.findMany({ select: { platform: true, displayName: true, status: true, lastSyncAt: true } });
  console.log("ACCOUNTS:", JSON.stringify(accounts, null, 2));
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  await prisma.$disconnect();
}
