@echo off
REM ============================================================
REM  Chuangxingyun AI Worker - one-click launcher (ASCII only!)
REM
REM  Why ASCII: cmd.exe parses .cmd with the system ANSI codepage
REM  (936 on Chinese Windows). Non-ASCII here becomes garbage and
REM  gets executed as commands. All real logic + Chinese output
REM  live in start-all.ps1 (UTF-8 with BOM, safe for PowerShell).
REM
REM  What it does (in order):
REM    1) OpenClaw gateway on 18789  (WeChat needs it)
REM    2) Next.js dev server on 3000
REM    3) WeChat channel self-heal (reconnect + rebuild routing)
REM
REM  Usage:
REM    start-all.cmd              start everything (idempotent)
REM    start-all.cmd -Status      status only
REM    start-all.cmd -Restart     stop then start
REM    start-all.cmd -NoSelfHeal  skip the WeChat self-heal step
REM
REM  Note: the gateway's login autostart stays DISABLED on purpose.
REM  Run this script after every reboot / re-login.
REM  Old launcher kept as start-all.cmd.bak-20261023
REM ============================================================
setlocal
set "PS1=%~dp0start-all.ps1"
if not exist "%PS1%" (
    echo [ERROR] start-all.ps1 not found next to this file.
    echo         Expected: %PS1%
    pause
    exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
