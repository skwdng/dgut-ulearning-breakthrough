// 把 android-native/ 里的原生模块接入 prebuild 生成的 android/ 工程。
//
// prebuild 会重新生成 android/，所以这一步必须在每次 prebuild 之后跑。
// 做三件事：
//   1. 复制 .kt 到 android/app/src/main/java/com/lifekit/delivery/
//   2. 在 MainApplication.kt 的 getPackages() 里注册 package
//   3. 在 AndroidManifest.xml 里加 NotificationListenerService 声明
//
// 幂等：重复跑不会重复插入。
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..', '..');
const SRC = path.join(WORKSPACE, 'android-native');
const ANDROID = path.join(WORKSPACE, 'android');
/**
 * ⚠️⚠️ 这几个路径**不能写死**。
 *
 * ══════════════ 踩过的坑（2026-10）══════════════
 *
 * 原来写死成 `.../java/com/lifekit/app/MainApplication.kt`。
 * 而用户要求「测试版要和正式版**同时装在一台手机上**」→
 * 测试版必须用**不同包名**（`com.lifekit.app.test`），
 * 于是 prebuild 把源码目录生成到了
 *     `.../java/com/lifekit/app/test/MainApplication.kt`
 * 写死的路径就找不到了 → 构建失败：
 *     ENOENT ... com/lifekit/app/MainApplication.kt
 *
 * ⚠️ 写这段注释时踩了个坑（同一个坑的**第二次**）：
 *    本来想强调 "test" 那一段，写成了带星号的形式，
 *    结果里面的「星号紧跟斜杠」**提前结束了块注释**，
 *    后面几十行普通文字被当成代码 → 报了一堆莫名其妙的语法错
 *    （报在第 52 行的模板字符串上，跟真正的错因完全无关）。
 *    ★ 块注释里**绝不能出现「星号 + 斜杠」**。
 *    有自动检查盯着：tools/check-comment-traps.cjs
 *
 * 修法：**在源码树里搜** MainApplication.kt，不猜包名。
 *      这样换通道/换包名都不会再断。
 */
const JAVA_SRC_ROOT = path.join(ANDROID, 'app', 'src', 'main', 'java');

/** 在目录里递归找第一个匹配的文件名 */
function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (e.name === name) {
      return p;
    }
  }
  return null;
}

const MAIN_APP = findFile(JAVA_SRC_ROOT, 'MainApplication.kt');
if (!MAIN_APP) {
  console.error(`  × 在 ${JAVA_SRC_ROOT} 里找不到 MainApplication.kt`);
  console.error('    （prebuild 没跑完？或者包名结构变了？）');
  process.exit(1);
}
/**
 * ⚠️ 原生模块的目标目录：放在**应用程序包的同级**（`.../com/lifekit/delivery/`）。
 *    用 MainApplication.kt 所在目录往上推两级，得到 `com/lifekit/`。
 *    这样换包名时它自动跟着走。
 */
const APP_PKG_DIR = path.dirname(MAIN_APP); // .../com/lifekit/app[/test]
const JAVA_ROOT = path.dirname(APP_PKG_DIR); // .../com/lifekit
const JAVA_DIR = path.join(JAVA_ROOT, 'delivery');
const JAVA_DIR_COOKIE = path.join(JAVA_ROOT, 'webcookie');
/** ★ 崩溃日志模块的目标包（2026-10）：com/lifekit/crash/ */
const JAVA_DIR_CRASH = path.join(JAVA_ROOT, 'crash');
const MANIFEST = path.join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml');

const log = (s) => console.log('  ' + s);

if (!fs.existsSync(ANDROID)) {
  console.error('android/ 不存在 —— 先跑 expo prebuild');
  process.exit(1);
}

/**
 * 每个原生模块：Kotlin 文件 → 目标包目录 → Package 类的 import / add() 行。
 *
 * 分开放的：DeliveryNotification 与 WebCookie 是**不同包名**的独立模块，
 * 不能都塞进 delivery 目录。
 */
