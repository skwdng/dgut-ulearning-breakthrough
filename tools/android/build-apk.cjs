// 一键构建 Android APK。
//
// 流程：
//   1. expo prebuild（生成/刷新 android/）
//   2. wire-native（把 android-native/ 的 Kotlin 模块接进去）
//   3. gradlew assembleRelease
//
// 为什么需要第 2 步：prebuild 会重新生成 android/，我们自己的原生模块
// （外卖通知监听）不在 autolinking 范围内，必须每次手动接回去。
//
// 用法：node tools/android/build-apk.cjs
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..', '..');
const JAVA_HOME = process.env.LIFEKIT_JAVA_HOME || 'D:\\env\\jdk';
const SDK = process.env.LIFEKIT_ANDROID_SDK || path.join(WORKSPACE, '.android-sdk');
const NODE_DIR = process.env.LIFEKIT_NODE_DIR || path.dirname(process.execPath);
const GRADLE_HOME = path.join(WORKSPACE, '.gradle-home');
const HOME = path.join(WORKSPACE, '.home');

const SKIP_PREBUILD = process.argv.includes('--skip-prebuild');
/** 只打指定 ABI，默认 arm64-v8a（现代手机都是，体积 1/3）。
 *  传 --all-abis 打全部四个架构。 */
const ALL_ABIS = process.argv.includes('--all-abis');
const ARCH_ARG = ALL_ABIS ? [] : ['-PreactNativeArchitectures=arm64-v8a'];

/**
 * ══════════════ ★★★ 强制重打 JS bundle ══════════════
 *
 * ⚠️ 踩过的大坑（2026-10）：对外发布版（`--dist`）**没有真的剥离**万能码，
 *    因为打出来的 bundle 跟自用版**字节完全相同**（sha256 一样）。
 *
 * 根因：**Gradle 把打 bundle 的任务当成了"输入没变就跳过"**。
 *   · `createBundleReleaseJsAndAssets` 的产物已存在
 *   · 而环境变量（`EXPO_PUBLIC_DISTRIBUTION`）**不是 Gradle 认为的输入**
 *   → 任务被 UP-TO-DATE 跳过 → Metro 根本没重新跑
 *   → 环境变量没机会内联 → 两个包一模一样
 *
 * 修法：要换环境变量打包时，**先删掉 bundle 产物 + Metro 缓存**，
 *      逼 Gradle 重新执行那个任务。
 *
 * 触发条件：环境变量 `LIFEKIT_FORCE_REBUNDLE=1`（release.cjs 的 --dist 会设）。
 */
const FORCE_REBUNDLE = process.env.LIFEKIT_FORCE_REBUNDLE === '1';

const env = {
  ...process.env,
  PATH: `${path.join(WORKSPACE, '.tools', 'bin')};${NODE_DIR};${path.join(JAVA_HOME, 'bin')};${process.env.PATH}`,
  JAVA_HOME,
  ANDROID_HOME: SDK,
  ANDROID_SDK_ROOT: SDK,
  GRADLE_USER_HOME: GRADLE_HOME,
  HOME,
  USERPROFILE: HOME,
  EXPO_HOME: path.join(HOME, '.expo'),
  EXPO_NO_TELEMETRY: '1',
  CI: '1',
};

function step(n, title) {
  console.log(`\n${'='.repeat(60)}\n${n}. ${title}\n${'='.repeat(60)}`);
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, cwd: opts.cwd ?? WORKSPACE, shell: false });
  if (r.status !== 0) {
    console.error(`\n命令失败（退出码 ${r.status}）: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

// ── 前置检查 ──
step('0', '前置检查');
/**
 * ★ 需要换环境变量打包时（--dist），先清掉 bundle 产物 + Metro 缓存。
 *   否则 Gradle 的 UP-TO-DATE 检查会跳过重新打 bundle，
 *   环境变量就白设了（见文件顶部 FORCE_REBUNDLE 的说明）。
 */
if (FORCE_REBUNDLE) {
  const targets = [
    path.join(WORKSPACE, 'android', 'app', 'build', 'generated', 'assets'),
    path.join(WORKSPACE, 'android', 'app', 'build', 'intermediates', 'assets'),
    path.join(process.env.TEMP || '', 'metro-cache'),
  ];
  console.log('  ⚠️ 强制重打 bundle：清理产物与缓存');
  for (const t of targets) {
    if (!t || !fs.existsSync(t)) continue;
    try {
      fs.rmSync(t, { recursive: true, force: true });
      console.log(`     √ 已删 ${path.relative(WORKSPACE, t) || t}`);
    } catch (e) {
      console.log(`     × 删不掉 ${t}：${e.message}（继续，可能仍然会重新打）`);
    }
  }
}
const checks = [
  ['JDK', fs.existsSync(path.join(JAVA_HOME, 'bin', 'java.exe'))],
  ['Android SDK', fs.existsSync(path.join(SDK, 'platform-tools'))],
  ['android-35', fs.existsSync(path.join(SDK, 'platforms', 'android-35'))],
  ['build-tools 35', fs.existsSync(path.join(SDK, 'build-tools', '35.0.0'))],
  ['node_modules', fs.existsSync(path.join(WORKSPACE, 'node_modules'))],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? '√' : '×'} ${name}`);
  if (!pass) ok = false;
}
if (!ok) {
  console.error('\n前置条件不满足，先跑 tools/android/get-sdk.cjs 与 install-sdk.cjs');
  process.exit(1);
}

