# DSH Web 后台

**用途**：人工排查 DeepSeek Harness 的行为 —— 看会话原始输出、手动试 prompt、看插件清单。
**不是出片链路的一部分**。视频生成走的是 `.dsh-venv` 里的 Python SDK（`scripts/dsh-storyboard/main.py`），两者互不影响。

## 为什么单独一个 node 工程

出片链路对插件集合有硬要求（受限 profile 逐个 disabled 掉 `tool-bash` / `tool-fs` / `tool-web` / `subagent`）。
把 DSH 的 86 个依赖塞进主工程的 `node_modules`，一旦它的传递依赖和 Next.js / React 撞版本，排查方向会被彻底带偏。
所以这里独立 `package.json`，用 `npm --prefix` 调用，物理隔离。

## 用法

```powershell
# 首次
npm --prefix tools/dsh-web install

# 启动（会自动开浏览器；token 打印在日志里）
npm --prefix tools/dsh-web run web

# 不自动开浏览器
npm --prefix tools/dsh-web run web:no-open
```

地址形如 `http://127.0.0.1:18790/?token=<随机串>`，**必须带 token**，每次重启都会变。

## 版本

钉在 `@deepseek-ai/dsh@0.2.1-rc.2`。

注意 npm 的 `latest` 标签还停在 `0.2.0-rc.2`，所以要用 `npm install @deepseek-ai/dsh@0.2.1-rc.2` 显式指定，
不要写 `@latest`。

## 与 0.1.5rc1 内置 exe 的对比

`.dsh-venv\Scripts\dsh.exe web`（SDK 内置的 Node runtime）在这个项目上有两处上游缺陷，
`scripts/dsh-web/cordis.patch.yml` 里有完整排查记录：

1. 缺 `@deepseek-ai/dsh-session-title{,-llm}` 包 → 启动直接失败
2. host 代码与自带前端包版本错配（请求 `/client.js`，而 exports 里是 `/client`）→ 页面报
   `Failed to load plugins`

0.2.1-rc.2 这两处都已修复，实测浏览器控制台 0 错误、界面完整渲染。**优先用这个 npm 版本。**