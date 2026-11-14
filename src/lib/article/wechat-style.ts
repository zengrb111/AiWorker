import { escapeHtml } from "@/lib/escape";

/**
 * 统一文章排版引擎（公众号风格）。
 *
 * 大彬指定的视觉规范（见 2026-11-12 公众号编辑器截图，颜色由截图像素取色）：
 *  - 自然段标题：左侧一条橙红色竖线 + 深靛蓝加粗文字，17px。
 *    注意：这里的「标题」指正文里各自然段的标题，也就是原文里**整行加粗**的那些句子
 *    （如「**150 人，是一条分界线**」），不是整篇文章的大标题。
 *  - 正文：16px / 1.9 行高，重点词语或句子自动加粗（规则识别，不依赖模型）。
 *  - 配图：段落级居中插图，圆角。
 *
 * 输出是**全内联样式**的 HTML：微信公众号会过滤 <style> 和 class，
 * 只有 inline style 能活下来；同一份 HTML 也直接给官网详情页 innerHTML 用，
 * 因此官网不需要再写一套 CSS（healing.js / article.html 识别到标签即直出）。
 *
 * 纯函数、无 node 依赖：前端详情页预览与服务端各发布链路共用同一份输出，
 * 保证「平台看到的 = 公众号/官网看到的」。
 */

// ---------------------------------------------------------------------------
// 视觉常量
// ---------------------------------------------------------------------------

// 取自公众号编辑器截图的实际像素：标题文字 #1d2a8c、竖线 #e8562a。
// 之前用的 #1f4fd8 偏亮偏宝蓝，和截图里的深靛蓝不是一个色。
const ACCENT = "#e8562a"; // 竖线：橙红
const TITLE_BLUE = "#1d2a8c"; // 自然段标题文字：深靛蓝
const TEXT = "#333333";
const STRONG = "#111111";

const TITLE_BLOCK =
  "margin:26px 0 14px;padding:2px 0 2px 12px;border-left:4px solid " + ACCENT + ";";
const TITLE_TEXT_BASE =
  "line-height:1.5;font-weight:700;color:" + TITLE_BLUE + ";letter-spacing:.4px;";
const P_STYLE =
  "margin:0 0 16px;font-size:16px;line-height:1.9;color:" + TEXT + ";letter-spacing:.3px;word-break:break-word;";
const STRONG_STYLE = "font-weight:700;color:" + STRONG + ";";
const IMG_STYLE =
  "max-width:100%;width:100%;height:auto;border-radius:8px;display:block;margin:0 auto;";

export type RenderArticleOptions = {
  /** 自动给重点词句加粗，默认开 */
  autoBold?: boolean;
  /** 正文字号（默认 16px），官网窄栏可调小 */
  fontSize?: number;
  /** 是否把首个 h1 当主标题（19px），其余当小标题；默认 true */
  emphasizeFirstHeading?: boolean;
};

// ---------------------------------------------------------------------------
// 自动识别重点词句
// ---------------------------------------------------------------------------

/** 结论 / 转折 / 强调引导词：命中后把所在短分句加粗。 */
const CUE_RE =
  /(其实|事实上|关键是|核心是|最重要的是|本质是|结论是|答案是|问题在于|真相是|神奇的是|坑的是|最坑|千万别|记住|一定要|不是[^，。！？]{1,18}而是|为什么|为什么不做|不像|不一样|反而是|结果|所以说|说白了|换句话说|一句话)/;

