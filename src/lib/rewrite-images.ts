/**
 * 仿写文字图生成（「一键仿写爆款」小红书链路）。
 *
 * 流程：把 LLM 仿写出的正文按语义拆成若干「文字卡」——数量不固定，按正文实际需要
 * 拆分（有「**小标题**」就按模块切，没有就按段落凑够每张约 120~160 字）。每张卡用
 * SVG 渲染成一张小红书竖版（3:4）文字图（渐变底 + 干净中文排版），存到本地
 * public/uploads/covers/，返回可访问的 URL 数组。
 *
 * 为什么用 SVG 而不是图片模型：
 *   AI 生图模型输出的中文必有错字，文字图必须服务端精确排版。SVG 矢量、文字 100%
 *   清晰、零第三方依赖、可直接 <img> 展示也可打包进 zip 下载。
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOCAL_IMAGES_DIR, type CoverPlatform } from "@/lib/image-gen";

const W = 1080;
const H = 1440;
const MARGIN = 96;

/** 同色系、差异化的渐变（与品牌蓝/青/暖调一致）。 */
const PALETTES: Array<{ from: string; to: string; accent: string }> = [
  { from: "#2b6cff", to: "#17bfff", accent: "#ffd166" },
  { from: "#7b5cff", to: "#2b8cff", accent: "#9be7ff" },
  { from: "#ff7a59", to: "#ff4d6d", accent: "#ffe066" },
  { from: "#11998e", to: "#38efc6", accent: "#eafff6" },
  { from: "#f7971e", to: "#ffd200", accent: "#fff7e6" },
  { from: "#3a1c71", to: "#4a7bd6", accent: "#d9c2ff" }
];

type Card = { heading: string; text: string };

function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) {
      lines.push("");
      continue;
    }
    let cur = "";
    for (const ch of para) {
      cur += ch;
      if (cur.length >= maxChars) {
        lines.push(cur);
        cur = "";
      }
    }
    if (cur) lines.push(cur);
  }
  return lines.filter((l, i, arr) => !(l === "" && i === arr.length - 1));
}

/** 按字符数把一段文字切成多张卡（用于无小标题时兜底）。 */
function chunkByChars(text: string, max: number): string[] {
  const paras = text
    .split("\n")
    .map((s) => s.replace(/^[*-]\s+/, "").trim())
    .filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf && (buf + "\n" + p).length > max) {
      out.push(buf.trim());
      buf = p;
    } else {
      buf = buf ? `${buf}\n${p}` : p;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [text];
}

/**
 * 把仿写正文拆成文字卡：
 * - 第 0 张：标题卡（展示文章标题）。
 * - 其余：按「**小标题**」模块切；单段过长则再按字符数二次拆分。
 * - 数量动态，最多 9 张。
 */
