@echo off
rem ============================================================
rem  Deep login diagnosis: saves the raw CAS response and shows
rem  the exact reason, plus checks for full-width characters in
rem  the password (a very common copy/paste trap).
rem
rem  IMPORTANT: keep this file PURE ASCII.
rem ============================================================

setlocal
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE_EXE=node"

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE goto :nonode

if not exist "%~dp0login-deep.cjs" goto :noscript

"%NODE_EXE%" "%~dp0login-deep.cjs"
goto :done

:noscript
echo.
echo   [ERROR] login-deep.cjs not found in this folder.
echo.
pause
goto :done

:nonode
echo.
echo   [ERROR] Node.js not found. Install it from https://nodejs.org
echo.
pause

:done
endlocal