/** 引号里的关键短语（中文引号 / 直角引号 / 英文双引号）。 */
const QUOTE_RE = /[「“"]([^「」“”"\n，。！？]{2,24})[」”"]/g;

/** 数字 + 单位：3 天、18 万粉、1000w+、60%、2 倍…… */
const NUMBER_RE = /\d+(?:\.\d+)?\s*(?:w\+?|W\+?|k\+?|K\+?|%|倍|天|小时|分钟|秒|个|篇|条|人|次|年|月|万|亿|粉|块|元)/g;

/**
 * 日期 / 时钟表达：只是时间状语，不是重点结论，整段屏蔽。
 * 覆盖「11 月 12 日」「今天（11 月 12 日）」「2026 年」「2026/11/12」「14:30」「3 点」。
 * 大彬 2026-11-12 反馈：正文开头「今天（11 月 12 日）」被自动加粗了，没必要。
 */
const DATE_BLOCK_RE =
  /(?:今天|昨天|明天|前天|近日|日前|当天|当日|截至)?\s*[（(]?\s*(?:\d{4}\s*[年/-]\s*)?\d{1,2}\s*[月/-]\s*\d{1,2}\s*[日号]?\s*[)）]?|\d{4}\s*年|\d{1,2}\s*[:：]\d{2}|\d{1,2}\s*点(?:半|\s*\d{1,2}\s*分?)?/g;

/** 单独的日历单位（「11 月」「2026 年」「12 月份」）也不算重点。 */
const CALENDAR_UNIT_RE = /^\d+(?:\.\d+)?\s*(?:年|月份|月|日|号)$/;

/** 整段加粗内容如果纯粹是日期时间状语，说明是旧版误加粗，再排版时清掉。 */
const DATE_ONLY_RE =
  /^(?:今天|昨天|明天|前天|近日|日前|当天|当日|据|截至|于|在)?\s*[（(]?\s*(?:\d{4}\s*[年/-]\s*)?\d{1,2}\s*[月/-]\s*\d{1,2}\s*[日号]?\s*[)）]?\s*(?:报道|消息|发布)?$/;

/**
 * 数字前面最多回带 4 个连续中英文字，遇到标点 / 括号 / 空格就停。
 * 旧写法是硬切 index-4，会把「今天（」这种无关前缀一起裹进加粗范围。
 */
function leadingStart(raw: string, index: number, max = 4): number {
  let i = index - 1;
  let n = 0;
  while (i >= 0 && n < max && /[\u4e00-\u9fa5A-Za-z]/.test(raw[i])) {
    i--;
    n++;
  }
  return i + 1;
}

/** 英文缩写/产品名词（AI、Agent、SaaS 等）。 */
const TERM_RE = /\b(?:AI|Agent|AIGC|API|SaaS|FDE|LLM|RAG|Workflow|Prompt)\b/g;

type Span = { start: number; end: number; score: number };

/**
 * 在一行纯文本里挑出值得加粗的片段。
 * 返回互不重叠、按优先级排序的区间。规则式、零成本、不依赖任何模型配置：
 * 模型没配好 / 限流 / 超时时排版照样能用，界面也不会冒出技术性报错。
 */
export function findHighlightSpans(raw: string, maxSpans = 2): Span[] {
  const spans: Span[] = [];
  const push = (start: number, end: number, score: number) => {
    if (end - start < 2 || end - start > 46) return;
    spans.push({ start, end, score });
  };

  let m: RegExpExecArray | null;

  // 0) 先把日期 / 时钟整段标成屏蔽区，下面的数字规则自动避开。
  DATE_BLOCK_RE.lastIndex = 0;
  const dateBlocks: Array<{ start: number; end: number }> = [];
  while ((m = DATE_BLOCK_RE.exec(raw)) !== null) {
    dateBlocks.push({ start: m.index, end: m.index + m[0].length });
  }

  // 1) 带引导词的结论分句：从引导词起，到最近的标点（或行尾）为止。
  const cue = CUE_RE.exec(raw);
  if (cue) {
    const start = cue.index;
    const rest = raw.slice(start);
    const stop = rest.search(/[，。！？；,\.!?;]/);
    const end = start + (stop > 2 ? Math.min(stop, 34) : Math.min(rest.length, 30));
    push(start, Math.min(end, raw.length), 100);
  }

  // 2) 引号里的关键短语（含引号一起加粗，视觉上更完整）。
  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(raw)) !== null) {
    push(m.index, m.index + m[0].length, 80);
  }

  // 3) 数字结论：连着前面 2~4 个连续中文字一起加粗（「3 天做出」比光一个「3 天」更像重点）。
  //    日期 / 时钟里的数字、以及单独的日历单位（11 月、2026 年）一律跳过。
  NUMBER_RE.lastIndex = 0;
  while ((m = NUMBER_RE.exec(raw)) !== null) {
    const hit = m;
    const end = hit.index + hit[0].length;
    if (CALENDAR_UNIT_RE.test(hit[0])) continue;
    if (dateBlocks.some((b) => hit.index < b.end && end > b.start)) continue;
    push(leadingStart(raw, hit.index), end, 60);
  }

  // 4) 产品/技术名词（兜底，避免某些段落一个重点都没有）。
  TERM_RE.lastIndex = 0;
  while ((m = TERM_RE.exec(raw)) !== null) {
    push(m.index, m.index + m[0].length, 20);
  }

  // 只有「AI / Agent」这类孤立名词、没有结论句/引号/数字时不加粗：
  // 宁缺毋滥，否则会出现满屏单词被涂黑、反而看不出重点（截图里这类段落就是纯正文）。
  if (spans.length && spans.every((s) => s.score <= 20)) return [];
  // 已经有结论句 / 数字 / 引号这类强重点时，也别再叠加孤立产品名词。
  if (spans.some((s) => s.score >= 60)) {
    for (let i = spans.length - 1; i >= 0; i--) {
      if (spans[i].score <= 20) spans.splice(i, 1);
    }
  }

  // 去重叠：高分优先，冲突的直接丢掉。
  spans.sort((a, b) => b.score - a.score || a.start - b.start);
  const picked: Span[] = [];
  for (const span of spans) {
    if (picked.some((p) => span.start < p.end && span.end > p.start)) continue;
    picked.push(span);
    if (picked.length >= maxSpans) break;
  }
  return picked.sort((a, b) => a.start - b.start);
}

