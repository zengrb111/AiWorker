/** 一次性验证：免费封面链路（pollinations 背景 + 程序绘制中文标题）。 */
import { generateCoverImageWithFallback } from "../src/lib/image-gen.ts";

const cases = [
  {
    title: "银发经济崛起：AI 回忆录如何帮父母留住一生故事",
    body: "## 一、现象\n越来越多的子女开始用 AI 帮父母整理老照片和口述历史。\n## 二、方法\n三步就能完成一本家庭回忆录。",
    platform: "xhs"
  },
  {
    title: "开源大模型周报：本周值得关注的 5 个项目",
    body: "本周开源社区动态汇总，涵盖推理加速、多模态与端侧部署。",
    platform: "wechat"
  }
];

for (const c of cases) {
  const t0 = Date.now();
  const url = await generateCoverImageWithFallback(c.title, c.body, c.platform);
  console.log(`[${c.platform}] ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${url}`);
}
