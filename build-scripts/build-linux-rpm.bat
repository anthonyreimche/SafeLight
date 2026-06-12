@echo off
REM Safelight - RPM package (Fedora, openSUSE, RHEL).
REM Install with: sudo dnf install ./safelight-<version>.x86_64.rpm
call "%~dp0_build-linux.bat" rpm
