@echo off
REM 接受 Android SDK 许可并安装所需组件。
REM 关键：用 sdkmanager 的 --licenses 子命令接受许可，管道 echo y 对它无效。
setlocal
set SDK=%~dp0..\..\.android-sdk
set JAVA_HOME=D:\env\jdk
set SM=%SDK%\cmdline-tools\latest\bin\sdkmanager.bat
set LOG=%SDK%\install.log

echo === 1) 接受所有许可 === > "%LOG%"
(echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y& echo y) | call "%SM%" --sdk_root="%SDK%" --licenses >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo === 2) 安装组件 === >> "%LOG%"
call "%SM%" --sdk_root="%SDK%" "platform-tools" "platforms;android-35" "build-tools;35.0.0" >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo === 3) 已安装列表 === >> "%LOG%"
call "%SM%" --sdk_root="%SDK%" --list_installed >> "%LOG%" 2>&1

type "%LOG%"
exit /b 0
