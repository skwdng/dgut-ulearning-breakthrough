// 应用入口。
//
// 不用 expo-router/entry —— 理由见 App.tsx 顶部注释
// （鸿蒙上原生导航会让界面白屏）。
import { registerRootComponent } from 'expo';
import {
  installCrashReporter,
  reportStage,
  reportNativeCrash,
  bootMs,
} from './src/services/crashReport';

/**
 * ══════════════ ★ 先装崩溃钩子，再加载 App（2026-10）══════════════
 *
 * 为什么顺序这么重要：
 *   `App.tsx` 会 import 所有页面（screens.tsx 注册表是静态 import），
 *   而这些模块**在 import 阶段就会执行模块顶层代码**。
 *   如果某个模块顶层就抛错，App 根本到不了"能渲染 ErrorBoundary"那一步 ——
 *   表现就是用户看到的"点进去马上退出来"（真机闪退）。
 *
 * 所以这里：
 *   ① 先 `installCrashReporter()`：装全局 ErrorUtils 钩子，崩溃时把 message/stack 回传服务器
 *   ② 打点 `entry`：让我们知道 JS 到底有没有跑起来
 *   ③ 上报上一次的**原生层**崩溃日志（Java 未捕获异常写盘的那份）
 *   ④ 再用 **require** 加载 App —— 不能用 import：
 *      ESM import 会被提升到文件顶部，全部先于 installCrashReporter 执行，钩子就晚了一步。
 */
installCrashReporter();
reportStage('entry', `boot=${bootMs()}ms`);

/**
 * ★ 原生崩溃日志上报（2026-10）
 *
 * 用户真机（华为 Mate 70 Pro / HarmonyOS）「点进去马上退出来」，
 * 服务器只收到 entry、没有 shell_mounted、没有任何 JS 错误 →
 * 崩在原生层。Java 层的崩溃栈由 MainApplication 写进
 * filesDir/native-crash.log，这里启动时把它读走并上报。
 * 详见 services/crashReport.ts 的 reportNativeCrash()。
 */
void reportNativeCrash();

const App = require('./App').default;

registerRootComponent(App);