// ── 1) prebuild ──
/**
 * ══════════════ ★★★ 换通道时必须清理 android/ ══════════════
 *
 * 用户需求：「能在我手机上弄出两个应用，一个是正常的，
 *           一个在后面加上测试版」→ 靠**不同 applicationId** 共存。
 *
 * ⚠️ 而 `expo prebuild` 是**增量**的：换包名时它会把 `build.gradle`
 *    里的 applicationId 改掉，但**旧的 Java/Kotlin 源码目录会留着**
 *    （`android/app/src/main/java/com/lifekit/app/`
 *      vs 新的 `.../com/lifekit/app/test/`），
 *    结果就是编译报"重复类"或者打出来的包名和预期不符。
 *
 * 所以：**通道变了就先删掉 android/ 再 prebuild**（那是生成物，
 * 删了由 prebuild + wire-native 重建）。
 *
 * ⚠️ 只在**真的变了**的时候删 —— 每次都删会让构建从 1 分钟变 5 分钟。
 */
/**
 * ══════════════ ★★★ 判断"要不要清理 android/" ══════════════
 *
 * ⚠️ 这里必须看**最终包名**，而不是只看通道。
 *
 * 踩过的坑（2026-10）：多版本方案下，不同通道可能用**同一个通道标记**
 * 但**不同包名**（如 release → com.lifekit.app，test → com.lifekit.app.test）。
 * 我第一版只记了通道名，于是切换时判定"通道没变、不用清理"，
 * 结果 prebuild 生成的目录和上一轮留下的同时存在
 * → Kotlin 编译报 **Redeclaration**（重复声明）。
 *
 * ⚠️ 而且 `.test` 是 `.app` 的**子包**，旧目录会变成"父包"留下来，
 *    光靠"删掉旧包名目录"也不够 —— 得把不匹配的都清掉。
 *
 * ⚠️ 2026-10 变更：自用版已删除，只剩 release / test 两个通道。
 *    传 'self' 会被当成 release（见 app.config.js 的说明）——
 *    宁可打出对外版，也绝不误产出一个带万能码的包。
 */
const CHANNEL = process.env.EXPO_PUBLIC_CHANNEL === 'test' ? 'test' : 'release';

/** 各版本的最终包名 —— 必须和 app.config.js 保持一致 */
const PACKAGE_BY_CHANNEL = {
  release: 'com.lifekit.app',
  test: 'com.lifekit.app.test',
};
const PACKAGE = PACKAGE_BY_CHANNEL[CHANNEL];

const CHANNEL_MARK = path.join(WORKSPACE, '.build-channel');
let lastMark = '';
try {
  lastMark = fs.readFileSync(CHANNEL_MARK, 'utf8').trim();
} catch {
  lastMark = '';
}

/**
 * 需要清理的两种情况：
 *   ① 标记里的包名与本次不同（含"标记不存在但 android 已存在"）
 *   ② 标记格式是老版本（只有通道名）→ 也清一次，保证干净
 */
const markerHasPackage = lastMark.includes('/');
const lastPackage = markerHasPackage ? lastMark.split('/')[1] : '';
const needClean = fs.existsSync(path.join(WORKSPACE, 'android'))
  && (!markerHasPackage || lastPackage !== PACKAGE);

if (needClean) {
  console.log(`\n  ⚠️ 需要清理 android/`);
  console.log(`     上次包名：${lastPackage || '(未知/旧标记 ' + (lastMark || '空') + ')'}`);
  console.log(`     本次包名：${PACKAGE}`);
  console.log('     （换包名必须清理，否则旧包目录的源码会残留导致重复声明）');
  fs.rmSync(path.join(WORKSPACE, 'android'), { recursive: true, force: true });
}

/**
 * ★ 标记在 prebuild **之前**写。
 *
 * ⚠️ 原先写在 prebuild 成功之后 —— "prebuild 成了但编译失败"时标记已落盘，
 *    下次就以为"没变、不用清理"，残留继续害人。
 */
try {
  fs.writeFileSync(CHANNEL_MARK, `${CHANNEL}/${PACKAGE}`, 'utf8');
} catch {
  /* 记不下也不影响本次构建 */
}

