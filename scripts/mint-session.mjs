import { createHmac } from "node:crypto";
import { PrismaClient } from "../src/generated/prisma/index.js";

const prisma = new PrismaClient();
try {
  const users = await prisma.user.findMany({ select: { id: true, phone: true } });
  console.log("USERS:", JSON.stringify(users));
} catch (e) {
  console.error("ERR:", e);
} finally {
  await prisma.$disconnect();
}
const secret = process.env.AUTH_SESSION_SECRET;
const userId = process.argv[2];
if (userId) {
  const issuedAt = Date.now().toString();
  const payload = `${userId}.${issuedAt}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  console.log("TOKEN:", `${payload}.${sig}`);
}
