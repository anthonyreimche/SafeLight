@echo off
rem Development launcher for slu: runs dist-cli\slu.mjs (npm run build:cli) with
rem this repo's Electron as plain Node.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0..\dist-cli\slu.mjs" %*
exit /b %ERRORLEVEL%
