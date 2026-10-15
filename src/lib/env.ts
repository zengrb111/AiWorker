/**
 * 环境变量读取小工具。
 *
 * 单独抽出来是因为这个坑很容易踩：
 *   Number(process.env.X) ?? 3000   // env 未设置时得到 NaN，不是 3000
 * `??` 只对 null / undefined 生效，Number(undefined) 是 NaN，会一路传进
 * setTimeout() 变成「Timeout duration was set to 1」这种完全看不出原因的超时。
 */

function raw(name: string): string {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

/** 读非空字符串；未设置或只有空白返回空串。 */
export function readStringEnv(name: string): string {
  return raw(name);
}

/**
 * 读正数；未设置、非法、<=0 时返回 fallback。
 * 需要允许 0 的场景请直接用 readStringEnv 自行判断。
 */
export function readPositiveNumberEnv(name: string, fallback: number): number {
  const parsed = Number(raw(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 读 >= min 的整数（并发数这类需要取整的）。 */
export function readIntEnv(name: string, fallback: number, min = 1): number {
  const value = raw(name);
  // 必须先判空：Number("") 是 0 而不是 NaN，会被误当成"用户显式设成 0"
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

/** 读布尔值：1/true/yes/on 视为真。 */
export function readBoolEnv(name: string, fallback = false): boolean {
  const value = raw(name).toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
