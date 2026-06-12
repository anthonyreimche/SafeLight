@echo off
REM ==========================================================================
REM  Safelight - macOS .dmg installer
REM  macOS packages CANNOT be built on Windows or WSL: electron-builder
REM  requires macOS-only tools (hdiutil, codesign). Unlike Linux targets,
REM  there is no WSL equivalent for macOS.
REM
REM  To build it: copy this repo to a Mac (or clone it there) and run
REM      bash build-scripts/build-macos-dmg.sh
REM  Output lands in release/ as Safelight-<version>.dmg (x64 + arm64).
REM  Without an Apple Developer certificate the .dmg is unsigned - users
REM  right-click the app and choose "Open" on first launch.
REM ==========================================================================
echo macOS installers can only be built on a Mac.
echo.
echo On a Mac, run:  bash build-scripts/build-macos-dmg.sh
echo Output: release/Safelight-^<version^>.dmg  (x64 + Apple Silicon)
echo.
pause