export function splitRewriteIntoCards(title: string, body: string): Card[] {
  const lines = body.split("\n").map((l) => l.trim());
  const sections: Card[] = [];
  let heading = "";
  let buf: string[] = [];

  const flush = () => {
    const text = buf.filter(Boolean).join("\n");
    if (heading || text) sections.push({ heading, text });
    heading = "";
    buf = [];
  };

  for (const line of lines) {
    if (!line) continue;
    const bold = line.match(/^\*\*(.+?)\*\*\s*$/);
    if (bold) {
      if (heading || buf.length) flush();
      heading = bold[1].trim();
      continue;
    }
    if (line.startsWith("#")) continue;
    buf.push(line);
  }
  flush();

  const cards: Card[] = [{ heading: "", text: title }];

  if (sections.length === 0) {
    const flat = body
      .replace(/[#*>`~]/g, "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n");
    for (const t of chunkByChars(flat, 120)) cards.push({ heading: "", text: t });
  } else {
    for (const s of sections) {
      if (!s.heading && !s.text.trim()) continue;
      if (s.text.length > 200) {
        const chunks = chunkByChars(s.text, 160);
        chunks.forEach((t, i) => cards.push({ heading: i === 0 ? s.heading : "", text: t }));
      } else {
        cards.push({ heading: s.heading, text: s.text });
      }
    }
  }

  return cards.slice(0, 9);
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSvg(card: Card, index: number, total: number): string {
  const pal = PALETTES[index % PALETTES.length];
  const isTitle = index === 0;

  const kicker = isTitle ? "AI 回忆录 · 爆款仿写" : "仿写主图";
  const headingLines = card.heading ? wrap(card.heading, 13) : [];
  const bodyLines = isTitle ? wrap(card.text, 11) : wrap(card.text, 22);

  const headingSizes = isTitle ? 78 : 62;
  const headingLead = isTitle ? 98 : 82;
  const bodySize = isTitle ? 46 : 40;
  const bodyLead = isTitle ? 64 : 58;

  let cursor = 250;
  const parts: string[] = [];

  // 顶部 kicker
  parts.push(
    `<text x="${MARGIN}" y="150" font-family="-apple-system,'PingFang SC','Microsoft YaHei',sans-serif" font-size="34" font-weight="600" fill="#ffffff" fill-opacity="0.78" letter-spacing="2">${escXml(kicker)}</text>`
  );

  if (headingLines.length) {
    for (const ln of headingLines) {
      parts.push(
        `<text x="${MARGIN}" y="${cursor}" font-family="-apple-system,'PingFang SC','Microsoft YaHei',sans-serif" font-size="${headingSizes}" font-weight="800" fill="#ffffff">${escXml(ln)}</text>`
      );
      cursor += headingLead;
    }
    // 分隔线
    parts.push(
      `<rect x="${MARGIN}" y="${cursor - headingLead + 18}" width="120" height="8" rx="4" fill="${pal.accent}" />`
    );
    cursor += 28;
  }

  for (const ln of bodyLines) {
    parts.push(
      `<text x="${MARGIN}" y="${cursor}" font-family="-apple-system,'PingFang SC','Microsoft YaHei',sans-serif" font-size="${bodySize}" font-weight="500" fill="#f4f8ff" fill-opacity="0.96">${escXml(ln)}</text>`
    );
    cursor += bodyLead;
  }

  if (isTitle) {
    parts.push(
      `<text x="${MARGIN}" y="${H - 150}" font-family="-apple-system,'PingFang SC','Microsoft YaHei',sans-serif" font-size="34" font-weight="500" fill="#ffffff" fill-opacity="0.82">本图由 AI 基于爆款原文改写生成</text>`
    );
  }

  // 底部页码
  parts.push(
    `<text x="${MARGIN}" y="${H - 90}" font-family="-apple-system,'PingFang SC','Microsoft YaHei',sans-serif" font-size="30" font-weight="600" fill="#ffffff" fill-opacity="0.6">金润瀚宇   ·   ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</text>`
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="g${index}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${pal.from}" />
      <stop offset="100%" stop-color="${pal.to}" />
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g${index})" />
  <rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="28" fill="#ffffff" fill-opacity="0.06" />
  ${parts.join("\n  ")}
</svg>`;
}

/**
 * 生成仿写文字图，返回本地可访问 URL 数组（数量 = 拆分出的卡数，动态）。
 */
export async function generateRewriteImages(
  title: string,
  body: string,
  _platform: CoverPlatform = "xhs"
): Promise<string[]> {
  const cards = splitRewriteIntoCards(title, body);
  await mkdir(LOCAL_IMAGES_DIR, { recursive: true });
  const urls: string[] = [];
  for (let i = 0; i < cards.length; i++) {
    const svg = buildSvg(cards[i], i, cards.length);
    const filename = `${randomUUID()}.svg`;
    await writeFile(path.join(LOCAL_IMAGES_DIR, filename), svg, "utf8");
    urls.push(`/uploads/covers/${filename}`);
  }
  return urls;
}
