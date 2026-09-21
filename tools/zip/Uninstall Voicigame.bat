@echo off
rem Removes the Voicigame line from override.cfg next to the game's exe. Everything else in the file stays.
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

if not exist override.cfg goto notinstalled
findstr /i /b /c:"Voicigame=" override.cfg >nul || goto notinstalled
copy /y nul "voicigame_write_test.tmp" >nul 2>&1 || goto noaccess
del "voicigame_write_test.tmp" >nul 2>&1
findstr /v /i /b /c:"Voicigame=" override.cfg > override.cfg.tmp
move /y override.cfg.tmp override.cfg >nul || goto noaccess
rem Only section headers and empty lines left: leave an empty file (the game ignores it)
findstr /r /v /c:"^\[.*\]$" /c:"^ *$" override.cfg >nul || type nul > override.cfg

echo.
echo Voicigame is removed. The game starts without it from now on.
echo You can delete the "voicigame" folder and these two .bat files.
echo.
pause
exit /b 0

:notinstalled
echo Voicigame is not installed in this folder.
pause
exit /b 0

:noaccess
if exist override.cfg.tmp del override.cfg.tmp >nul 2>&1
echo This folder is write protected.
echo Right-click "Uninstall Voicigame.bat" and choose "Run as administrator".
pause
exit /b 1
