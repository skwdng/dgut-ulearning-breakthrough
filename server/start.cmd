@echo off
rem ============================================================
rem  LifeKit admin service (console mode)
rem  Start it and keep this window open; Ctrl+C to stop.
rem
rem  IMPORTANT: keep this file PURE ASCII.
rem    cmd.exe reads .cmd using the system code page; Chinese text
rem    here causes mojibake or breaks command parsing. All Chinese
rem    output is printed by node instead.
rem ============================================================

setlocal
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE_EXE=node"

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE goto :nonode

"%NODE_EXE%" "%~dp0server.cjs"
goto :done

:nonode
echo.
echo   [ERROR] Node.js not found. Install it from https://nodejs.org
echo.
pause

:done
endlocal
