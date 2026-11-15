@echo off
REM ==========================================================================
REM  Safelight Unplugged (slu) - build the command-line release from this repo.
REM  Output: dist\            the app bundle, including engine.html (export/preview)
REM          dist-cli\slu.mjs the slu commands
REM  Run:    scripts\slu.cmd help
REM  slu runs on this repo's Electron, so nothing is packaged or installed yet.
REM ==========================================================================
setlocal
cd /d "%~dp0.."

echo.
echo [1/4] Checking dependencies...
REM Skip the slow "npm install" when the lockfile hasn't changed since the
REM last install (npm stamps node_modules\.package-lock.json on success).
set "NEED_INSTALL=1"
if exist "node_modules\.package-lock.json" (
  node -e "const fs=require('fs');process.exit(fs.statSync('node_modules/.package-lock.json').mtimeMs>=fs.statSync('package-lock.json').mtimeMs?0:1)" && set "NEED_INSTALL=0"
)
if "%NEED_INSTALL%"=="1" (
  call npm install --no-audit --no-fund --prefer-offline --progress=false
  if errorlevel 1 goto :fail
) else (
  echo     node_modules up to date - skipping npm install.
)

echo.
echo [2/4] Building the app bundle with the slu engine page (vite)...
REM Clean dist so the engine never loads stale hashed chunks from older builds.
if exist "dist" rmdir /s /q "dist"
call npm run build:app
if errorlevel 1 goto :fail
if not exist "dist\engine.html" (
  echo     dist\engine.html is missing: export and preview would not start.
  goto :fail
)

echo.
echo [3/4] Building the slu commands (vite, Node target)...
if exist "dist-cli" rmdir /s /q "dist-cli"
call npm run build:cli
if errorlevel 1 goto :fail

echo.
echo [4/4] Checking the slu bundle...
node --input-type=module --check < "dist-cli\slu.mjs"
if errorlevel 1 goto :fail
call "scripts\slu.cmd" version
if errorlevel 1 goto :fail

echo.
echo ==========================================================================
echo  DONE. Run slu from this repo:
echo    scripts\slu.cmd help
echo    scripts\slu.cmd doctor
echo  Open the new Safelight build once first, so slu can read its settings.
echo  Guide: docs\user\unplugged.md
echo ==========================================================================
echo.
pause
exit /b 0

:fail
echo.
echo ##########################################################################
echo  BUILD FAILED. See the error output above.
echo ##########################################################################
echo.
pause
exit /b 1
