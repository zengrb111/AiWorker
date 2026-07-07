import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "./prisma";

const cookieName = "cx_session";
const maxAgeSeconds = 60 * 60 * 24 * 7;

function getSecret(): string {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret) {
    throw new Error("AUTH_SESSION_SECRET is not configured.");
  }
  return secret;
}

function sign(value: string): string {
  return createHmac("sha256", getSecret()).update(value).digest("hex");
}

export async function createSession(userId: string): Promise<void> {
  const issuedAt = Date.now().toString();
  const payload = `${userId}.${issuedAt}`;
  const token = `${payload}.${sign(payload)}`;

  cookies().set(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds
  });
}

export function clearSession(): void {
  cookies().set(cookieName, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  });
}

export function readSessionUserId(): string | null {
  const token = cookies().get(cookieName)?.value;
  if (!token) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [userId, issuedAt, signature] = parts;
  const payload = `${userId}.${issuedAt}`;
  const expected = sign(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }

  const age = Date.now() - Number(issuedAt);
  if (!Number.isFinite(age) || age > maxAgeSeconds * 1000) {
    return null;
  }

  return userId;
}

export async function requireUser() {
  const userId = readSessionUserId();
  if (!userId) {
    return null;
  }

  return prisma.user.findUnique({
    where: { id: userId }
  });
}
