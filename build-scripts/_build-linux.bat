@echo off
REM ==========================================================================
REM  Safelight - shared Linux package builder. Do not run directly; use the
REM  build-linux-*.bat wrappers. Runs electron-builder inside WSL2 because
REM  Linux targets (deb/rpm/pacman/AppImage/flatpak) cannot be built natively
REM  on Windows. Heavy lifting lives in linux-build.sh.
REM  Usage:  _build-linux.bat <deb|rpm|pacman|AppImage|flatpak>
REM  Output: release\linux\
REM ==========================================================================
setlocal
if "%~1"=="" (
  echo Usage: %~nx0 ^<deb^|rpm^|pacman^|AppImage^|flatpak^>
  exit /b 1
)
cd /d "%~dp0.."

wsl -e true >nul 2>&1
if errorlevel 1 (
  echo ERROR: WSL2 is not available. Install it with:  wsl --install
  pause
  exit /b 1
)

echo Building Linux target "%~1" in WSL2...
if not exist "release" mkdir "release"
REM sed strips Windows CRLF line endings so bash accepts the script as-is.
REM Output is mirrored to release\linux-build-<target>.log for post-mortems.
wsl --cd "%CD%" -e bash -lc "set -o pipefail; sed 's/\r$//' build-scripts/linux-build.sh | bash -s -- %~1 2>&1 | tee 'release/linux-build-%~1.log'"
if errorlevel 1 goto :fail

echo.
echo ==========================================================================
echo  DONE. Package copied to release\linux\
echo ==========================================================================
explorer "%CD%\release\linux"
pause
exit /b 0

:fail
echo.
echo ##########################################################################
echo  BUILD FAILED. See the error output above.
echo ##########################################################################
pause
exit /b 1