const MODULES = [
  {
    label: '外卖通知监听',
    files: ['DeliveryNotificationModule.kt', 'DeliveryNotificationPackage.kt'],
    dir: JAVA_DIR,
    importLine: 'import com.lifekit.delivery.DeliveryNotificationPackage',
    addLine: '            packages.add(DeliveryNotificationPackage())',
  },
  {
    label: 'WebView Cookie 读取',
    files: ['WebCookieModule.kt', 'WebCookiePackage.kt'],
    dir: JAVA_DIR_COOKIE,
    importLine: 'import com.lifekit.webcookie.WebCookiePackage',
    addLine: '            packages.add(WebCookiePackage())',
  },
  {
    /**
     * ★ 原生崩溃日志读取（2026-10）。
     *
     * 用户真机闪退「点进去马上退出来」：服务器只有 JS 的 entry、没有
     * shell_mounted、没有 JS 错误 → 崩在原生层。
     * NativeCrashHandler 负责崩溃时写盘，本模块让 JS 下次启动读走并上报。
     * 详见 android-native/NativeCrashHandler.kt 与 services/crashReport.ts。
     */
    label: '原生崩溃日志读取',
    files: ['NativeCrashLogModule.kt', 'NativeCrashLogPackage.kt', 'NativeCrashHandler.kt'],
    dir: JAVA_DIR_CRASH,
    importLine: 'import com.lifekit.crash.NativeCrashLogPackage',
    addLine: '            packages.add(NativeCrashLogPackage())',
  },
];

// ── 1) 复制 Kotlin 文件 ──
console.log('① 复制原生模块');
for (const m of MODULES) {
  fs.mkdirSync(m.dir, { recursive: true });
  for (const f of m.files) {
    const from = path.join(SRC, f);
    if (!fs.existsSync(from)) {
      console.error(`  × 源文件不存在: ${f}`);
      process.exit(1);
    }
    fs.copyFileSync(from, path.join(m.dir, f));
    log(`√ ${f}`);
  }
}

// ── 2) 注册 package ──
console.log('\n② 在 MainApplication.kt 注册 package');
let app = fs.readFileSync(MAIN_APP, 'utf8');

/**
 * ★ 先清理"历史残留"（2026-10 踩坑）。
 *
 * `expo prebuild` 是**增量**的：它不会覆盖已存在的 MainApplication.kt。
 * 于是早期版本把手写崩溃钩子直接改在这个生成文件里 → 后续每次构建都残留：
 *   · 旧 import（指向已经不存在的包名）
 *   · 重复的 packages.add(...)
 *   · 旧的 installNativeCrashHandler() 函数与调用
 * 结果编译报 "Unresolved reference"。
 *
 * 所以这里先把项目自己加过的痕迹全部去掉，再统一重新插入（幂等）。
 */
function stripOurCustomizations(src) {
  return src
    /** 旧 import（任意包名路径下的 NativeCrashLogPackage） */
    .replace(/^import com\.lifekit[\w.]*\.NativeCrashLogPackage\r?\n/gm, '')
    /** 旧 add() 行（可能重复插了好几次） */
    .replace(/^\s*packages\.add\(NativeCrashLogPackage\(\)\)\r?\n/gm, '')
    /** 旧钩子函数（含它前面的注释块） */
    .replace(/\/\*\*[\s\S]*?\*\/\s*\r?\n\s*private fun installNativeCrashHandler\(\) \{[\s\S]*?\r?\n {2}\}\r?\n/g, '')
    /** 旧钩子调用 */
    .replace(/^\s*installNativeCrashHandler\(\)\r?\n/gm, '')
    /** 旧钩子调用上方的注释行 */
    .replace(/^\s*\/\/ ★ 必须先装钩子[^\n]*\r?\n/gm, '');
}
const beforeCleanup = app.length;
app = stripOurCustomizations(app);
if (app.length !== beforeCleanup) {
  log(`√ 清理了历史残留（${beforeCleanup - app.length} 字符）`);
}

