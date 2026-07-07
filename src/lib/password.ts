import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const keyLength = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, keyLength).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) {
    return false;
  }

  const candidate = scryptSync(password, salt, keyLength);
  const stored = Buffer.from(hash, "hex");
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}
