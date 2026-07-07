@echo off
cd /d "%~dp0"
set DATABASE_URL=file:./dev.db
set NODE_ENV=development
echo Starting Next.js at %DATE% %TIME% > next-dev.out.log
"C:\Users\zengr\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" node_modules\next\dist\bin\next dev --hostname 0.0.0.0 --port 3000 >> next-dev.out.log 2>> next-dev.err.log
echo Next.js exited with code %ERRORLEVEL% at %DATE% %TIME% >> next-dev.out.log