@echo off
rem Installs the Voicigame mod: extract the whole ZIP into the game folder (next to the game's exe),
rem then double-click this file. It adds one line to override.cfg next to the exe, the game files stay unchanged.
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

if not exist "voicigame\main.gd" goto nofolder
dir /b *.exe 2>nul | findstr /i "choicer" >nul || goto nogame

rem Can we write here? (Steam folders under Program Files need admin rights)
copy /y nul "voicigame_write_test.tmp" >nul 2>&1 || goto noaccess
del "voicigame_write_test.tmp" >nul 2>&1

rem Remove an older Voicigame entry (for example from another folder), keep everything else
if exist override.cfg (
  findstr /v /i /b /c:"Voicigame=" override.cfg > override.cfg.tmp
  move /y override.cfg.tmp override.cfg >nul
  rem Only section headers and empty lines left: start the file fresh
  findstr /r /v /c:"^\[.*\]$" /c:"^ *$" override.cfg >nul || type nul > override.cfg
)

rem Last section already [autoload]? Then only add the line, otherwise a new [autoload] section
set "LAST="
if exist override.cfg for /f "delims=" %%L in ('findstr /r /c:"^\[.*\]$" override.cfg') do set "LAST=%%L"
if /i not "%LAST%"=="[autoload]" (
  >>override.cfg echo.
  >>override.cfg echo [autoload]
  >>override.cfg echo.
)
set "MAIN=%~dp0voicigame\main.gd"
set "MAIN=%MAIN:\=/%"
>>override.cfg echo Voicigame="*%MAIN%"

echo.
echo Voicigame is installed.
echo Start the game, then Play and the Voicigame tile.
echo.
pause
exit /b 0

:nofolder
echo The folder "voicigame" is missing. Extract the whole ZIP into the game folder.
pause
exit /b 1

:nogame
echo No The Choicer Voicer exe found here.
echo Extract the ZIP into the folder that contains the game's exe, then run this file again.
pause
exit /b 1

:noaccess
echo This folder is write protected.
echo Right-click "Install Voicigame.bat" and choose "Run as administrator".
pause
exit /b 1
