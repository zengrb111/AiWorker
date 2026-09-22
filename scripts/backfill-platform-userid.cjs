const { PrismaClient } = require("../src/generated/prisma");
const prisma = new PrismaClient();
const DABIN_PHONE = "13321118307";
async function main() {
  const dabin = await prisma.user.findUnique({ where: { phone: DABIN_PHONE } });
  if (!dabin) throw new Error("未找到主理人账号 " + DABIN_PHONE);
  const uid = dabin.id;
  console.log("回填目标用户:", uid, dabin.phone);
  const a = await prisma.platformAccount.updateMany({ data: { userId: uid } });
  console.log("PlatformAccount 更新:", a.count);
  const c = await prisma.platformContentMetric.updateMany({ data: { userId: uid } });
  console.log("PlatformContentMetric 更新:", c.count);
  const s = await prisma.platformSiteMetric.updateMany({ data: { userId: uid } });
  console.log("PlatformSiteMetric 更新:", s.count);
}
main().then(()=>prisma.$disconnect()).catch((e)=>{console.error("回填失败:",e.message);process.exit(1);});
