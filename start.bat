@echo off
REM ============================================================
REM  SafeLight - start the dev (debug) server
REM  Double-click this file, or run it from a terminal.
REM ============================================================
title SafeLight dev server

REM Run from this script's own folder, wherever it's launched from.
cd /d "%~dp0"

REM Install dependencies on first run (or if node_modules is missing).
if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Is Node.js installed and on your PATH?
    pause
    exit /b 1
  )
)

echo.
echo Starting SafeLight dev server...  ^(press Ctrl+C to stop^)
echo Local: http://localhost:5173/
echo.

REM Vite picks the next free port automatically if 5173 is taken.
call npm run dev

echo.
echo Dev server stopped.
pause
