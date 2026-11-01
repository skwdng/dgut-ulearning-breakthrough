/**
 * 客户端崩溃上报的回归测试（2026-10）。
 *
 * ══════════════ 为什么要有它 ══════════════
 *
 * 用户反馈「测试版点进去马上退出来」—— 启动闪退。真机没连电脑、本地没模拟器，
 * 唯一能拿到证据的途径是：**崩溃时 App 自己把错误发到服务器**。
 *
 * 这套机制很容易"看起来做了、其实没生效"，所以逐条钉住：
 *   ① 钩子必须**在 App 之前**装（import 会被提升，必须用 require）
 *   ② 用的是 ErrorUtils 全局钩子（JS 崩溃能抓到）
 *   ③ 上报地址、字段、超时都在（best-effort，不能二次抛错）
 *   ④ 服务器有接收端，且**不需要管理口令**（崩溃时带不了凭据）
 *   ⑤ 启动阶段打点存在（能判断崩在模块加载还是页面）
 *
 * 用法: node tools/verify-crash-report.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  √ ${name}`);
  } else {
    fail += 1;
    console.log(`  × ${name}${extra ? '  → ' + extra : ''}`);
  }
};

const INDEX = read('index.js');
const INDEX_CODE = strip(INDEX);
const REPORTER = read('src/services/crashReport.ts');
const REPORTER_CODE = strip(REPORTER);
const APP = strip(read('App.tsx'));
const SERVER = strip(read('server/server.cjs'));

console.log('');
console.log('=== 1) ★★★ 钩子安装顺序（最容易做错的地方）===');
t(
  '★★★ index.js 先 installCrashReporter，再加载 App',
  INDEX_CODE.indexOf('installCrashReporter()') >= 0 &&
    INDEX_CODE.indexOf('installCrashReporter()') < INDEX_CODE.indexOf("require('./App')"),
  'import 会被提升，必须用 require 才抢在 App 前面',
);
t('★★★ 顺序错了会抓不到"模块加载阶段"的崩溃', INDEX_CODE.indexOf("require('./App')") > 0);
t(
  '★★ entry 阶段打点在装上钩子之后',
  INDEX_CODE.indexOf("reportStage('entry'") > INDEX_CODE.indexOf('installCrashReporter()'),
);

console.log('');
console.log('=== 2) ★★★ 全局错误钩子 ===');
t('★★★ 用 ErrorUtils.setGlobalHandler', /ErrorUtils/.test(REPORTER_CODE) && /setGlobalHandler/.test(REPORTER_CODE));
t('★★ 保留原 handler 并交还（不吞掉 RN 默认行为）', /getGlobalHandler/.test(REPORTER_CODE) && /prev\(error, isFatal\)/.test(REPORTER_CODE));
t('★★ 上报本身全部 try/catch（不能二次抛错）', /catch \{/.test(REPORTER_CODE));

console.log('');
console.log('=== 3) ★★★ 上报内容与地址 ===');
t(
  '★★★ POST /api/client-log',
  /\/api\/client-log/.test(REPORTER_CODE) && /method: 'POST'/.test(REPORTER_CODE),
);
t('★★ 带版本号（分辨是哪个包崩的）', /BUILD_CONFIG\.version/.test(REPORTER_CODE) && /versionCode/.test(REPORTER_CODE));
t('★★ 带 stage / message / stack', /stage:/.test(REPORTER_CODE) && /message:/.test(REPORTER_CODE) && /stack:/.test(REPORTER_CODE));
t('★★ 有超时（崩溃时网络可能坏）', /AbortController/.test(REPORTER_CODE) && /6000/.test(REPORTER_CODE));
t('★★ 服务器地址没填时不上报（不抛错）', /if \(!base\) return;/.test(REPORTER_CODE));

console.log('');
console.log('=== 4) ★★★ 启动阶段打点（判断崩在哪一段）===');
t('★★★ entry 带 boot 计时', /reportStage\('entry'/.test(INDEX_CODE) && /bootMs\(\)/.test(INDEX_CODE));
t('★★★ app_module_loaded 打点存在', /reportStage\('app_module_loaded'/.test(APP));
t('★★★ shell_mounted 打点存在', /reportStage\('shell_mounted'/.test(APP));
t('★★ ready 打点存在（首帧→可用的耗时）', /reportStage\('ready'/.test(APP));
t('★★ 上次启动未完成会上报（带 boot 计时）', /prev_startup_unfinished/.test(APP) && /本次 boot=/.test(APP));
t('★★ crashReport 导出 bootMs', /export function bootMs/.test(REPORTER_CODE) && /BOOT_AT/.test(REPORTER_CODE));

console.log('');
console.log('=== 4c) ★★★ 原生层（Java）崩溃抓取 ===');
{
  /**
   * 背景（2026-10）：用户华为 Mate 70 Pro 上「点进去马上退出来」，
   * 服务器只收到 entry、没有 shell_mounted、没有任何 JS 错误 → 崩在原生层。
   *
   * 关键机制（踩过坑，所以断言写得很具体）：
   *   · Kotlin 源文件放 android-native/（不是 android/ —— 那是 prebuild 生成物，
   *     每次构建都会重新生成，手写文件会被覆盖掉；第一次实现就是这么丢的）
   *   · 由 tools/android/wire-native.cjs 在 prebuild 后复制并打补丁
   *   · 钩子插在 MainApplication.onCreate() 的 super.onCreate() **之前**
   */
  const HANDLER = read('android-native/NativeCrashHandler.kt');
  const MODULE_KT = read('android-native/NativeCrashLogModule.kt');
  const PKG_KT = read('android-native/NativeCrashLogPackage.kt');
  const WIRE = read('tools/android/wire-native.cjs');

  t('★★★ 原生崩溃处理器存在（android-native/）', /setDefaultUncaughtExceptionHandler/.test(HANDLER));
  t('★★★ 崩溃栈写进 native-crash.log', /native-crash\.log/.test(HANDLER));
  t('★★★ 原生模块 + Package 存在', /NativeCrashLog/.test(MODULE_KT) && /NativeCrashLogPackage/.test(PKG_KT));
  t(
    '★★★ wire-native 会自动复制并注册该模块（否则 prebuild 后丢失）',
    /NativeCrashLogPackage\.kt/.test(WIRE) && /packages\.add\(NativeCrashLogPackage\(\)\)/.test(WIRE),
  );
  t(
    '★★★ wire-native 把钩子插在 super.onCreate() 之前',
    WIRE.indexOf('NativeCrashHandler.install(this)') >= 0 && /super\.onCreate\(\)/.test(WIRE),
    '顺序反了抓不到 SoLoader/expo 初始化阶段的崩溃',
  );
  t(
    '★★★ 构建脚本清理逻辑保留 crash 目录（否则刚接进去就被删）',
    /e\.name === 'crash'/.test(read('tools/android/build-apk.cjs')),
  );
  t(
    '★★ JS 启动时读原生崩溃日志并上报（stage=native_crash）',
    /reportNativeCrash/.test(REPORTER_CODE) && /native_crash/.test(REPORTER_CODE) && /reportNativeCrash\(\)/.test(INDEX_CODE),
  );
}