for (const m of MODULES) {
  if (app.includes(m.importLine)) {
    log(`已注册，跳过（${m.label}）`);
    continue;
  }
  // 插到 expo 的 import 之前，保持分组整洁
  app = app.replace(
    'import expo.modules.ApplicationLifecycleDispatcher',
    `${m.importLine}\n\nimport expo.modules.ApplicationLifecycleDispatcher`,
  );
  // 插到 getPackages() 的 return 之前
  app = app.replace(
    '            val packages = PackageList(this).packages',
    `            val packages = PackageList(this).packages\n${m.addLine}`,
  );
  if (!app.includes(m.addLine)) {
    console.error(`  × add() 插入失败（${m.label}），请手工检查 MainApplication.kt`);
    process.exit(1);
  }
  log(`√ 已插入 import 与 add()（${m.label}）`);
}
fs.writeFileSync(MAIN_APP, app, 'utf8');

// ── 2.6) 装原生崩溃钩子（2026-10）──
/*
 * 用户真机（华为 Mate 70 Pro / HarmonyOS）「点进去马上退出来」，
 * 而服务器只收到 JS 的 entry、没有 shell_mounted、没有任何 JS 错误 →
 * 崩在原生层。这里把 NativeCrashHandler.install(this) 插到
 * MainApplication.onCreate() 的**最前面**（super.onCreate() 之前），
 * 这样 SoLoader / expo 初始化阶段崩了也能被记录。
 *
 * 为什么不在生成的 MainApplication 里手改：prebuild 每次都会重新生成，
 * 手改的内容会被覆盖（这个坑踩过）。所以补丁必须写在这里，每次构建自动打。
 */
