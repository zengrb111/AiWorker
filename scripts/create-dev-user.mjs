import { randomBytes, scryptSync, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "../src/generated/prisma/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// 只加载 .env.local（Prisma CLI / Node 默认不读 .env.local）
function loadEnv(file) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
}
loadEnv(".env.local");

const PHONE = process.env.DEV_PHONE || "13800000000";
const PASSWORD = process.env.DEV_PASSWORD || "dev123456";

// 与 src/lib/password.ts 保持一致的 scrypt 加盐哈希
function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

const prisma = new PrismaClient();
const user = await prisma.user.upsert({
  where: { phone: PHONE },
  update: {},
  create: { phone: PHONE, passwordHash: hashPassword(PASSWORD) },
  select: { id: true, phone: true }
});

const secret = process.env.AUTH_SESSION_SECRET;
if (!secret) {
  console.error("AUTH_SESSION_SECRET 缺失，无法生成 Cookie");
  await prisma.$disconnect();
  process.exit(1);
}

const issuedAt = Date.now().toString();
const payload = `${user.id}.${issuedAt}`;
const sig = createHmac("sha256", secret).update(payload).digest("hex");
const token = `${payload}.${sig}`;

console.log(JSON.stringify({
  phone: user.phone,
  password: PASSWORD,
  userId: user.id,
  cookieName: "cx_session",
  cookieValue: token
}, null, 2));

await prisma.$disconnect();
