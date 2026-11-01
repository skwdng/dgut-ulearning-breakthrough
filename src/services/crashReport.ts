/**
 * 客户端崩溃上报 —— 给"真机闪退"留证据。
 *
 * ══════════════ 为什么需要它（2026-10 用户反馈）══════════════
 *
 * 用户反馈：「lifekit 测试版，点进去马上退出来」——
 * 也就是**启动阶段闪退**。但：
 *   · 手机没连电脑 → `adb logcat` 抓不到
 *   · 本机没有模拟器 → 无法复现
 *   · App 崩在启动期 → 用户看不到任何界面，也没法从 App 里导出日志
 *
 * 所以在**入口文件 index.js 里第一时间**装上全局错误钩子：
 *   · JS 崩溃 → 把 message/stack/阶段 POST 到管理服务器 `/api/client-log`
 *   · 各启动阶段打点（entry / shell_mounted）→ 能判断"崩在哪一段"
 * 服务器把内容写进 `/opt/lifekit/client-errors.log`，
 * 我们 SSH 看文件就知道崩在哪一行，不用再猜。
 *
 * ⚠️ 上报必须**尽力而为**：崩溃时网络/服务器都可能是坏的，
 *    所以全部 try/catch + 超时，绝不允许上报本身再抛错。
 */
import { NativeModules } from 'react-native';
import { BUILD_CONFIG } from '../config/buildConfig';
import { getServerBase } from './serverClient';

/**
 * JS 引擎接手的时间点（本模块加载的第一行）。
 *
 * ⚠️ 它不是"进程创建时间"（JS 拿不到），但足以区分：
 *   · 从 entry 到 first_render 很久 → 卡在**模块加载 / Provider 初始化**
 *   · entry 之后就没消息了        → 连 JS 都没跑完（原生层被杀）
 * 服务器收到的时间戳 + 这个差值，就是我们判断"死在哪个阶段"的依据。
 */
export const BOOT_AT = Date.now();

/** 距 JS 接手的毫秒数（打点用） */
export function bootMs(): number {
  return Date.now() - BOOT_AT;
}

interface CrashPayload {
  stage: string;
  message: string;
  stack?: string;
  extra?: string;
}

/** 上报一条（失败静默） */
async function post(entry: CrashPayload): Promise<void> {
  try {
    const base = await getServerBase();
    if (!base) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      await fetch(`${base}/api/client-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          app: 'LifeKit',
          version: BUILD_CONFIG.version,
          versionCode: BUILD_CONFIG.versionCode,
          stage: entry.stage,
          message: entry.message,
          stack: entry.stack ?? '',
          extra: entry.extra ?? '',
        }),
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* 崩溃上报本身失败不能再抛 —— 否则掩盖真正的错误 */
  }
}

/** 启动阶段打点（用于判断崩在哪一段） */
export function reportStage(stage: string, extra?: string): void {
  void post({ stage, message: `stage:${stage}`, extra });
}

/**
 * 上报**原生层**崩溃日志（Java 未捕获异常）。
 *
 * 链路：
 *   MainApplication 装 Thread.setDefaultUncaughtExceptionHandler
 *     → 崩溃栈写进 filesDir/native-crash.log
 *     → 下次启动时本函数通过 NativeCrashLog 模块把文件读走
 *     → POST /api/client-log（stage=native_crash）
 *     → 服务器 /opt/lifekit/client-errors.log
 *
 * ⚠️ 为什么必须"下次启动"才能上报：崩溃那一刻进程已经在死了，
 *    来不及做网络请求，只能先落盘。
 */
export async function reportNativeCrash(): Promise<void> {
  try {
    const mod = (
      NativeModules as unknown as {
        NativeCrashLog?: { readAndClear?: () => Promise<string> };
      }
    ).NativeCrashLog;
    if (!mod?.readAndClear) return;
    const text = await mod.readAndClear();
    if (!text || !text.trim()) return;
    await post({
      stage: 'native_crash',
      message: text.slice(0, 1800),
      stack: text.slice(0, 4000),
    });
  } catch {
    /* 读不到原生日志就算了，不能影响启动 */
  }
}

let installed = false;

/**
 * 安装全局 JS 错误钩子。
 *
 * ⚠️ 必须在 **App 被 require 之前**调用（见 index.js），
 *    否则 App 依赖链里某个模块 import 就崩的情况抓不到。
 */
export function installCrashReporter(): void {
  if (installed) return;
  installed = true;

  try {
    const EU = (globalThis as unknown as { ErrorUtils?: {
      getGlobalHandler?: () => (e: unknown, isFatal?: boolean) => void;
      setGlobalHandler?: (h: (e: unknown, isFatal?: boolean) => void) => void;
    } }).ErrorUtils;
    if (!EU || typeof EU.setGlobalHandler !== 'function') return;

    const prev = typeof EU.getGlobalHandler === 'function' ? EU.getGlobalHandler() : null;

    EU.setGlobalHandler((error: unknown, isFatal?: boolean) => {
      try {
        const e = error as { message?: string; stack?: string };
        const message = String(e?.message ?? error ?? '未知错误').slice(0, 2000);
        const stack = String(e?.stack ?? '').slice(0, 4000);
        void post({ stage: isFatal ? 'fatal' : 'error', message, stack });
      } catch {
        /* 忽略 */
      }
      /** 交还给 RN 默认处理（release 下会结束进程，这正是"闪退"） */
      try {
        if (prev && prev !== EU.getGlobalHandler) prev(error, isFatal);
      } catch {
        /* 忽略 */
      }
    });
  } catch {
    /* 拿不到 ErrorUtils 就算了，不能因此起不来 */
  }
}