/**
 * 把一行文本渲染成 HTML：先转义 → 保护已有 **加粗** → 按规则自动加粗 → 还原。
 * 自动加粗只作用于「还没有被用户显式标记」的部分。
 */
function inlineHtml(raw: string, autoBold: boolean): string {
  // 已有 **x** 先换成等长占位符，避免被自动加粗二次包裹或切断。
  const marks: string[] = [];
  let work = raw.replace(/\*\*(.+?)\*\*/g, (_all, inner: string) => {
    marks.push(inner);
    return `\u0001M${marks.length - 1}\u0001`;
  });

  // 屏蔽版与 work 等长，用来算下标；占位符所在区间不允许被自动加粗切开。
  const blocked: Span[] = [];
  const masked = work.replace(/\u0001M\d+\u0001/g, (token, offset: number) => {
    blocked.push({ start: offset, end: offset + token.length, score: 0 });
    return " ".repeat(token.length);
  });
  const realSpans = autoBold
    ? findHighlightSpans(masked).filter(
        (s) => !blocked.some((b) => s.start < b.end && s.end > b.start)
      )
    : [];

  // 逐段转义，避免「先整体转义再按下标插标签」造成下标漂移。
  let html = "";
  let cursor = 0;
  for (const span of realSpans) {
    if (span.start < cursor) continue;
    html += escapeHtml(work.slice(cursor, span.start));
    html += `<strong style="${STRONG_STYLE}">${escapeHtml(work.slice(span.start, span.end))}</strong>`;
    cursor = span.end;
  }
  html += escapeHtml(work.slice(cursor));

  // 行内其它 markdown：`*斜体*`、`代码`
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");

  // 还原用户显式加粗
  html = html.replace(/\u0001M(\d+)\u0001/g, (_all, idx: string) => {
    const inner = marks[Number(idx)] ?? "";
    return `<strong style="${STRONG_STYLE}">${escapeHtml(inner)}</strong>`;
  });
  return html;
}

