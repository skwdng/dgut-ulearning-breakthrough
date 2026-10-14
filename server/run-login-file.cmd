@echo off
rem ============================================================
rem  Login test that reads the password FROM A FILE.
rem  This bypasses cmd-window paste entirely, which is where the
rem  invisible-character problem comes from (WeChat/QQ copies).
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

if not exist "%~dp0login-from-file.cjs" goto :noscript

"%NODE_EXE%" "%~dp0login-from-file.cjs"
goto :done

:noscript
echo.
echo   [ERROR] login-from-file.cjs not found in this folder.
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
