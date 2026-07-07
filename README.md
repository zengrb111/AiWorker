# 创星云 AI 数字员工平台

创星云是一个基于 Web BS 架构的 AI 数字员工平台。当前实现使用 Next.js 全栈应用、PostgreSQL、Prisma，并通过 HTTP 直连本地部署好的 OpenClaw 服务执行任务。

## 功能

- 手机号、密码登录。
- 注册前先扫码绑定 OpenClaw 微信通道，绑定完成后再注册并登录。
- 对话页保存历史会话和消息，并通过 OpenClaw 执行任务。
- 内容库保存 OpenClaw 产出的图文内容，支持详情、复制标题、复制正文。
- 个人中心支持修改密码、微信通道绑定、解绑、重新绑定。

## 环境变量

复制 `.env.example` 为 `.env`，并配置：

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/chuangxingyun"
OPENCLAW_BASE_URL="http://localhost:3001"
OPENCLAW_API_TOKEN="replace-with-openclaw-token"
AUTH_SESSION_SECRET="replace-with-a-long-random-secret"
```

## OpenClaw HTTP 接口约定

平台后端直接调用本地 OpenClaw HTTP 服务，不使用 mock。默认适配以下接口：

- `POST /wechat/bindings/qr`
- `GET /wechat/bindings/:ticketId/status`
- `DELETE /wechat/bindings/:wechatOpenId`
- `POST /agent/tasks`

如果本地 OpenClaw 的字段不同，只需要调整 `src/lib/openclaw.ts`。

## 开发

```bash
npm install
npx prisma migrate dev
npm run dev
```

## 验证

```bash
npm run check
npm run lint
npm run build
```
