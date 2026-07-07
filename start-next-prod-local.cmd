@echo off
cd /d "%~dp0"
set DATABASE_URL=file:./dev.db
set NODE_ENV=production
echo Starting Next.js production server at %DATE% %TIME% > next-start.out.log
"C:\Users\zengr\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" node_modules\next\dist\bin\next start --hostname 0.0.0.0 --port 3000 >> next-start.out.log 2>> next-start.err.log
echo Next.js production server exited with code %ERRORLEVEL% at %DATE% %TIME% >> next-start.out.log