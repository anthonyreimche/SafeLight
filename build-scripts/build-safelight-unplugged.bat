@echo off
REM ==========================================================================
REM  Safelight Unplugged (safelight) - build the command-line release from this repo.
REM  Output: dist\            the app bundle, including engine.html (export/preview)
REM          dist-cli\slu.mjs the safelight commands
REM  Run:    scripts\safelight.cmd help
REM  safelight runs from this repo on Node 22+; the engine is this repo's Electron.
REM ==========================================================================
setlocal
cd /d "%~dp0.."

echo.
echo [1/5] Checking dependencies...
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
echo [2/5] Building the app bundle with the safelight engine page (vite)...
REM Clean dist so the engine never loads stale hashed chunks from older builds.
if exist "dist" rmdir /s /q "dist"
call npm run build:app
if errorlevel 1 goto :fail
if not exist "dist\engine.html" (
  echo     dist\engine.html is missing: export and preview would not start.
  goto :fail
)

echo.
echo [3/5] Building the safelight commands (vite, Node target)...
if exist "dist-cli" rmdir /s /q "dist-cli"
call npm run build:cli
if errorlevel 1 goto :fail

echo.
echo [4/5] Checking the safelight bundle...
node --input-type=module --check < "dist-cli\slu.mjs"
if errorlevel 1 goto :fail
call "scripts\safelight.cmd" version
if errorlevel 1 goto :fail

echo.
echo [5/5] Install the safelight command...
echo     Put "safelight" where every terminal can find it, including ones already open? [Y/N]
choice /c YN /n /m "    "
if errorlevel 2 goto :skip_install
node -p "parseInt(process.versions.node)>=22" 2>nul | findstr /x "true" >nul
if errorlevel 1 (
  echo     safelight needs Node 22 or newer on PATH, so the command was not installed.
  goto :skip_install
)
node "build-scripts\install-safelight-command.mjs" "%CD%"
if errorlevel 1 goto :skip_install
REM Earlier versions added this repo's scripts folder to the user PATH. User scope only, exact match; setx would cut PATH off at 1024 characters.
set "SAFELIGHT_SCRIPTS=%CD%\scripts"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = $env:SAFELIGHT_SCRIPTS.TrimEnd('\'); $user = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($user) { $parts = @($user -split ';'); $kept = @($parts | Where-Object { $_.TrimEnd('\') -ine $dir }); if ($kept.Count -ne $parts.Count) { [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User'); Write-Host '    Removed the old scripts folder from your PATH.' } }"
goto :done

:skip_install
echo     Skipped. Run scripts\safelight.cmd instead.

:done
echo.
echo ==========================================================================
echo  DONE. Type safelight in any terminal.
echo    safelight help
echo    safelight doctor
echo  Open the new Safelight build once first, so safelight can read its settings.
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