console.log('');
console.log('=== 4b) ★★ 启动期内存缓解（largeHeap）===');
t(
  '★★ AndroidManifest 带 largeHeap（启动被 LMK 杀掉时更容易活下来）',
  /android:largeHeap="true"/.test(read('android/app/src/main/AndroidManifest.xml')),
  '低风险缓解；若日志证明不是内存问题可撤',
);

console.log('');
console.log('=== 5) ★★★ 服务器接收端 ===');
t('★★★ 有 /api/client-log 路由', /'\/api\/client-log'/.test(SERVER));
t('★★★ 在管理口令校验**之前**放行（崩溃时带不了凭据）', SERVER.indexOf("'/api/client-log'") < SERVER.indexOf('isProtected(p, req.method)'));
t('★★★ 不要求口令（不在 PROTECTED_PREFIXES 里）', !/PROTECTED_PREFIXES[\s\S]{0,400}'\/api\/client-log'/.test(SERVER));
t('★★ 写入文件（我们 SSH 能看）', /client-errors\.log/.test(SERVER));
t('★★ 字段做长度截断（防日志被撑爆）', /clean\(body\.stack, 4000\)/.test(SERVER));

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  为什么这条值得留着：闪退最难的是"没有现场"。');
console.log('  这套机制一旦被后人改坏（比如把 install 挪到 App 后面），');
console.log('  表现是"日志又没了"，且下一次闪退又要从零猜起。');
console.log('  ⚠️ 报 XX 就是实现确实不满足，不要改断言去迁就。');
console.log('  ══════════════════════════════════════════════');
console.log('');
console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
