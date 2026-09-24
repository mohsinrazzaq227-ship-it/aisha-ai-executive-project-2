@echo off
setlocal enabledelayedexpansion
title AI-EXECUTIVE Launcher
cd /d "%~dp0"
echo ============================================================
echo   AI-EXECUTIVE - local-first agent operating system
echo   Free / offline-first. Nothing is installed without asking.
echo ============================================================
echo.

where node >nul 2>nul || (echo [FAIL] Node.js 20+ is required. Install from https://nodejs.org and rerun. & pause & exit /b 1)
for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo [PASS] Node detected: !NODEVER!

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo [INFO] Created .env from .env.example. Edit it for models, mail and speech.
)

echo.
echo [1/4] Installing Node dependencies if needed (skips when node_modules exists)...
if not exist "node_modules" (
  choice /c YN /m "node_modules is missing. Run npm install now"
  if errorlevel 2 (echo [SKIP] Install cancelled. Cannot start without dependencies. & pause & exit /b 1)
  call npm install || (echo [FAIL] npm install failed. & pause & exit /b 1)
) else (
  echo [PASS] dependencies present
)

echo.
echo [2/4] Applying database schema (Drizzle push)...
call npx drizzle-kit push || echo [WARN] schema push failed - check DATABASE_URL and that PostgreSQL is running.

echo.
echo [3/4] Environment diagnostics (Doctor) summary...
node -e "console.log('Node', process.version, '| platform', process.platform, process.arch)" 2>nul
where ffmpeg >nul 2>nul && echo [PASS] system ffmpeg found || echo [INFO] no system ffmpeg - bundled ffmpeg-static will be used

echo.
echo [4/4] Starting AI-EXECUTIVE on http://127.0.0.1:3000 ...
echo       Open the interface, press Run diagnostics in the System tab, then talk to AISHA.
start "" http://127.0.0.1:3000
call npm run start
pause
