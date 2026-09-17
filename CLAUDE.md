# 识图能力

如果当前模型具备原生识图能力，直接用模型自带能力查看图片即可。

如果底层模型不具备原生识图能力，遇到图片时**不要用 Read 工具**，改用：

```
node vision.js "<图片路径>" "用中文描述这张图片"
```

网络图片：

```
node vision.js --url "<图片URL>" "用中文描述这张图片"
```

## 触发场景

- 用户分享图片路径（本地或网络 URL）
- 消息中出现 "Saved attachments:" 并列出图片
- 用户要求分析、描述、识别图片内容

## 配置

在 `.env.local`（或 `.env`）中配置：

```
DASHSCOPE_API_KEY=你的 API Key
VISION_MODEL=glm-4.6v
DASHSCOPE_BASE_URL=https://open.bigmodel.cn/api/paas/v4
```

- `VISION_MODEL`：当前配置为智谱 `glm-4.6v`；也可换千问 `qwen-vl-max` / `qwen3.5-omni-plus`、OpenAI `gpt-4o-mini` 等任何 OpenAI 兼容格式的 vision 模型
- `DASHSCOPE_BASE_URL`：换服务时改成对应平台的 OpenAI 兼容地址

## 配置好之后

用户直接发图片，自动识图，无需手动打命令。