console.log('\n②.6 装原生崩溃钩子');
{
  let main = fs.readFileSync(MAIN_APP, 'utf8');
  const IMPORT = 'import com.lifekit.crash.NativeCrashHandler';
  const CALL = '    NativeCrashHandler.install(this)';

  if (main.includes(CALL)) {
    log('已装，跳过');
  } else {
    if (!main.includes(IMPORT)) {
      main = main.replace(
        'import expo.modules.ApplicationLifecycleDispatcher',
        `${IMPORT}\n\nimport expo.modules.ApplicationLifecycleDispatcher`,
      );
    }
    /** 插在 onCreate 的 super.onCreate() 之前 */
    const patched = main.replace(
      /(override fun onCreate\(\) \{\n)(\s*)super\.onCreate\(\)/,
      `$1${CALL}\n$2super.onCreate()`,
    );
    if (patched === main || !patched.includes(CALL)) {
      console.error('  × 插桩失败：MainApplication.onCreate() 的结构变了，请手工检查');
      process.exit(1);
    }
    main = patched;
    fs.writeFileSync(MAIN_APP, main, 'utf8');
    log(`√ 已插入 ${IMPORT}`);
    log('√ 已插入 NativeCrashHandler.install(this)（super.onCreate 之前）');
  }
}

// ── 2.5) 把 JS 入口从 expo-router 的虚拟入口改成普通 index.js ──
// 坑：prebuild 会把 getJSMainModuleName 写成 ".expo/.virtual-metro-entry"，
// 那是 expo-router 专用的。我们已经不用 expo-router（鸿蒙上原生导航会白屏），
// 所以必须改回标准的 "index"。
console.log('\n②.5 校验 JS 入口');
let mainApp = fs.readFileSync(MAIN_APP, 'utf8');
const VIRTUAL = '".expo/.virtual-metro-entry"';
if (mainApp.includes(VIRTUAL)) {
  mainApp = mainApp.replace(VIRTUAL, '"index"');
  fs.writeFileSync(MAIN_APP, mainApp, 'utf8');
  log(`√ getJSMainModuleName: .expo/.virtual-metro-entry → index`);
} else if (mainApp.includes('getJSMainModuleName(): String = "index"')) {
  log('√ 已是 "index"');
} else {
  const cur = (mainApp.match(/getJSMainModuleName\(\):\s*String\s*=\s*"([^"]*)"/) || [])[1];
  log(`⚠️ 意外的入口值: ${cur}`);
}

// ── 3.3) 校验适配器（关键！）──
// 坑：以前用 process.env.EXPO_PUBLIC_YOUXUE_ADAPTER 选适配器，
// 但实测 release 构建里这个变量**不会被内联**，运行时退化成 undefined
// → 永远走 mock（假数据），而且毫无报错。
// 现在配置写在源码常量里（src/config/buildConfig.ts），这里直接读源码校验。
console.log('\n③.3 校验优学院适配器');
const BUILD_CFG = path.join(WORKSPACE, 'src', 'config', 'buildConfig.ts');
let adapterKind = '(读不到)';
if (fs.existsSync(BUILD_CFG)) {
  const src = fs.readFileSync(BUILD_CFG, 'utf8');
  const m = src.match(/const\s+ADAPTER\s*:\s*AdapterKind\s*=\s*'(\w+)'/);
  if (m) adapterKind = m[1];
}
const isMock = adapterKind !== 'youxue';
if (isMock) {
  log(`⚠️⚠️ 适配器 = ${adapterKind}`);
  log('     打出来的包会跑【假数据】！真实签到/作业/课件都不可用。');
  log('     要连真实优学院，请把 src/config/buildConfig.ts 里的 ADAPTER 改成 \'youxue\'');
  if (!process.argv.includes('--allow-mock')) {
    log('     （确认要打 mock 包，请加 --allow-mock）');
    log('     —— 已阻止构建 ——');
    process.exit(1);
  }
  log('     --allow-mock 已指定，继续。');
} else {
  log(`√ 适配器 = ${adapterKind}（连真实优学院）`);
  log(`     来源: src/config/buildConfig.ts 的 ADAPTER 常量`);
}

// ── 3.4) 钉住 Kotlin 版本（否则 Compose 编译器版本错配，编译必败）──
// 坑：expo-modules-core 内置一张对照表
//     "1.9.24" -> Compose 1.5.14
//     "1.9.25" -> Compose 1.5.15
// 而 Gradle 实际解析到的 Kotlin 插件是 1.9.24，Compose 却是 1.5.15 → 编译报
//   "This version (1.5.15) of the Compose Compiler requires Kotlin version 1.9.25
//    but you appear to be using Kotlin version 1.9.24"
// android/build.gradle 里写的是 1.9.25，但会被依赖的 classpath 覆盖，
// 只有写进 gradle.properties 才生效。
console.log('\n③.4 钉住 Kotlin 版本');
const GRADLE_PROPS = path.join(ANDROID, 'gradle.properties');
const KOTLIN_PIN = 'android.kotlinVersion=1.9.24';
let props = fs.readFileSync(GRADLE_PROPS, 'utf8');
if (/^android\.kotlinVersion=/m.test(props)) {
  const cur = (props.match(/^android\.kotlinVersion=(.+)$/m) || [])[1];
  if (cur.trim() === '1.9.24') {
    log('√ 已是 1.9.24');
  } else {
    props = props.replace(/^android\.kotlinVersion=.*$/m, KOTLIN_PIN);
    fs.writeFileSync(GRADLE_PROPS, props, 'utf8');
    log(`√ ${cur.trim()} → 1.9.24`);
  }
} else {
  props +=
    '\n# Kotlin 版本必须与 expo-modules-core 的 Compose 编译器版本表匹配\n' +
    '# （它内置：1.9.24 -> Compose 1.5.14，1.9.25 -> Compose 1.5.15）\n' +
    '# 实测 Kotlin 插件解析到 1.9.24，所以钉死 1.9.24 避免版本错配\n' +
    `${KOTLIN_PIN}\n`;
  fs.writeFileSync(GRADLE_PROPS, props, 'utf8');
  log('√ 已写入 android.kotlinVersion=1.9.24');
}

// ── 3.5) 确保 versionCode 递增（覆盖安装需要更高的 versionCode）──
// 坑：prebuild 会用 app.json 的 android.versionCode 重新生成 build.gradle。
// 如果一直是 1，同签名覆盖安装会被部分手机拒绝（报"应用未安装"）。
console.log('\n③.5 校验 versionCode');
const APP_GRADLE = path.join(ANDROID, 'app', 'build.gradle');
const appJsonPath = path.join(WORKSPACE, 'app.json');
let gradle = fs.readFileSync(APP_GRADLE, 'utf8');
const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
const wantCode = appJson.expo?.android?.versionCode;
const wantName = appJson.expo?.version;
const curCode = (gradle.match(/versionCode\s+(\d+)/) || [])[1];
const curName = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1];

