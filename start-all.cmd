@echo off
REM ============================================================
REM  Chuangxingyun AI Worker - one-click launcher
REM  Starts OpenClaw gateway (port 18789) + Next.js dev (3000)
REM ============================================================
REM
REM  IMPORTANT: keep this file ASCII-only.
REM  cmd.exe parses .cmd/.bat using the system ANSI codepage (936 on
REM  Chinese Windows). A UTF-8 file with Chinese text turns into garbage,
REM  and the garbage gets executed as commands. Never add non-ASCII here.
REM
REM  2026-10 fixes:
REM   1. Old hardcoded paths pointed at a retired machine
REM      (D:\OPCProjects\AiWorker, D:\OpenClaw). Now auto-detected.
REM   2. Port is probed before/after start, and failures are reported
REM      loudly instead of silently doing nothing.
REM   3. NODE_OPTIONS is cleared: the CodeBuddy safe-delete shim injects
REM      itself there and crashes the gateway on bulk deletes.

setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"
set "GATEWAY_PORT=18789"
set "NODE_DIR=C:\Users\Charles\tools\node-v24.21.0-win-x64"

REM ---------- validate project dir ----------
if not exist "%PROJECT_DIR%\package.json" (
    echo [ERROR] Invalid project dir: %PROJECT_DIR%
    echo         package.json not found. Run this script from the project root.
    pause
    exit /b 1
)

REM ---------- locate node ----------
set "NODE_EXE="
if exist "%NODE_DIR%\node.exe" (
    set "NODE_EXE=%NODE_DIR%\node.exe"
) else (
    for /f "delims=" %%i in ('where node 2^>nul') do (
        if not defined NODE_EXE set "NODE_EXE=%%i"
    )
)
if not defined NODE_EXE (
    echo [ERROR] node.exe not found.
    echo         Fix NODE_DIR in this script, or make sure node is on PATH.
    pause
    exit /b 1
)
echo [1/4] Node: %NODE_EXE%

REM ---------- clear the safe-delete shim ----------
set "NODE_OPTIONS="

REM ---------- locate openclaw CLI ----------
set "OPENCLAW_CMD="
for /f "delims=" %%i in ('where openclaw 2^>nul') do (
    if not defined OPENCLAW_CMD set "OPENCLAW_CMD=%%i"
)
if not defined OPENCLAW_CMD (
    for %%p in ("%USERPROFILE%\AppData\Roaming\npm\openclaw.cmd" "D:\OpenClaw\openclaw.cmd" "%PROJECT_DIR%\OpenClaw\openclaw.cmd") do (
        if exist %%p if not defined OPENCLAW_CMD set "OPENCLAW_CMD=%%~p"
    )
)

REM ---------- is the gateway port already taken? ----------
call :port_busy %GATEWAY_PORT%
if "%PORT_BUSY%"=="1" (
    echo [2/4] Port %GATEWAY_PORT% already listening - skipping gateway start.
    echo         If the gateway misbehaves, free the port first:
    echo           netstat -ano ^| findstr %GATEWAY_PORT%
    goto :start_next
)

if not defined OPENCLAW_CMD (
    echo [2/4] [SKIP] openclaw CLI not found - gateway will NOT start.
    echo         Video generation does not need the gateway; only hot-topic
    echo         search and AI chat do. To start it manually:
    echo           openclaw gateway run --port %GATEWAY_PORT% --allow-unconfigured
    goto :start_next
)

echo [2/4] Starting OpenClaw gateway on port %GATEWAY_PORT%...
echo       CLI: %OPENCLAW_CMD%
start "OpenClaw Gateway" /min cmd /c ""%OPENCLAW_CMD%" gateway run --port %GATEWAY_PORT% --allow-unconfigured >> "%PROJECT_DIR%\openclaw-gateway.out.log" 2>&1"

REM wait up to 30s for the port to come up
set /a WAITED=0
:wait_loop
call :port_busy %GATEWAY_PORT%
if "%PORT_BUSY%"=="1" goto :wait_ok
set /a WAITED+=1
if !WAITED! geq 15 goto :wait_fail
timeout /t 2 /nobreak >nul
goto :wait_loop

:wait_ok
echo [2/4] Gateway is up (waited about !WAITED!x2s).
goto :start_next

:wait_fail
echo [2/4] [WARN] Gateway still not listening after 30s.
echo         It probably crashed on startup or is restart-looping.
echo         Log: %PROJECT_DIR%\openclaw-gateway.out.log
echo         Full diagnosis: node scripts\diagnose-openclaw.mjs

:start_next
REM ---------- start Next.js ----------
if not exist "%PROJECT_DIR%\node_modules\next\dist\bin\next" (
    echo [3/4] [ERROR] node_modules\next\dist\bin\next not found.
    echo         Run "npm install" in %PROJECT_DIR% first.
    pause
    exit /b 1
)
echo [3/4] Starting Next.js dev server on port 3000...
start "Next.js Dev Server" /min cmd /c "cd /d "%PROJECT_DIR%" && set NODE_OPTIONS= && set DATABASE_URL=file:./dev.db && set NODE_ENV=development && "%NODE_EXE%" node_modules\next\dist\bin\next dev >> "%PROJECT_DIR%\next-dev.out.log" 2>> "%PROJECT_DIR%\next-dev.err.log""

REM ---------- summary ----------
echo.
echo [4/4] Done.
echo   - Next.js  : http://localhost:3000
echo   - Gateway  : http://localhost:18789
echo   - Gw log   : %PROJECT_DIR%\openclaw-gateway.out.log
echo   - Web log  : %PROJECT_DIR%\next-dev.out.log
echo.
echo Note: if the gateway did not start, video generation still works
echo (it now runs on DSH + the bundled Remotion project).
pause
exit /b 0

REM ================= subroutines =================

:port_busy
REM Sets PORT_BUSY=1 when something listens on %1.
set "PORT_BUSY=0"
for /f "tokens=5" %%p in ('netstat -ano -p TCP ^| findstr /r /c:":%1 .*LISTENING" 2^>nul') do (
    set "PORT_BUSY=1"
    goto :eof
)
goto :eof