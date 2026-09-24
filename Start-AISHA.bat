@echo off
setlocal enabledelayedexpansion
title AISHA - AI Executive startup

echo ============================================================
echo   AISHA - AI EXECUTIVE  (local-first, verified execution)
echo ============================================================
echo.

cd /d "%~dp0"

if not exist ".env" (
  echo [1/8] No .env found - creating one from .env.example
  copy /y ".env.example" ".env" >nul
) else (
  echo [1/8] .env present
)

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js is required but was not found on PATH.
  echo     Install Node 20+ from https://nodejs.org and re-run Start-AISHA.bat
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo [2/8] Node %%v detected

if not exist "node_modules" (
  echo [3/8] Installing dependencies ^(first run, this takes a few minutes^)
  call npm install
  if errorlevel 1 (
    echo [X] npm install failed - the system cannot start.
    pause
    exit /b 1
  )
) else (
  echo [3/8] Dependencies present
)

echo [4/8] Applying versioned database migrations ^(safe + repeatable^)
call npx drizzle-kit push --force
if errorlevel 1 (
  echo [!] Schema push reported a problem. Check that PostgreSQL is running and DATABASE_URL is correct.
)

echo [5/8] Checking Ollama ^(optional: AISHA falls back to the deterministic planner^)
curl -s -m 3 http://127.0.0.1:11434/api/tags >nul 2>nul
if errorlevel 1 (
  echo     [!] Ollama not reachable on 127.0.0.1:11434 - local LLM planning disabled, deterministic planner will be used.
) else (
  echo     Ollama reachable.
)

echo [6/8] Probing the Python sidecar ^(optional: Windows computer use, OCR, STT^)
where python >nul 2>nul
if errorlevel 1 (
  echo     [!] Python not on PATH - Windows computer-use tools will report UNAVAILABLE.
) else (
  python "python\worker\aisha_worker.py" --one-shot <nul >nul 2>nul
  echo     Sidecar probed. Install extras with: pip install -r python\requirements.txt
)

echo [7/8] Building the production bundle
call npm run build
if errorlevel 1 (
  echo [X] Build failed. Fix the reported errors and re-run.
  pause
  exit /b 1
)

echo [8/8] Starting AISHA ^(health endpoint: http://127.0.0.1:%PORT%^)
start "" http://127.0.0.1:3000
call npm run start

endlocal
