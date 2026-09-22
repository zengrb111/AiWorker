/**
 * 从平台账号库解密小红书 Cookie，回写 .xhs-cookie.txt（供 CDP 采集器使用）。
 * 用途：授权管理里更新授权后，让本地采集器与库内凭据保持一致。
 *   node scripts/xhs-restore-cookie.mjs
 */
import { PrismaClient } from "../src/generated/prisma/index.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const KEY_FILE = path.join(ROOT, ".platform-cred.key");

function getKey() {
  const hex = fs.readFileSync(KEY_FILE, "utf8").trim();
  return Buffer.from(hex, "hex");
}

function decryptCredential(packed) {
  const [ivB64, tagB64, dataB64] = packed.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

const prisma = new PrismaClient();
const account = await prisma.platformAccount.findFirst({
  where: { platform: "xhs", status: { not: "expired" } },
  orderBy: { createdAt: "desc" },
});
if (!account?.credentialEnc) {
  console.error("FAILED: 库中没有有效的小红书授权账号");
  process.exit(1);
}
const cookie = decryptCredential(account.credentialEnc);
fs.writeFileSync(path.join(ROOT, ".xhs-cookie.txt"), cookie, "utf8");
console.log(`OK: 已回填 .xhs-cookie.txt（账号 ${account.displayName} / ${account.externalId}，cookie ${cookie.length} 字符）`);
await prisma.$disconnect();