if (SKIP_PREBUILD && fs.existsSync(path.join(WORKSPACE, 'android'))) {
  step('1', 'prebuild —— 已跳过（--skip-prebuild）');
} else {
  step('1', `expo prebuild（通道：${CHANNEL}，包名：${PACKAGE}）`);
  run(process.execPath, [path.join(WORKSPACE, 'node_modules', '@expo', 'cli', 'build', 'bin', 'cli'), 'prebuild', '--platform', 'android', '--no-install']);
}

/**
 * ══════════════ ★★★ prebuild 之后：清掉不属于当前包名的源码目录 ══════════════
 *
 * ⚠️ `expo prebuild` 是**增量**的：它只保证"该有的文件在"，
 *    不保证"不该有的文件被删"。
 *
 *    `com.lifekit.app.self` 是 `com.lifekit.app` 的**子包**，所以
 *    prebuild 会在 `.../java/com/lifekit/app/self/` 生成入口，
 *    而上一轮留在 `.../java/com/lifekit/app/` 的 MainActivity/MainApplication
 *    以及我们接入的 `delivery/`、`webcookie/` 目录**都还在** ——
 *    Gradle 把整个 java/ 树都编译，于是同一个类被声明两次 →
 *      `e: Redeclaration: DeliveryNotificationModule`
 *
 * 所以这里做一次"白名单清理"：在 `com/lifekit/` 下面，
 * **只保留当前包名对应的那条路径**，其余目录删掉。
 *
 * ⚠️ 删的是**生成物目录**（prebuild 会重建），不是手写代码。
 */
{
  const JAVA_ROOT = path.join(WORKSPACE, 'android', 'app', 'src', 'main', 'java');
  const PKG_REL = PACKAGE.split('.'); // ['com','lifekit','app','self']
  const BASE = path.join(JAVA_ROOT, 'com', 'lifekit');
  if (fs.existsSync(BASE)) {
    console.log(`\n  ★ 清理不属于 ${PACKAGE} 的残留源码目录`);
    /**
     * 当前包名在 com/lifekit 下面的**相对段**，例如：
     *   com.lifekit.app      → ['app']
     *   com.lifekit.app.self → ['app','self']
     */
    const segs = PKG_REL.slice(2); // 去掉 com / lifekit

    /** 判断某个目录路径是否是"当前包名路径"的前缀链上的一环 */
    const isOnCurrentPath = (relSegs) =>
      relSegs.every((s, i) => segs[i] === s);

    /** 递归清理：只沿着当前包名那条链往下走，其余兄弟目录全删 */
    function prune(dir, depth) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = path.join(dir, e.name);
        const relSegs = PKG_REL.slice(2, 2 + depth + 1);
        if (isOnCurrentPath([...relSegs.slice(0, depth), e.name])) {
          /** 还在当前包名链上 —— 继续往下 */
          prune(p, depth + 1);
        } else {
          /** ⚠️ 不在链上 → 是别的包名留下的，删掉 */
          /**
           * 例外：我们自己的原生模块（delivery / webcookie / crash）是**独立包**，
           * 由 wire-native 放在 com/lifekit/ 下面，要保留。
           * ⚠️ 少了 crash 这一项，清理逻辑会把刚接进去的崩溃模块删掉，
           *    然后 wire-native 又把它放回去 —— 表现为"改了没生效"，很难查。
           */
          if (e.name === 'delivery' || e.name === 'webcookie' || e.name === 'crash') continue;
          fs.rmSync(p, { recursive: true, force: true });
          console.log(`     删除残留目录 ${path.relative(JAVA_ROOT, p)}`);
        }
      }
    }
    prune(BASE, 0);
  }
}

// ── 2) 接入原生模块 ──
step('2', '接入原生模块（外卖通知监听）');
run(process.execPath, [path.join(__dirname, 'wire-native.cjs')]);

// ── 3) 写 local.properties ──
step('3', '写 local.properties');
const sdkEscaped = SDK.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
fs.writeFileSync(path.join(WORKSPACE, 'android', 'local.properties'), `sdk.dir=${sdkEscaped}`, 'ascii');
console.log('  sdk.dir=' + SDK);

// ── 4) Gradle 构建 ──
step('4', `gradlew assembleRelease ${ARCH_ARG.join(' ') || '(全架构)'}`);
run('cmd.exe', ['/c', 'gradlew.bat', 'assembleRelease', ...ARCH_ARG, '--no-daemon', '--console=plain'], {
  cwd: path.join(WORKSPACE, 'android'),
});

// ── 5) 找产物 ──
step('5', '构建产物');
const apkDir = path.join(WORKSPACE, 'android', 'app', 'build', 'outputs', 'apk', 'release');
if (!fs.existsSync(apkDir)) {
  console.error('  找不到输出目录: ' + apkDir);
  process.exit(1);
}
const apks = fs.readdirSync(apkDir).filter((f) => f.endsWith('.apk'));
for (const f of apks) {
  const full = path.join(apkDir, f);
  const size = fs.statSync(full).size;
  console.log(`  √ ${f}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`     ${full}`);
}
if (apks.length === 0) console.error('  没有找到 APK');
