@echo off
REM ==========================================================================
REM  Safelight Unplugged (safelight) - build the command-line release from this repo.
REM  Output: dist\            the app bundle, including engine.html (export/preview)
REM          dist-cli\slu.mjs the safelight commands
REM  Run:    scripts\safelight.cmd help
REM  safelight runs on this repo's Electron, so nothing is packaged or installed yet.
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
echo [5/5] Setting up the safelight command...
set "SAFELIGHT_SCRIPTS=%CD%\scripts"
echo     Add "%SAFELIGHT_SCRIPTS%" to your PATH so "safelight" works in any new terminal? [Y/N]
choice /c YN /n /m "    "
if errorlevel 2 goto :skip_path
REM User PATH only, through the .NET calls: setx cuts PATH off at 1024 characters.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = $env:SAFELIGHT_SCRIPTS.TrimEnd('\'); $user = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $user) { $user = '' }; $known = @($user -split ';' | Where-Object { $_.TrimEnd('\') -ieq $dir }); if ($known.Count -gt 0) { Write-Host '    Already on your PATH.' } else { $joined = (($user.TrimEnd(';') + ';' + $dir)).TrimStart(';'); [Environment]::SetEnvironmentVariable('Path', $joined, 'User'); Write-Host '    Added to your PATH.' }"
if errorlevel 1 (
  echo     Could not change your PATH. Run scripts\safelight.cmd instead.
  goto :done
)
echo     Open a new terminal and type: safelight
goto :done

:skip_path
echo     Skipped. Run scripts\safelight.cmd instead.

:done
echo.
echo ==========================================================================
echo  DONE. Try these in a new terminal:
echo    safelight help
echo    safelight doctor
echo  Until you open a new terminal, run scripts\safelight.cmd from this repo,
echo  or .\safelight.cmd from the scripts folder in PowerShell.
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
