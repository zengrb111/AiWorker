#!/usr/bin/env node
/**
 * 独立识图脚本 — 调用千问 VL 模型，按量付费。
 *
 * 用法:
 *   node vision.js <图片路径> [问题]
 *   node vision.js --url <图片链接> [问题]
 *
 * 依赖:
 *   npm install dotenv (可选，如果有 .env 文件)
 *   DASHSCOPE_API_KEY 环境变量 或 同目录 .env 文件
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// 尝试加载 .env / .env.local（无 dotenv 依赖时的简易解析，已设置的环境变量优先）
//
// 规则必须与 dotenv 一致：**同一文件内后出现的键覆盖先出现的**。
// 早先写成 `process.env[key] === undefined` 才赋值（先到先得），结果
// .env.local 里 DASHSCOPE_API_KEY 被定义了两次（第 17 行空值、第 35 行真实值），
// 这里永远拿到第 17 行的空串，而 Next.js 那边拿到真实值 —— 同一个文件两套结果，
// 脚本直接退出报「请设置 DASHSCOPE_API_KEY」。
function loadEnvFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    // 先用一次线性扫描按「后者覆盖前者」折叠，再统一赋值，
    // 这样跨文件优先级（后面的文件不覆盖前面的）与文件内覆盖能分开控制。
    const folded = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      folded[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    // 已存在于真实环境变量的优先（命令行/CI 注入应胜过文件）
    for (const key of Object.keys(folded)) {
      if (process.env[key] === undefined) process.env[key] = folded[key];
    }
  } catch {}
}
loadEnvFile(path.resolve(process.cwd(), ".env.local"));
loadEnvFile(path.resolve(process.cwd(), ".env"));
loadEnvFile(path.resolve(__dirname, ".env"));

const BASE_URL = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";

/**
 * 取可用的 API key。
 *
 * 历史坑：.env.local 里 DASHSCOPE_API_KEY 被定义了两次（第 17 行空串、第 35 行
 * 阿里云格式 key），而 DASHSCOPE_BASE_URL 指向智谱、VISION_MODEL 是 glm-4.6v。
 * 三者不匹配时请求必然 401。这里按「端点决定 key」回退：
 *   - 端点是智谱（open.bigmodel.cn）→ 优先用 ZHIPU_API_KEY
 *   - 否则用 DASHSCOPE_API_KEY
 * 这样无论用户怎么配都能跑起来，且不会静默用错 key。
 */
function resolveApiKey() {
  const isZhipuEndpoint = /bigmodel\.cn/i.test(BASE_URL);
  const dashscope = process.env.DASHSCOPE_API_KEY || "";
  const zhipu = process.env.ZHIPU_API_KEY || "";
  if (isZhipuEndpoint) {
    if (zhipu) return zhipu;
    // 端点是智谱但只给了 DASHSCOPE key：仍返回它，让服务端给出明确错误，
    // 好过本地猜一个「看起来对」的值
    return dashscope;
  }
  return dashscope || zhipu;
}

const API_KEY = resolveApiKey();
const MODEL = process.env.VISION_MODEL || "xxx";

function parseArgs() {
  const argv = process.argv.slice(2);
  let imageSource = "", prompt = "", isUrl = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) {
      isUrl = true;
      imageSource = argv[++i];
    } else if (!imageSource && !argv[i].startsWith("--")) {
      imageSource = argv[i];
    } else if (imageSource && !argv[i].startsWith("--")) {
      prompt = prompt ? prompt + " " + argv[i] : argv[i];
    }
  }
  if (!prompt) prompt = "请详细描述这张图片的内容。";
  return { imageSource, prompt, isUrl };
}

function resolveImageUrl(source, isUrl) {
  if (isUrl) return source;
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
  const ext = path.extname(resolved).toLowerCase().replace(".", "");
  const mimeMap = { jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", bmp: "bmp" };
  const data = fs.readFileSync(resolved);
  return `data:image/${mimeMap[ext] || "jpeg"};base64,${data.toString("base64")}`;
}

function request(payload) {
  const url = new URL(BASE_URL.replace(/\/?$/, "/") + "chat/completions");
  const body = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`API ${res.statusCode}: ${data.slice(0, 300)}`));
        try {
          resolve(JSON.parse(data)?.choices?.[0]?.message?.content || data);
        } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!API_KEY || API_KEY === "sk-xxx") {
    console.error("未找到可用的 API key。");
    console.error(`当前端点：${BASE_URL}`);
    if (/bigmodel\.cn/i.test(BASE_URL)) {
      console.error("端点是智谱，请在 .env.local 配置 ZHIPU_API_KEY。");
    } else {
      console.error("端点是阿里云百炼，请在 .env.local 配置 DASHSCOPE_API_KEY。");
    }
    console.error("注意：key 必须与 DASHSCOPE_BASE_URL 属于同一家，否则必然 401。");
    process.exit(1);
  }
  if (!MODEL || MODEL === "xxx") {
    console.error("请设置 VISION_MODEL 环境变量（智谱端点用 glm-4.6v，阿里云端点用 qwen-vl-max）。");
    process.exit(1);
  }
  const { imageSource, prompt, isUrl } = parseArgs();
  if (!imageSource) {
    console.error("用法: node vision.js <图片路径> [问题]");
    console.error("      node vision.js --url <图片链接> [问题]");
    process.exit(1);
  }
  try {
    const imageUrl = resolveImageUrl(imageSource, isUrl);
    const result = await request({
      model: MODEL,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: imageUrl } },
        { type: "text", text: prompt },
      ]}],
      stream: false,
      max_tokens: 1024,
    });
    console.log(result);
  } catch (err) {
    console.error("识图失败:", err.message);
    process.exit(1);
  }
}

main();
