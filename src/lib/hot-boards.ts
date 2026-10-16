/**
 * 内置公开热榜：零 key、零 token 的当日热点数据源。
 *
 * 为什么需要它：改造前「今日全网热点」并不依赖任何搜索 API —— OpenClaw 的
 * hot-topic-digest skill 直接抓公开热榜页面（web_search 在那台机器上是被禁用的）。
 * 迁移到应用内直连后，如果只留 Tavily/博查这两种需要付费 key 的搜索服务，
 * 就等于把「开箱即用的当日热点」降级成「先注册付费服务」，属于能力倒退。
 *
 * 公开榜不需要任何密钥，因此不涉及「密钥按用户隔离」的问题：用户配了自己的
 * 搜索服务时优先用用户的，没配时回落到这里。
 *
 * 实测要点（2026-10 于本机验证，容错策略据此设计）：
 * - 60s 系列返回 { code, data: [...] }，item 字段：weibo/toutiao/douyin 是
 *   title + hot_value + link；zhihu 多一个 detail（问题描述，可当摘要）。
 * - 60s 一次性突发请求多个端点会 429，所以这里并发但错峰发起。
 * - 60s 偶发 10s 级慢响应（weibo 首次实测 9.7s），故 weibo 只在前三个源全败时才补。
 * - 百度热搜数据嵌在 HTML 的 `<!--s-data:{...}-->` 注释里，字段 word / desc / hotScore / url。
 * - tophub.today 的页面结构已变（不再有 cc-cd-cb-l 列表节点），且与前两者重叠，
 *   故不实现，避免引入一个脆弱且冗余的依赖。
 */

