import { chatComplete } from "@/lib/llm-client";

/**
 * 文章智能配图：理解大意 → 在文章开头 + 各大意段落前插 3 张左右配图。
 *
 * 「大意」分两层：
 *  - 规则层（必成功）：按 Markdown 标题 / 空行分出意义段落，取标题与首句作为主题。
 *  - 模型层（可选增强）：把主题改写成更适合生图的英文画面描述；模型没配好、
 *    限流、超时、返回格式不对时全部静默降级到规则层，界面不出现任何技术性报错。
 *
 * 配图直接写进正文 Markdown（![AI配图…](…)），因为正文是所有下游渠道的唯一输入：
 * 平台详情页、心灵驿站、AI最前沿、公众号草稿箱会自动在同一位置看到同一张图。
 */

const IMAGE_ALT = "AI配图";
const STYLE_SUFFIX =
  "minimalist flat editorial illustration, soft blue and warm orange palette, clean geometric composition, generous negative space, absolutely no text, no letters, no words, no watermark, high quality";

export type IllustrationSpot = {
  /** 插图放在这一行之前（行索引） */
  beforeLine: number;
  /** 该处的大意主题 */
  topic: string;
};

/** 去掉上一次自动生成的配图，保证重复点「生成配图」不会越插越多。 */
export function stripAutoIllustrations(md: string): string {
  return (md || "")
    .split("\n")
    .filter((line) => !new RegExp(`^!\\[${IMAGE_ALT}[^\\]]*\\]\\([^)]*\\)\\s*$`).test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function cleanTopic(text: string): string {
  return text
    .replace(/^#{1,6}\s+/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\*\*|\*|`|>|\|/g, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/[「」“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 44);
}

function firstSentence(text: string): string {
  const clean = cleanTopic(text);
  const stop = clean.search(/[。！？!?；;]/);
  return (stop > 8 ? clean.slice(0, stop) : clean).slice(0, 42);
}

/**
 * 找出 3 个插图位：文章开头 1 个 + 两个「大意段落」前各 1 个。
 * 段落少时自动减到 2 张，始终控制在「3 张左右」。
 */
export function planIllustrationSpots(md: string): IllustrationSpot[] {
  const lines = stripAutoIllustrations(md).split("\n");
  const meaningful = (i: number) => {
    const t = (lines[i] || "").trim();
    return !!t && !/^!\[/.test(t) && !/^([-*_])\1{2,}$/.test(t);
  };
  const headingIdx: number[] = [];
  lines.forEach((line, i) => {
    if (/^#{1,6}\s+/.test(line.trim())) headingIdx.push(i);
  });

  const title = cleanTopic(
    lines.find((l) => /^#\s+/.test(l.trim())) || lines.find((_l, i) => meaningful(i)) || ""
  );
  const lead = firstSentence(lines.find((l, i) => meaningful(i) && !/^#{1,6}\s/.test(l.trim())) || title);

  // 开头：第一个标题之后（有标题时），否则第一行之后。
  const firstHeading = headingIdx.length ? headingIdx[0] : -1;
  const openAt = firstHeading >= 0 ? firstHeading + 1 : Math.max(0, lines.findIndex((_l, i) => meaningful(i)) + 1);

  const spots: IllustrationSpot[] = [
    { beforeLine: Math.min(openAt, lines.length), topic: [title, lead].filter(Boolean).join(" · ") }
  ];

  // 段落锚点：跳过紧挨主标题的第一个小标题（否则第 2 张图会贴着开头图），
  // 用中后段的小标题 + 正文段落等分补齐，保证配图分散在整篇里。
  const minGap = openAt + 3;
  const anchors: number[] = headingIdx.filter((i) => i >= minGap);
  const paraIdx: number[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t && !/^#{1,6}\s/.test(t) && !/^!\[/.test(t) && !/^[-*+]\s/.test(t)) paraIdx.push(i);
  });
  for (const i of paraIdx) {
    if (!anchors.includes(i) && i >= minGap) anchors.push(i);
    if (anchors.length >= 6) break;
  }
  anchors.sort((a, b) => a - b);

  // 等距挑 2 个（约 1/3 与 2/3 处），避免两张图挤在一起。
  const picked: number[] = [];
  if (anchors.length === 1) picked.push(anchors[0]);
  else if (anchors.length >= 2) {
    const a = anchors[Math.floor(anchors.length / 3)];
    const b = anchors[Math.floor((anchors.length * 2) / 3)];
    picked.push(a);
    if (b !== a) picked.push(b);
  }

  for (const idx of picked) {
    if (idx <= openAt) continue;
    const heading = cleanTopic(lines[idx] || "");
    const following = firstSentence(lines.slice(idx + 1, idx + 5).find((l) => l.trim()) || "");
    spots.push({
      beforeLine: idx,
      topic: [heading, following].filter(Boolean).join(" · ") || title
    });
  }
  return spots.slice(0, 3);
}

/** 规则层：主题 → 生图提示词。 */
export function buildIllustrationPrompts(spots: IllustrationSpot[]): string[] {
  return spots.map((s, i) =>
    [
      i === 0 ? "editorial hero illustration" : "section illustration",
      `about ${s.topic}`,
      STYLE_SUFFIX
    ].join(", ")
  );
}

/**
 * 模型层（可选）：让模型读整篇，把 3 个主题改写成更贴「文章大意」的画面描述。
 * 任何异常都吞掉并返回原提示词——排版/配图绝不能被模型配置状态阻塞。
 */
export async function enhanceIllustrationPrompts(
  userId: string,
  title: string,
  md: string,
  prompts: string[],
  topics: string[]
): Promise<string[]> {
  try {
    const excerpt = stripAutoIllustrations(md).replace(/!\[[^\]]*\]\([^)]*\)/g, "").slice(0, 3500);
    const result = await chatComplete({
      userId,
      capability: "chat",
      temperature: 0.7,
      maxTokens: 500,
      timeoutMs: 20000,
      messages: [
        {
          role: "system",
          content:
            "你是杂志美术编辑。根据文章大意，为每张配图写一句英文画面描述（供 AI 生图）。" +
            "只输出 JSON 数组，元素是与输入数量相同的字符串，不要解释、不要 markdown 代码块。" +
            "描述要具体有画面感，统一简约扁平插画风，明确不要任何文字/字母/水印。"
        },
        {
          role: "user",
          content:
            `文章标题：${title}\n需要 ${prompts.length} 张配图（第 1 张在开头，其余在各段前）。\n` +
            `当前主题：${JSON.stringify(topics.map((t, i) => `第${i + 1}张：${t}`))}\n\n` +
            `文章正文：\n${excerpt}`
        }
      ]
    });
    const raw = (result.content || "").trim().replace(/^```(?:json)?|```$/g, "").trim();
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start < 0 || end <= start) return prompts;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return prompts;
    const enhanced = prompts.map((fallback, i) => {
      const v = parsed[i];
      return typeof v === "string" && v.trim().length > 12
        ? `${v.trim().slice(0, 260)}, ${STYLE_SUFFIX}`
        : fallback;
    });
    return enhanced;
  } catch {
    return prompts;
  }
}

/**
 * 把生成好的图片地址按位置插进正文。倒序插入，避免下标漂移。
 */
export function insertIllustrations(md: string, spots: IllustrationSpot[], urls: string[]): string {
  const lines = stripAutoIllustrations(md).split("\n");
  const pairs = spots
    .map((spot, i) => ({ spot, url: urls[i] }))
    .filter((p): p is { spot: IllustrationSpot; url: string } => !!p.url)
    .sort((a, b) => b.spot.beforeLine - a.spot.beforeLine);

  for (const { spot, url } of pairs) {
    const topic = spot.topic.replace(/[\[\]\n]/g, " ").slice(0, 24);
    const at = Math.max(0, Math.min(spot.beforeLine, lines.length));
    lines.splice(at, 0, `![${IMAGE_ALT}·${topic}](${url})`, "");
  }
  return lines
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n");
}
