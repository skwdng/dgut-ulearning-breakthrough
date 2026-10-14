@echo off
rem ============================================================
rem  CAS login step-by-step comparison.
rem  Prompts for student id and password locally; nothing is saved.
rem
rem  IMPORTANT: keep this file PURE ASCII (see other .cmd files).
rem ============================================================

setlocal
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE_EXE=node"

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE goto :nonode

if not exist "%~dp0login-steps.cjs" goto :noscript

"%NODE_EXE%" "%~dp0login-steps.cjs"
goto :done

:noscript
echo.
echo   [ERROR] login-steps.cjs not found in this folder.
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
