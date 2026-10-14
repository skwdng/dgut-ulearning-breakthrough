# 构建 Android APK

> 本文记录**本机实测可用的**打包流程，含踩过的坑。

---

## 一、一键构建

```bash
node tools/android/build-apk.cjs
```

它会依次做：

```
1. expo prebuild         生成/刷新 android/ 目录
2. wire-native.cjs       把 android-native/ 的 Kotlin 模块接回去
3. 写 local.properties   指向工作区内的 Android SDK
4. gradlew assembleRelease
5. 报告产物路径
```

只想重编译（不改原生配置）：加 `--skip-prebuild` 跳过第 1 步。

**产物**：`android/app/build/outputs/apk/release/app-release.apk`

---

## 二、首次准备（只需一次）

```bash
# 1) 下载 Android 命令行工具（约 147 MB）
node tools/android/get-sdk.cjs

# 2) 接受许可 + 安装 SDK 组件（约 1.5 GB）
node tools/android/install-sdk.cjs

# 3) 生成调试签名密钥
D:\env\jdk\bin\keytool.exe -genkeypair -v -storetype PKCS12 \
  -keystore .home\.android\debug.keystore -alias androiddebugkey \
  -storepass android -keypass android -keyalg RSA -keysize 2048 \
  -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
```

---

## 三、环境要求

| 项 | 值 | 说明 |
|---|---|---|
| JDK | 17 | 路径 `D:\env\jdk`（机器上已有） |
| Android SDK | 工作区内 `.android-sdk/` | 装在工程里，避免提权 |
| build-tools | 35.0.0 | |
| platform | android-35 | |
| Gradle | 8.10.2 | 由 wrapper 自动下载到 `.gradle-home/` |
| Node | 24.21.0 | DSH 捆绑的 |

**都放在工作区内**：`.android-sdk/` `.gradle-home/` `.home/` —— 已加进 `.gitignore`。

---

## 四、踩过的坑（按遇到顺序）

### ① pnpm 装的依赖让 Metro 崩

见 README。结论：**必须用 npm**。

### ② `expo prebuild` 报 `spawn npm ENOENT`

机器 PATH 里没有 npm。做了个 shim：

```
.tools/bin/npm.cmd        → 转发到
.tools/bin/npm-cli-shim.cjs → 调 .tools/npm/bin/npm-cli.js
```

把 `.tools/bin` 加进 PATH 即可。`build-apk.cjs` 里已经加了。

### ③ `android-native/` 的 Kotlin 模块不会被 prebuild 带进来

**这是最容易忘的一步。** prebuild 会重新生成 `android/`，
我们自己的原生模块（外卖通知监听）不在 autolinking 范围内，必须手动接：

```
1. 复制 .kt 到 android/app/src/main/java/com/lifekit/delivery/
2. MainApplication.kt 的 getPackages() 里 add(DeliveryNotificationPackage())
3. AndroidManifest.xml 里声明 DeliveryNotificationListener 这个 Service
```

`wire-native.cjs` 把这三步自动化了，且**幂等**（重复跑不会重复插入）。

### ④ Kotlin / Compose 编译器版本错配（卡最久的一个）

```
e: This version (1.5.15) of the Compose Compiler requires Kotlin version 1.9.25
   but you appear to be using Kotlin version 1.9.24
```

**根因**：`expo-modules-core/android/build.gradle` 里有一张对照表

```groovy
versionsMap = [
  "1.9.24": "1.5.14",
  "1.9.25": "1.5.15",
]
```

而 Kotlin 插件实际解析到了 **1.9.24**，Compose 编译器却是 **1.5.15** —— 差一个版本就编译不过。

**修法**：在 `android/gradle.properties` 里钉死

```properties
android.kotlinVersion=1.9.24
```

> 注意：`android/build.gradle` 里写的是 `1.9.25`，但被依赖的 classpath 覆盖了。
> 显式写进 `gradle.properties` 才生效。

### ⑤ 构建看不到进度

用了 `| Select-Object -Last 30` 导致 PowerShell 缓冲全部输出，
构建跑了 8 分钟看不到任何东西，无法判断卡在哪。

**改法**：输出重定向到日志文件，再 `Get-Content -Tail` 查看。

```
gradlew.bat assembleRelease > .gradle-build.log 2>&1
```

### ⑥ 沙箱限制

| 操作 | 问题 | 处理 |
|---|---|---|
| 装 SDK 到 `D:\android-sdk` | 沙箱只允许写工作区 | 改装到 `.android-sdk/` |
| 跑 gradle / sdkmanager | 需要 spawn 子进程，沙箱禁命名管道 | 提权运行 |

---

## 五、APK 体积

默认打四个架构 → **99 MB**。只打 arm64 → **36.5 MB**。

```bash
# 只打 arm64（绝大多数现代手机）
gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

`build-apk.cjs` 默认打全架构；要精简版就手动加参数。

---

## 六、签名说明

当前用的是**调试密钥**（`.home/.android/debug.keystore`）。

**后果**：
- 能正常安装、正常使用
- 但**换签名必须卸载重装**（Android 不允许同包名不同签名的应用共存）
- 以后要发正式版，得生成正式 keystore，且**不能弄丢**（丢了就无法给已安装用户升级）

---

## 七、安装后需要手动做的事

| 功能 | 需要用户授权 |
|---|---|
| 外卖通知自动抓取 | 系统设置 → 通知使用权 → 开启「LifeKit 外卖记录」 |
| 签到定位 | 应用内授予定位权限 |
| 扫码签到 | 应用内授予相机权限 |

App 里点「外卖 → 开启自动记录」会跳到对应的系统设置页。