export type HotBoardItem = {
  title: string;
  url: string;
  snippet: string;
  /** 数据来源标识：weibo / toutiao / douyin / zhihu / baidu */
  origin: string;
  /** 榜单热度值（各平台单位不可比，仅用于展示，不参与排序） */
  heat?: string;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** 主波端点超时：60s 平台与百度热搜实测都在 4s 内，10s 留足余量。 */
const FAST_TIMEOUT_MS = 10_000;
/** weibo 实测会慢到 10s，只有在前三个源全败时才去碰它。 */
const SLOW_TIMEOUT_MS = 15_000;

function clean(text: unknown, max = 160): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json, text/html;q=0.9" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 60s 系列：data 是数组，逐项按平台取字段。 */
async function fetch60s(
  path: string,
  origin: string,
  timeoutMs: number,
  snippetField?: string
): Promise<HotBoardItem[]> {
  const text = await fetchText(`https://60s.viki.moe/v2/${path}`, timeoutMs);
  const json = JSON.parse(text) as { code?: number; data?: unknown[] };
  if (json.code !== 200 || !Array.isArray(json.data)) {
    throw new Error(`${origin} 返回结构异常（code=${json.code ?? "?"}）`);
  }
  const items: HotBoardItem[] = [];
  for (const raw of json.data) {
    const row = raw as Record<string, unknown>;
    const title = clean(row.title);
    if (!title) continue;
    items.push({
      title,
      url: clean(row.link, 400),
      snippet: clean(snippetField ? row[snippetField] : "") || `来自 ${origin} 热榜`,
      origin,
      heat: clean(row.hot_value ?? row.hot_value_desc, 24) || undefined
    });
  }
  if (!items.length) throw new Error(`${origin} 返回空榜单`);
  return items;
}

/** 百度热搜：榜单 JSON 藏在 HTML 注释里。 */
async function fetchBaiduHotBoard(timeoutMs: number): Promise<HotBoardItem[]> {
  const html = await fetchText("https://top.baidu.com/board?tab=realtime", timeoutMs);
  // 不用 /s（dotAll）标志：项目 tsconfig 的 target 低于 es2018
  const match = html.match(/<!--s-data:([\s\S]*?)-->/);
  if (!match) throw new Error("百度热搜页面结构变化，未找到 s-data 数据块");
  const json = JSON.parse(match[1]) as {
    data?: { cards?: Array<{ content?: Array<Record<string, unknown>> }> };
  };
  const content = json.data?.cards?.[0]?.content ?? [];
  const items: HotBoardItem[] = [];
  for (const row of content) {
    const title = clean(row.word);
    if (!title) continue;
    items.push({
      title,
      url: clean(row.rawUrl || row.url, 400),
      snippet: clean(row.desc) || "来自百度热搜榜",
      origin: "baidu",
      heat: clean(row.hotScore, 24) || undefined
    });
  }
  if (!items.length) throw new Error("百度热搜返回空榜单");
  return items;
}

/**
 * 跨榜去重 + 交错合并。
 *
 * 各平台热度值单位不可比（微博是万、知乎是关注人数），按数值排序会失真；
 * 而各平台榜单自身已经按热度排好序，所以这里按榜单顺序轮询交错：
 * 既保留了各榜的原始排序，又避免前 N 条全来自同一个平台。
 */
function mergeBoards(groups: HotBoardItem[][], limit: number): HotBoardItem[] {
  const seen = new Set<string>();
  const queues = groups.map((group) => {
    const unique: HotBoardItem[] = [];
    for (const item of group) {
      // 标题归一化后去重：同一件事常同时出现在多个平台（这本身就是热点信号）
      // 只剥离空白与常见中英文标点，避免"同义不同字"的重复条目挤占名额
      const fingerprint = item.title
        .replace(/[\s·、，。！？!?,.:：;；"'“”‘’()（）《》【】\-—_]/g, "")
        .slice(0, 24);
      if (!fingerprint || seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      unique.push(item);
    }
    return unique;
  });

  const merged: HotBoardItem[] = [];
  for (let round = 0; merged.length < limit; round += 1) {
    let progressed = false;
    for (const queue of queues) {
      if (round >= queue.length) continue;
      progressed = true;
      merged.push(queue[round]);
      if (merged.length >= limit) break;
    }
    if (!progressed) break;
  }
  return merged;
}

/**
 * 拉取当日全网热榜。
 *
 * 策略：主波并发抓 toutiao / douyin / zhihu / 百度（错峰 250ms，避免 60s 限流）。
 * 拿到 2 个源就收工 —— 交错合并需要至少两个榜才有意义，而死等最慢的那个端点
 * （实测 toutiao/weibo 偶发 10s 级慢响应）会把整体拖到 10s+，用户体感是"卡住"。
 * 四个源全败才补 weibo。
 */
export async function fetchHotBoards(limit = 20): Promise<HotBoardItem[]> {
  const waves: Array<{ name: string; run: () => Promise<HotBoardItem[]> }> = [
    { name: "toutiao", run: () => fetch60s("toutiao", "toutiao", FAST_TIMEOUT_MS) },
    { name: "douyin", run: () => fetch60s("douyin", "douyin", FAST_TIMEOUT_MS) },
    { name: "zhihu", run: () => fetch60s("zhihu", "zhihu", FAST_TIMEOUT_MS, "detail") },
    { name: "baidu", run: () => fetchBaiduHotBoard(FAST_TIMEOUT_MS) }
  ];

  const failures: string[] = [];
  const groups: HotBoardItem[][] = [];
  let settled = 0;

  // 错峰发起：并发能压到 4~5s，但同一时刻打四个会触发 60s 的 429
  for (const [index, wave] of waves.entries()) {
    void sleep(index * 250)
      .then(() => wave.run())
      .then(
        (items) => {
          groups.push(items);
        },
        (error: unknown) => {
          failures.push(`${wave.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      )
      .finally(() => {
        settled += 1;
      });
  }

  // 死等所有源会被最慢的那个拖垮（实测 douyin/weibo 偶发 10s 级）。
  // 收工条件：拿到 2 个源；或只有 1 个源但已经等满 3.5s（单个榜也有 50 条，够用）；
  // 全部失败才一路等到结束并补 weibo。
  const startedAt = Date.now();
  while (settled < waves.length && groups.length < 2) {
    if (groups.length >= 1 && Date.now() - startedAt >= 3500) break;
    await sleep(150);
  }
  if (groups.length >= 1 && settled < waves.length) {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && settled < waves.length) {
      await sleep(120);
    }
  }

  if (!groups.length) {
    try {
      groups.push(await fetch60s("weibo", "weibo", SLOW_TIMEOUT_MS));
    } catch (error) {
      failures.push(`weibo: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const merged = mergeBoards(groups, limit);
  if (!merged.length) {
    throw new Error(`所有公开热榜源都不可用（${failures.join("；") || "无响应"}）`);
  }
  if (failures.length) {
    console.warn(`[hot-boards] 部分榜单未取到：${failures.join("；")}`);
  }
  return merged;
}

/** 供日志与提示使用：本次实际拿到哪些榜。 */
export function describeOrigins(items: HotBoardItem[]): string {
  return [...new Set(items.map((item) => item.origin))].join("/");
}
