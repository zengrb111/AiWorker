import { NextResponse } from "next/server";

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

/**
 * 统一错误响应。
 *
 * extra 用于附带结构化信息（如网关故障分类 kind），前端可据此展示不同提示，
 * 而不必从中文文案里做字符串匹配 —— 文案会变，分类不会。
 */
export function jsonError(
  message: string,
  status = 400,
  extra?: Record<string, unknown>
) {
  return NextResponse.json({ ok: false, error: message, ...(extra ?? {}) }, { status });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}
