@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

:menu
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "CUR=%%v"
echo.
echo  SafeLight version: !CUR!
echo  ------------------------------------
echo   [1] Patch   (x.x.+1)
echo   [2] Minor   (x.+1.0)
echo   [3] Major   (+1.0.0)
echo   [4] Set exact version
echo   [5] Show only / Quit
echo.
set "CHOICE="
set /p "CHOICE=Choose: "

if "!CHOICE!"=="1" set "BUMP=patch" & goto apply
if "!CHOICE!"=="2" set "BUMP=minor" & goto apply
if "!CHOICE!"=="3" set "BUMP=major" & goto apply
if "!CHOICE!"=="4" goto custom
if "!CHOICE!"=="5" goto end
echo Invalid choice.
goto menu

:custom
set "BUMP="
set /p "BUMP=New version (e.g. 1.2.0): "
if "!BUMP!"=="" goto menu

:apply
rem --no-git-tag-version updates package.json + package-lock.json without committing/tagging.
call npm version !BUMP! --no-git-tag-version --allow-same-version
if errorlevel 1 (
  echo.
  echo Failed to set version "!BUMP!".
) else (
  for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "NEW=%%v"
  echo.
  echo Updated: !CUR! -^> !NEW!
)
goto menu

:end
echo.
echo Current version: !CUR!
endlocal
