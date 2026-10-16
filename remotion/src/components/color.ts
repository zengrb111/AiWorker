/**
 * 颜色工具：主题驱动的背景/光效需要频繁在 hex 与 rgb 之间换算。
 *
 * 迁移自 OpenMontage/remotion-composer/src/Explainer.tsx，抽出成独立模块供所有组件复用，
 * 避免各组件各写一份。
 */

/** #rgb / #rrggbb → {r,g,b}（0~255）。非法输入回落到黑色，绝不抛错。 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = (hex ?? "").replace("#", "").trim();
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const bigint = Number.parseInt(full, 16);
  if (!Number.isFinite(bigint) || full.length < 6) return { r: 0, g: 0, b: 0 };
  return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
}

/** 感知亮度（ITU-R BT.601 权重），用于决定前景该用深色还是浅色。 */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

/** 背景是否偏亮。亮底与暗底的网格线、遮罩、描边策略完全不同，必须分开处理。 */
export function isLightColor(hex: string): boolean {
  return luminance(hex) > 128;
}

/** 向黑/白混合。amount > 0 提亮，< 0 压暗。 */
export function shiftColor(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  if (amount < 0) {
    const f = 1 + amount;
    return `rgb(${clamp(r * f)}, ${clamp(g * f)}, ${clamp(b * f)})`;
  }
  return `rgb(${clamp(r + (255 - r) * amount)}, ${clamp(g + (255 - g) * amount)}, ${clamp(
    b + (255 - b) * amount,
  )})`;
}

/** 半透明 rgba。 */
export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 铺在主标题后面的柔光底。
 *
 * 必须和主题文字色反向取色：暗底上的深色文字如果再压深色遮罩，对比度会掉到 3.4:1
 * 以下（这是本地版踩过的对比度事故，反过来同理）。
 */
export function heroScrim(backgroundColor: string): string {
  const { r, g, b } = hexToRgb(isLightColor(backgroundColor) ? "#FFFFFF" : "#0F172A");
  return `radial-gradient(ellipse at center, rgba(${r},${g},${b},0.35) 0%, rgba(${r},${g},${b},0.55) 100%)`;
}