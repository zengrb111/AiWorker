import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * 平台凭据（Cookie 等）加密存储：AES-256-GCM。
 * 密钥保存在项目根 `.platform-cred.key`（首次使用自动生成，不进 git）。
 */

const KEY_FILE = path.join(process.cwd(), ".platform-cred.key");

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  let hex = "";
  try {
    hex = fs.readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    hex = "";
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    hex = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(KEY_FILE, hex, { mode: 0o600 });
  }
  cachedKey = Buffer.from(hex, "hex");
  return cachedKey;
}

/** 加密：返回 iv.authTag.ciphertext 的 base64 拼接串 */
export function encryptCredential(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

/** 解密失败抛错（视为凭据损坏） */
export function decryptCredential(packed: string): string {
  const [ivB64, tagB64, dataB64] = packed.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("credential_format_invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** 清理用户粘贴的 Cookie 字符串：去引号、去 "Cookie: " 前缀、合并换行 */
export function normalizeCookie(raw: string): string {
  return raw
    .trim()
    .replace(/^cookie\s*:\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("; ");
}