// ---------------------------------------------------------------------------
// Markdown → 微信风格 HTML
// ---------------------------------------------------------------------------

function safeImageUrl(raw: string): string {
  const url = raw.trim();
  return /^(https?:\/\/|\/)/i.test(url) ? escapeHtml(url) : "";
}

/** 标题块：左侧橙红竖线 + 深靛蓝加粗文字（复刻截图里的自然段标题）。 */
function headingHtml(level: number, text: string, isMain: boolean): string {
  const size = isMain ? 19 : level <= 2 ? 17 : 16;
  return (
    `<section style="${TITLE_BLOCK}">` +
    `<span style="${TITLE_TEXT_BASE}font-size:${size}px;">${inlineHtml(text, false)}</span>` +
    `</section>`
  );
}

/**
 * 自然段标题 = 原文里「整行加粗」的那句标题（不是整篇文章的大标题）。
 * 允许前后挂 emoji / 序号 / 空白，对应截图里的「其实我做的很碎👇」「❌ 为什么不做大而全？」。
 *
 * 只认「整行就是这一句」：像 `**神奇的是它们自己搭档了**：照片书产内容…` 后面还带正文，
 * 仍然按普通段落渲染，加粗部分保持黑色，不会被误升级成蓝色标题块。
 */
const SECTION_TITLE_RE =
  /^([\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\u20E3\d\s]*)\*\*([^*\n]+)\*\*([\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\u20E3\s]*)$/u;

function sectionTitleText(trimmed: string): string | null {
  const m = SECTION_TITLE_RE.exec(trimmed);
  if (!m) return null;
  const inner = m[2].trim();
  if (inner.length < 2 || inner.length > 40) return null;
  if (/[。；;]$/.test(inner)) return null; // 以句号收尾的更像一句正文，不是标题
  return (m[1] + inner + m[3]).trim();
}

/**
 * 统一的正文渲染入口。
 * 前端详情页预览、复制到剪贴板、心灵驿站 / AI最前沿 / 公众号草稿箱都调它。
 */
export function renderArticleHtml(md: string, options: RenderArticleOptions = {}): string {
  const autoBold = options.autoBold !== false;
  const fontSize = options.fontSize ?? 16;
  const emphasizeFirst = options.emphasizeFirstHeading !== false;
  const pStyle = P_STYLE.replace("font-size:16px", `font-size:${fontSize}px`);

  const lines = (md || "").split("\n");
  const parts: string[] = [];
  let inList = false;
  let seenHeading = false;

  const closeList = () => {
    if (inList) {
      parts.push("</ul>");
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    // 配图：![alt](url)
    const img = trimmed.match(/^!\[(.*?)\]\(([^)]+)\)$/);
    if (img) {
      closeList();
      const url = safeImageUrl(img[2]);
      if (url) {
        parts.push(
          `<section style="margin:18px 0 22px;text-align:center;">` +
            `<img src="${url}" alt="${escapeHtml(img[1] || "配图")}" style="${IMG_STYLE}" />` +
            `</section>`
        );
      }
      continue;
    }

    // 标题：# / ## / ###
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const isMain = emphasizeFirst && !seenHeading && heading[1].length === 1;
      seenHeading = true;
      parts.push(headingHtml(heading[1].length, heading[2], isMain));
      continue;
    }

    // 自然段标题：原文里整行加粗的标题句 → 竖线 + 深靛蓝（不是文章大标题）
    const sectionTitle = sectionTitleText(trimmed);
    if (sectionTitle) {
      closeList();
      parts.push(headingHtml(2, sectionTitle, false));
      continue;
    }

    // 列表
    const listItem = trimmed.match(/^[-*+]\s+(.*)$/);
    if (listItem) {
      if (!inList) {
        parts.push(`<ul style="margin:0 0 16px;padding-left:22px;color:${TEXT};font-size:${fontSize}px;line-height:1.9;">`);
        inList = true;
      }
      parts.push(`<li style="margin:0 0 6px;">${inlineHtml(listItem[1], autoBold)}</li>`);
      continue;
    }

    // 引用
    if (trimmed.startsWith("> ")) {
      closeList();
      parts.push(
        `<blockquote style="margin:0 0 16px;padding:8px 14px;border-left:3px solid #d8d8d8;background:#f7f8fa;color:#555;font-size:${fontSize}px;line-height:1.85;">` +
          inlineHtml(trimmed.slice(2), autoBold) +
          `</blockquote>`
      );
      continue;
    }

    // 分隔线
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      closeList();
      parts.push(`<section style="margin:22px 0;border-top:1px solid #e8e8e8;"></section>`);
      continue;
    }

    closeList();
    parts.push(`<p style="${pStyle}">${inlineHtml(trimmed, autoBold)}</p>`);
  }
  closeList();
  return parts.join("\n");
}

