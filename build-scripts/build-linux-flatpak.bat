@echo off
REM Safelight - Flatpak bundle (any distro with flatpak).
REM Requires flatpak + flatpak-builder inside WSL (script prints setup steps).
REM Install with: flatpak install ./safelight_<version>_amd64.flatpak
call "%~dp0_build-linux.bat" flatpak
