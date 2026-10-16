/**
 * 新闻配图检索：零 key 的图片直链来源。
 *
 * 背景：改造前「一键生成视频」的配图来自 OpenClaw 的 web-link-sourcing skill，
 * 它用百度图片搜索的 JSON 端点拿直链（其 image-links.md 记录的首选方案）。
 * 迁移到应用内后缺了这一环 —— 之前让模型直接从热点素材里挑 URL 当配图，而内置热榜
 * 给的是榜单页/搜索页链接（baidu.com/s?wd=...、toutiao.com/trending/...），
 * 那些不是图片，下载必然全部失败。
 *
 * 现在的分工：模型只负责"提炼检索词"，图片直链一律由这里检索得到，
 * 模型碰不到链接也就不会编造链接。
 *
 * 实测（2026-10 本机）：单个关键词约 600ms、返回 10 条，middleURL 直链可直接下载
 * （HEAD 200 image/jpeg），并带 fromURLHost 便于判断来源媒体。
 */

export type ImageCandidate = {
  /** 图片直链（img*.baidu.com，带 w/h 参数） */
  url: string;
  /** 来源媒体域名，用于跨来源去重与筛选 */
  host: string;
  /** 图片标题/说明 */
  title: string;
  /** 命中的检索词 */
  keyword: string;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** 单个关键词取多少条：宁多勿少，下游下载失败会自动补位。 */
const PER_KEYWORD = 10;
/** 单关键词超时 */
const QUERY_TIMEOUT_MS = 12_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 百度图片搜索的 acjson 端点：返回的不是标准 JSON，用正则取字段更稳。 */
async function queryBaiduImages(keyword: string): Promise<ImageCandidate[]> {
  const url =
    "https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&word=" +
    encodeURIComponent(keyword) +
    `&pn=0&rn=${PER_KEYWORD}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://image.baidu.com/" },
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();

  const urls = [...text.matchAll(/"middleURL":\s*"(https?:[^"]+)"/g)].map((m) => m[1]);
  const hosts = [...text.matchAll(/"fromURLHost":\s*"([^"]*)"/g)].map((m) => m[1]);
  const titles = [...text.matchAll(/"fromPageTitleEnc":\s*"([^"]*)"/g)].map((m) => m[1]);

  return urls.map((imageUrl, index) => ({
    url: imageUrl,
    host: hosts[index] || "",
    title: titles[index] || keyword,
    keyword
  }));
}

/**
 * 按关键词检索候选配图。
 *
 * 多关键词并发但错峰发起（百度对突发请求敏感）；结果按关键词轮询交错，
 * 保证前 N 张不会全来自第一个词，也保证画面覆盖不同侧面。
 */
export async function searchImages(keywords: string[], limit = 12): Promise<ImageCandidate[]> {
  const list = keywords.map((k) => k.trim()).filter(Boolean).slice(0, 6);
  if (!list.length) return [];

  const groups: ImageCandidate[][] = [];
  const failures: string[] = [];

  await Promise.all(
    list.map(async (keyword, index) => {
      await sleep(index * 200);
      try {
        const items = await queryBaiduImages(keyword);
        if (items.length) groups.push(items);
        else failures.push(`${keyword}: 空结果`);
      } catch (error) {
        failures.push(`${keyword}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  );

  if (!groups.length) {
    throw new Error(`图片检索失败（${failures.join("；") || "无响应"}）`);
  }
  if (failures.length) {
    console.warn(`[image-search] 部分关键词未取到图片：${failures.join("；")}`);
  }

  // 同一张图常同时命中多个关键词（先按 url 去重）；但要保留"多个来源媒体"的要求，
  // 所以同 host 最多留 2 张，避免整片都是同一个站点的图。
  const urlSeen = new Set<string>();
  const hostCount = new Map<string, number>();
  const queues = groups.map((group) =>
    group.filter((item) => {
      if (urlSeen.has(item.url)) return false;
      urlSeen.add(item.url);
      const used = hostCount.get(item.host) ?? 0;
      if (used >= 2) return false;
      hostCount.set(item.host, used + 1);
      return true;
    })
  );

  const merged: ImageCandidate[] = [];
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
  console.log(
    `[image-search] 关键词「${list.join(" / ")}」命中 ${merged.length} 张候选（${hostCount.size} 个来源站点）`
  );
  return merged;
}

/**
 * 下载第三方图库/新闻图时带上来源 Referer，降低被防盗链拦掉的概率。
 *
 * 注意 fromURLHost 不一定是域名 —— 百度图片里存在「全网资源」这类中文站名，
 * 直接拼进 Referer 会让 fetch 抛 ByteString 错误（头值必须是 ASCII），
 * 所以这里只认纯 ASCII 域名，否则回落到 image.baidu.com。
 */
export function refererFor(candidate: ImageCandidate): string {
  const host = (candidate.host || "").trim();
  const isDomain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/i.test(host);
  if (!isDomain || /^img\d*\.baidu\.com$/.test(host)) return "https://image.baidu.com/";
  return `https://${host}/`;
}