log(`app.json:    versionCode=${wantCode}  version=${wantName}`);
log(`build.gradle: versionCode=${curCode}  versionName=${curName}`);

let changed = false;
if (wantCode && String(wantCode) !== String(curCode)) {
  gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${wantCode}`);
  changed = true;
  log(`√ versionCode: ${curCode} → ${wantCode}`);
}
// 让 build.gradle 的 versionName 也统一到 app.json 的 version
if (wantName && wantName !== curName && /^\d+\.\d+\.\d+/.test(wantName)) {
  gradle = gradle.replace(/versionName\s+"[^"]+"/, `versionName "${wantName}"`);
  changed = true;
  log(`√ versionName: ${curName} → ${wantName}`);
}
if (changed) fs.writeFileSync(APP_GRADLE, gradle, 'utf8');
else log('√ 已一致，无需改写');

// ── 4) AndroidManifest 加 Service + 明文流量 ──
console.log('\n④ 在 AndroidManifest.xml 声明 NotificationListenerService');
/**
 * ⚠️ Service 的 android:name 必须写**全名** `com.lifekit.delivery.DeliveryNotificationListener`。
 *
 * 为什么不能用相对名 `.delivery.DeliveryNotificationListener`：
 *   相对名按 manifest 的 namespace（= applicationId = com.lifekit.app.test）解析，
 *   得到 com.lifekit.app.test.delivery.DeliveryNotificationListener；
 *   而 Kotlin 源码 java 里写的是 `package com.lifekit.delivery`（android-native/*.kt），
 *   真正打进 dex 的类叫 com.lifekit.delivery.DeliveryNotificationListener。
 *   两者不一致 → 每次进程启动 handleCreateService 抛 ClassNotFoundException →
 *   RuntimeException 直接杀进程。真机表现就是"点进去退一下/退两次才进"。
 *   2026-10-31 用服务器 /opt/lifekit/client-errors.log 里的 native_crash 栈定位（test.12~test.17 全中）。
 *
 * 注意：模块文件被拷到 com/lifekit/app/delivery/ 目录，但目录不决定类名，
 *       Kotlin 只认文件里的 package 声明 —— 所以这里对的是 package，不是目录。
 */
const LISTENER_FQCN = 'com.lifekit.delivery.DeliveryNotificationListener';
const LISTENER_RELATIVE = '.delivery.DeliveryNotificationListener';
let manifest = fs.readFileSync(MANIFEST, 'utf8');
if (manifest.includes(LISTENER_FQCN)) {
  log('已声明（全名），跳过');
} else if (manifest.includes(`android:name="${LISTENER_RELATIVE}"`)) {
  // 老版本写成了相对名：就地修正，不要因为"已包含 DeliveryNotificationListener"就跳过。
  manifest = manifest.replace(
    `android:name="${LISTENER_RELATIVE}"`,
    `android:name="${LISTENER_FQCN}"`,
  );
  log(`√ 相对名修正为全名 ${LISTENER_FQCN}`);
} else {
  const SERVICE = `
    <!-- 外卖通知监听：读取外卖平台的通知流，自动记录订单 -->
    <service
        android:name="${LISTENER_FQCN}"
        android:label="LifeKit 外卖记录"
        android:exported="false"
        android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">
      <intent-filter>
        <action android:name="android.service.notification.NotificationListenerService" />
      </intent-filter>
    </service>`;
  // 插到 </application> 之前
  if (!manifest.includes('</application>')) {
    console.error('  × 找不到 </application>');
    process.exit(1);
  }
  manifest = manifest.replace('</application>', `${SERVICE}\n  </application>`);
  log('√ 已插入 service 声明');
}

// 允许明文流量：优学院站点在内部有 http 跳转，Android 9+ 默认会拦，
// 表现为 WebView 白屏。调试阶段先放开。
if (manifest.includes('usesCleartextTraffic')) {
  log('已允许明文流量，跳过');
} else {
  manifest = manifest.replace(
    '<application android:name=".MainApplication"',
    '<application android:usesCleartextTraffic="true" android:name=".MainApplication"',
  );
  log('√ 已加 usesCleartextTraffic');
}

// ── 5) 应用内更新需要的两样东西 ──
console.log('\n⑤ 准备「应用内更新」所需的 Manifest 配置');

/**
 * ⚠️ 为什么必须在**这个脚本**里做，而不是直接改 AndroidManifest.xml：
 *    manifest 是 `expo prebuild` **生成**的，手改会在下次 prebuild 被覆盖。
 *    这里每次自动补，才不会被冲掉。
 */

// ① REQUEST_INSTALL_PACKAGES：Android 8.0+ 装未知来源应用需要它
if (manifest.includes('REQUEST_INSTALL_PACKAGES')) {
  log('已有 REQUEST_INSTALL_PACKAGES，跳过');
} else {
  manifest = manifest.replace(
    '<uses-permission android:name="android.permission.INTERNET"/>',
    '<uses-permission android:name="android.permission.INTERNET"/>\n' +
      '  <!-- 应用内更新：下载新版本后交给系统安装器 -->\n' +
      '  <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/>',
  );
  log('√ 已加 REQUEST_INSTALL_PACKAGES');
}

/**
 * ② FileProvider —— **不需要我们加**
 *
 * 一开始我以为要自己配一个，实际查下来：
 *   expo-file-system **自带** FileSystemFileProvider，
 *   而且它的 paths 资源已经覆盖了我们需要的一切：
 *       <files-path name="expo_files" path="." />
 *       <cache-path name="cached_expo_files" path="." />
 *   而 `getContentUriAsync()` 内部写死了用**它自己**那个 authority：
 *       `${packageName}.FileSystemFileProvider`
 *
 * ⚠️ 所以自己再加一个 provider 是多余且有害的：
 *    万一我的 paths 配窄了，content:// URI 反而拿不到文件，
 *    表现为"下载成功、点安装报错"，极难排查。
 *    这里只做**校验**（见下面 ⑥），不再插入。
 */
log('FileProvider 由 expo-file-system 自带，无需自行添加（仅校验）');

/**
 * ⚠️⚠️ 但要**清理历史遗留** —— 这里踩过一次坑，值得记下来：
 *
 * 我早期版本在这个脚本里插入过自己的 provider（配 @xml/update_filepaths）。
 * 后来发现不需要，就把它从脚本里删了、也删了那个 xml 文件。
 * 结果**构建直接失败**：
 *     AAPT: error: resource xml/update_filepaths not found
 *
 * 原因是：`expo prebuild`（不带 --clean）**不会重新生成 AndroidManifest.xml**，
 * 所以上次插进去的那段一直留在文件里，而它引用的资源已经不存在了。
 *
 * 教训：**"会插入的东西"必须同时能被"撤掉"**，否则改主意的时候就会卡住。
 * 下面这段就是撤掉逻辑 —— 一旦发现是我们早期插入的 provider，就删干净。
 */
if (manifest.includes('com.lifekit.app.fileprovider')) {
  const stale =
    /\s*<provider[^>]*android:authorities="com\.lifekit\.app\.fileprovider"[\s\S]*?<\/provider>/;
  if (stale.test(manifest)) {
    manifest = manifest.replace(stale, '');
    log('√ 已清理早期插入的多余 provider（现在用 expo-file-system 自带的）');
  }
}

fs.writeFileSync(MANIFEST, manifest, 'utf8');

// ── 校验 ──
console.log('\n⑥ 校验');
const checks = [
  ['Kotlin 文件已复制', fs.existsSync(path.join(JAVA_DIR, 'DeliveryNotificationModule.kt'))],
  ['Package 文件已复制', fs.existsSync(path.join(JAVA_DIR, 'DeliveryNotificationPackage.kt'))],
  ['MainApplication 已注册', fs.readFileSync(MAIN_APP, 'utf8').includes('DeliveryNotificationPackage()')],
  ['WebCookie 模块已复制', fs.existsSync(path.join(JAVA_DIR_COOKIE, 'WebCookieModule.kt'))],
  ['WebCookie 已注册', fs.readFileSync(MAIN_APP, 'utf8').includes('WebCookiePackage()')],
  ['Manifest 已声明 Service', fs.readFileSync(MANIFEST, 'utf8').includes('DeliveryNotificationListener')],
  ['Manifest 已允许明文流量', fs.readFileSync(MANIFEST, 'utf8').includes('usesCleartextTraffic')],
  /**
   * ★ 应用内更新的两条 —— 缺任何一条都会表现为
   *   "能下载、点安装没反应 / 报解析失败"，很难查，所以必须校验。
   */
  ['Manifest 已加安装权限', fs.readFileSync(MANIFEST, 'utf8').includes('REQUEST_INSTALL_PACKAGES')],
  /**
   * ⚠️ FileProvider **不校验我们自己的**（已删除），而是校验
   *    expo-file-system 那个确实存在、且 paths 覆盖了私有目录。
   *    因为 getContentUriAsync() 写死了用它自己的 authority。
   */
  [
    '★ expo-file-system 的 FileProvider 资源存在',
    fs.existsSync(
      path.join(WORKSPACE, 'node_modules', 'expo-file-system', 'android', 'src', 'main', 'res', 'xml', 'file_system_provider_paths.xml'),
    ),
  ],
  [
    '★★ expo-file-system 的 FileProvider 覆盖了 files-path（更新包目录）',
    fs.existsSync(
      path.join(WORKSPACE, 'node_modules', 'expo-file-system', 'android', 'src', 'main', 'res', 'xml', 'file_system_provider_paths.xml'),
    ) &&
      fs
        .readFileSync(
          path.join(WORKSPACE, 'node_modules', 'expo-file-system', 'android', 'src', 'main', 'res', 'xml', 'file_system_provider_paths.xml'),
          'utf8',
        )
        .includes('<files-path'),
  ],
  ['JS 入口是 index（非 expo-router）', fs.readFileSync(MAIN_APP, 'utf8').includes('getJSMainModuleName(): String = "index"')],
  ['Kotlin 版本已钉 1.9.24', /^android\.kotlinVersion=1\.9\.24$/m.test(fs.readFileSync(GRADLE_PROPS, 'utf8'))],
  [`适配器 = youxue（真实数据）`, !isMock],
  [
    `versionCode = ${wantCode}`,
    (fs.readFileSync(APP_GRADLE, 'utf8').match(/versionCode\s+(\d+)/) || [])[1] === String(wantCode),
  ],
];
let allOk = true;
for (const [name, ok] of checks) {
  log(`${ok ? '√' : '×'} ${name}`);
  if (!ok) allOk = false;
}
console.log(allOk ? '\n完成' : '\n有失败项');
process.exit(allOk ? 0 : 1);
