@echo off
REM ==========================================================================
REM  Safelight - build a SIGNED, optimized Windows .exe (Electron wrapper)
REM  Output: release\Safelight Setup <version>.exe  +  release\win-unpacked\
REM  Icon:   generated from public\favicon.svg (skipped when up to date)
REM  Signing: self-signed cert (build\safelight-cert.pfx), trusted locally.
REM           Run this script as Administrator for machine-wide trust.
REM ==========================================================================
setlocal
cd /d "%~dp0"

echo.
echo [1/5] Checking dependencies...
REM Skip the slow "npm install" when the lockfile hasn't changed since the
REM last install (npm stamps node_modules\.package-lock.json on success).
set "NEED_INSTALL=1"
if exist "node_modules\.package-lock.json" (
  node -e "const fs=require('fs');process.exit(fs.statSync('node_modules/.package-lock.json').mtimeMs>=fs.statSync('package-lock.json').mtimeMs?0:1)" && set "NEED_INSTALL=0"
)
if "%NEED_INSTALL%"=="1" (
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
) else (
  echo     node_modules up to date - skipping npm install.
)

echo.
echo [2/5] Building web app (tsc + vite)...
REM Clean dist so no stale hashed chunks from older builds ship in the asar.
if exist "dist" rmdir /s /q "dist"
call npm run build
if errorlevel 1 goto :fail

echo.
echo [3/5] Generating Windows icon from favicon.svg...
call npm run icon
if errorlevel 1 goto :fail

echo.
echo [4/5] Creating / loading code-signing certificate...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-cert.ps1"
if errorlevel 1 goto :fail
set "CSC_LINK=%~dp0build\safelight-cert.pfx"
set "CSC_KEY_PASSWORD=safelight"

echo.
echo [5/5] Packaging signed Windows installer (electron-builder)...
call npx electron-builder --win --publish never
if errorlevel 1 goto :fail

echo.
echo ==========================================================================
echo  DONE. Signed installer + unpacked app are in the "release" folder.
echo ==========================================================================
echo.
explorer "%~dp0release"
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