/**
 * 把重点词句写回 Markdown（供「一键排版」按钮 / 需要持久化的场景）。
 * 已有 **加粗** 的行不动；每段最多 2 处。
 */
export function applyAutoBold(md: string): string {
  return (md || "")
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || /^(#{1,6}\s|!\[|[-*+]\s|> |[-*_]{3,})/.test(trimmed)) return line;
      // 旧版把「今天（11 月 12 日）」这类日期也加粗了，再点一次「一键排版」顺手清掉。
      const cleaned = line.replace(/\*\*([^*\n]{1,46})\*\*/g, (all, inner: string) =>
        DATE_ONLY_RE.test(inner.trim()) ? inner : all
      );
      if (cleaned.includes("**")) return cleaned;
      const spans = findHighlightSpans(cleaned);
      let out = "";
      let cursor = 0;
      for (const span of spans) {
        if (span.start < cursor) continue;
        out += cleaned.slice(cursor, span.start) + `**${cleaned.slice(span.start, span.end)}**`;
        cursor = span.end;
      }
      return out + cleaned.slice(cursor);
    })
    .join("\n");
}

/** 正文 → 摘要（去 markdown 标记与图片，供公众号 digest / 官网 summary）。 */
export function buildArticleDigest(md: string, maxLen = 120): string {
  const text = (md || "")
    .split("\n")
    .filter((line) => !/^#{1,6}\s+/.test(line.trim())) // 标题不进摘要，避免与公众号标题重复
    .join(" ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~>]/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxLen);
}

/** 提取正文里的配图地址（顺序即出现顺序），供草稿箱上传微信图床。 */
export function extractArticleImages(md: string): string[] {
  const out: string[] = [];
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md || "")) !== null) {
    const url = m[1].trim();
    if (/^(https?:\/\/|\/)/i.test(url)) out.push(url);
  }
  return out;
}

/** 把正文里的图片地址替换成微信图床 URL（草稿箱用）；值为空串时删除该图。 */
export function replaceArticleImages(md: string, replacements: Map<string, string>): string {
  return (md || "").replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (all, alt: string, url: string) => {
    const mapped = replacements.get(url.trim());
    if (mapped === undefined) return all;
    return mapped ? `![${alt}](${mapped})` : "";
  });
}

/** 微信 draft/add 的字段长度限制。 */
export function fitWechatTitle(title: string, max = 32): string {
  const t = (title || "").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * 把正文里的 /uploads/... 相对图地址改写成平台站的绝对 URL。
 * 两个官网是独立域名，直接用 /uploads/xxx 会 404；草稿箱不用这一步
 * （它要读本地文件再上传微信图床，相对路径正好合适）。
 */
export function absolutizeArticleImages(md: string, base?: string): string {
  const configured =
    typeof process !== "undefined" && process.env ? process.env.ARTICLE_PUBLIC_BASE_URL : undefined;
  const origin = (base || configured || "https://aiemployee.aimemory.cafe").replace(/\/+$/, "");
  return (md || "").replace(/!\[([^\]]*)\]\((\/[^)]+)\)/g, (_all, alt: string, url: string) => `![${alt}](${origin}${url})`);
}
