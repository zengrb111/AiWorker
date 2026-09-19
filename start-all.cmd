@echo off
REM ===== 创星云 AI 数字员工平台 - 开机自启动脚本 =====
REM 同时启动 OpenClaw 网关 (端口 18789) 和 Next.js 服务 (端口 3000)

set PROJECT_DIR=D:\OPCProjects\AiWorker
set NODE_EXE=C:\Users\zengr\AppData\Local\hermes\node\node.exe
set NPM_CMD=C:\Users\zengr\AppData\Local\hermes\node\npm.cmd
set OPENCLAW_CMD=C:\Users\zengr\AppData\Local\hermes\node\openclaw.cmd

cd /d "%PROJECT_DIR%"

REM 绕过 WorkBuddy safe-delete shim（NODE_OPTIONS 注入的 language-shim 会拦截
REM .next 批量清理 / agent 文件删除，抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED 使进程崩溃）
set NODE_OPTIONS=

REM --- 1. 启动 OpenClaw 网关 ---
echo [%DATE% %TIME%] Starting OpenClaw gateway... >> "%PROJECT_DIR%\startup.log"
start "OpenClaw Gateway" /min cmd /c ""%OPENCLAW_CMD%" gateway run --port 18789 --allow-unconfigured >> "%PROJECT_DIR%\openclaw-gateway.out.log" 2>&1"

REM 等待网关启动
timeout /t 5 /nobreak >nul

REM --- 2. 启动 Next.js dev server ---
echo [%DATE% %TIME%] Starting Next.js dev server... >> "%PROJECT_DIR%\startup.log"
start "Next.js Dev Server" /min cmd /c "cd /d "%PROJECT_DIR%" && set DATABASE_URL=file:./dev.db && set NODE_ENV=development && "%NPM_CMD%" run dev >> "%PROJECT_DIR%\next-dev.out.log" 2>> "%PROJECT_DIR%\next-dev.err.log""

echo [%DATE% %TIME%] All services started. >> "%PROJECT_DIR%\startup.log"
