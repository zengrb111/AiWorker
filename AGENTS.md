# 识图能力

- 当前 Codex 模型具备原生识图能力：用户发图或提供图片路径时，直接查看图片即可，无需额外工具。
- 若接入的底层模型不具备原生识图能力（如 DeepSeek），遇到图片时不要用 Read 工具，改用：

```
node vision.js "<图片路径>" "用中文描述这张图片"
```

- 网络图片：`node vision.js --url "<图片URL>" "用中文描述这张图片"`
- 密钥与模型配置在 `.env.local` 或 `.env`：`DASHSCOPE_API_KEY` / `VISION_MODEL` / `DASHSCOPE_BASE_URL`（详见 `CLAUDE.md`）
