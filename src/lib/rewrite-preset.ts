/**
 * 「一键仿写爆款」内置拆解样本。
 *
 * 为什么内置：小红书笔记页是 CSR + 登录/风控，服务端直连拿不到正文，
 * 浏览器通道也依赖本机已登录的 Cookie（换机器就失效）。把一条已验证可用的
 * 爆款原文内置成默认样本，可以做到「不粘链接也能一键仿写」，
 * 既保证首屏可用性，也避免用户第一次点开就撞上「未能读取原文」。
 *
 * 用户仍可粘贴自己的链接覆盖：只要 URL 与内置样本对不上，就走原来的抓取通道。
 */
export type RewritePresetNote = {
  title: string;
  desc: string;
  topics: string[];
  author: string;
  ipLocation: string;
  type: string;
  coverImages: string[];
};

export type RewritePreset = {
  /** 稳定标识，用于匹配用户粘贴的链接 */
  id: string;
  /** 展示用短名 */
  label: string;
  /** 原始分享短链（用户实际粘贴的形态） */
  shortUrl: string;
  /** 预填到输入框的文本（标题 + 链接，前端会抽取第一条 URL） */
  shareText: string;
  note: RewritePresetNote;
};

const NOTE_ID = "69ce8621000000001b0229be";
const SHORT_URL = "https://xhslink.cn/o/6HjoRDj5EAt";

export const DEFAULT_REWRITE_PRESET: RewritePreset = {
  id: NOTE_ID,
  label: "有员工被炼化成数字人了",
  shortUrl: SHORT_URL,
  shareText: `有员工被炼化成数字人了 公司用AI将离职员工的聊天记录和文档转化为"数字分身"\n${SHORT_URL}`,
  note: {
    title: "有员工被炼化成数字人了",
    desc: [
      "公司用AI将离职员工的聊天记录和文档转化为“数字分身”。",
      "",
      "这种方式不仅保留了知识，还可能通过AI助手不断训练模型，最终让员工的经验和判断都被“蒸馏”成不可替代的AI。这让人质疑职场的不可替代性，甚至可能失去最后的“不可复制”价值。",
      "",
      "#互联网大厂[话题]# #商业[话题]# #ai[话题]# #数字人[话题]# #大模型[话题]# #aigc[话题]#",
    ].join("\n"),
    topics: ["互联网大厂", "商业", "ai", "数字人", "大模型", "aigc"],
    author: "Saber的思考笔记",
    ipLocation: "",
    type: "图文笔记",
    coverImages: [
      "http://sns-webpic-qc.xhscdn.com/202610301545/89f202383d55e345e4b4fbfe32cc70c8/1040g2sg31ufbspli2is05o69np208trn0vvgu8o!nd_prv_wlteh_webp_3",
      "http://sns-webpic-qc.xhscdn.com/202610301545/332132642057972429d3621fd5e7cd63/1040g2sg31ufbspli2isg5o69np208trnfjfv1qo!nd_prv_wlteh_webp_3",
      "http://sns-webpic-qc.xhscdn.com/202610301545/792e8c768cfe8e3fde19d4c987fd121e/1040g2sg31ufbspli2it05o69np208trnu18s8g8!nd_prv_wlteh_webp_3",
      "http://sns-webpic-qc.xhscdn.com/202610301545/870e87e82555e3e0aa083b1e4d019397/1040g2sg31ufbspli2itg5o69np208trn6jasae0!nd_prv_wlteh_webp_3",
    ],
  },
};

/**
 * 判断用户粘贴的链接是否就是内置样本。
 * 同时兼容：原始短链、笔记详情页（含/不含 xsec_token）、以及裸 noteId。
 */
export function matchRewritePreset(url: string): RewritePreset | null {
  const text = (url || "").trim();
  if (!text) return null;
  if (text.includes(SHORT_URL)) return DEFAULT_REWRITE_PRESET;
  if (text.includes(NOTE_ID)) return DEFAULT_REWRITE_PRESET;
  return null;
}
