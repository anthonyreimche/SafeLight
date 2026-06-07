@echo off
REM ==========================================================================
REM  Safelight - build a SIGNED, optimized Windows .exe (Electron wrapper)
REM  Output: release\Safelight Setup <version>.exe  +  release\win-unpacked\
REM  Icon:   generated from public\favicon.svg
REM  Signing: self-signed cert (build\safelight-cert.pfx), trusted locally.
REM           Run this script as Administrator for machine-wide trust.
REM ==========================================================================
setlocal
cd /d "%~dp0"

echo.
echo [1/5] Installing dependencies...
call npm install
if errorlevel 1 goto :fail

echo.
echo [2/5] Building web app (tsc + vite)...
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
call npx electron-builder --win
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
