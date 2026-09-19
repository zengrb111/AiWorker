/**
 * 小红书爆款链接解析：直接抓取笔记详情页 HTML，提取页面内嵌的 window.__INITIAL_STATE__
 * 结构化数据，解析出标题 / 正文 / 话题标签 / 作者 / 形式等，供「一键仿写爆款」使用。
 *
 * 说明：
 * - 小红书笔记页为 SSR，__INITIAL_STATE__ 在页面 HTML 中即可取到，无需登录。
 * - 服务端直连可能被风控/网络拦截，本模块为 best-effort：解析失败返回 null，
 *   调用方应回退到「让模型自行抓取」的旧逻辑。
 */

export type XhsNote = {
  title: string;
  desc: string;
  topics: string[];
  author: string;
  ipLocation?: string;
  type?: string;
  coverImages: string[];
};

/** 从 HTML 中定位并切出 __INITIAL_STATE__ 的 JSON 对象（括号配平，忽略字符串内的括号）。 */
function extractInitialState(html: string): unknown | null {
  const candidates = ["window.__INITIAL_STATE__=", "__INITIAL_STATE__="];
  let start = -1;
  let marker = "";
  for (const m of candidates) {
    const idx = html.indexOf(m);
    if (idx !== -1) {
      start = idx + m.length;
      marker = m;
      break;
    }
  }
  if (start === -1) return null;

  // 跳过赋值后的空白
  while (start < html.length && (html[start] === " " || html[start] === "\n" || html[start] === "\t")) start++;
  if (html[start] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
  }
  if (end === -1) return null;

  const json = html.slice(start, end);
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function extractTopics(desc: string, tagList: unknown): string[] {
  const set = new Set<string>();
  const re = /#([^#\s，。！？]+)#?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(desc)) !== null) {
    if (m[1]) set.add(m[1]);
  }
  if (Array.isArray(tagList)) {
    for (const t of tagList) {
      const name = typeof t === "string" ? t : (t as { name?: string })?.name;
      if (name) set.add(name);
    }
  }
  return [...set];
}

function collectImages(note: Record<string, any>): string[] {
  const imgs: string[] = [];
  const push = (u?: string) => {
    if (u && /^https?:\/\//.test(u)) imgs.push(u);
  };
  const imageList = note?.imageList;
  if (Array.isArray(imageList)) {
    for (const it of imageList) {
      push(it?.infoList?.[0]?.url || it?.url || it?.urlDefault);
    }
  }
  push(note?.cover?.url || note?.video?.cover?.url);
  return imgs.slice(0, 9);
}

export async function fetchXiaohongshuNote(url: string, timeoutMs = 12000): Promise<XhsNote | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": "https://www.xiaohongshu.com/"
      },
      redirect: "follow",
      signal: controller.signal
    });
    if (!res.ok) return null;
    const html = await res.text();
    const state = extractInitialState(html) as Record<string, any> | null;
    if (!state) return null;

    const noteDetailMap = state?.note?.noteDetailMap;
    if (!noteDetailMap || typeof noteDetailMap !== "object") return null;
    const note = Object.values(noteDetailMap)[0] as { note?: Record<string, any> } | undefined;
    const target = note?.note;
    if (!target) return null;

    const desc: string = target.desc || "";
    const title: string = target.title || "";
    if (!title && !desc) return null;

    return {
      title,
      desc,
      topics: extractTopics(desc, target.tagList),
      author: target.user?.nickname || target.author?.nickname || "",
      ipLocation: target.ipLocation || "",
      type: target.type === 1 ? "视频笔记" : target.type === 0 ? "图文笔记" : "",
      coverImages: collectImages(target)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 把解析结果拼成可注入 prompt 的文本块。 */
export function formatXhsForPrompt(note: XhsNote): string {
  const lines: string[] = [];
  lines.push("【爆款原文（已从小红书页面 INITIAL_STATE 解析，可直接基于真实内容拆解/仿写）】");
  if (note.type) lines.push(`形式：${note.type}`);
  if (note.author) lines.push(`作者：${note.author}${note.ipLocation ? `（${note.ipLocation}）` : ""}`);
  if (note.title) lines.push(`标题：${note.title}`);
  if (note.desc) lines.push(`正文：\n${note.desc}`);
  if (note.topics.length) lines.push(`话题标签：${note.topics.map((t) => `#${t}`).join(" ")}`);
  return lines.join("\n");
}
