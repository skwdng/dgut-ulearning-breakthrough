/**
 * 全局崩溃日志。
 *
 * 为什么需要：
 * release 版里未捕获的异常只会让界面白掉，用户既看不到原因也反馈不了。
 * 这里把错误写进本地文件，用户可以在「我的 → 崩溃日志」里读出来发给开发者。
 *
 * 覆盖三种情况：
 *   1. 同步异常（ErrorUtils 全局兜底）
 *   2. Promise 未处理的 rejection
 *   3. 渲染期异常（配合 ErrorBoundary）
 */
import { store, STORE_KEYS } from '../services/storage';

export interface CrashRecord {
  at: number;
  kind: 'sync' | 'promise' | 'render';
  message: string;
  stack?: string;
  /** 出错的页面（如果拿得到） */
  context?: string;
}

const MAX_RECORDS = 30;

let installed = false;

/**
 * 同一条消息在这个时间窗内连续重复 → 只记第一条。
 *
 * ══════════════ ★ 为什么必须去重 ══════════════
 *
 * 实测（用户发来的日志）：30 条记录里**全是同一条正常操作**，
 * 一条崩溃都没有 —— 因为 WebView 天然会把同一条消息发好几次，
 * 调用方又每次都记，于是真崩溃被挤出了 30 条的窗口。
 *
 * 日志的价值在于"能看见真问题"，被噪音塞满就等于没有日志。
 *
 * ⚠️ 只压**连续的**同一条，且带时间窗 ——
 *    隔一段时间真的重复出错（"这个问题一直在复发"）仍会留下多条痕迹，
 *    不会因为去重而丢掉复发信息。
 */
const DEDUPE_WINDOW_MS = 5 * 60_000;
let lastMessage: string | null = null;
let lastAt = 0;

async function append(rec: CrashRecord) {
  try {
    /** 去重判断放在读写之前 —— 省掉一次无用的存储操作 */
    const isRepeat =
      lastMessage === rec.message && Math.abs(rec.at - lastAt) < DEDUPE_WINDOW_MS;
    lastMessage = rec.message;
    lastAt = rec.at;
    if (isRepeat) return;

    const list = await store.get<CrashRecord[]>(STORE_KEYS.crashLog, []);
    list.unshift(rec);
    await store.set(STORE_KEYS.crashLog, list.slice(0, MAX_RECORDS));
  } catch {
    /* 日志写入失败也不能再抛 */
  }
}

export async function readCrashes(): Promise<CrashRecord[]> {
  try {
    return (await store.get<CrashRecord[]>(STORE_KEYS.crashLog, [])) ?? [];
  } catch {
    return [];
  }
}

export async function clearCrashes(): Promise<void> {
  await store.remove(STORE_KEYS.crashLog);
}

/**
 * 安装全局兜底。在根布局最早处调用一次。
 * 幂等：重复调用不会重复挂钩子。
 */
export function installCrashLogger(context = 'app') {
  if (installed) return;
  installed = true;

  // 1) React Native 的全局异常钩子（可拿到 fatal / non-fatal）
  try {
    const g = globalThis as unknown as {
      ErrorUtils?: {
        getGlobalHandler?: () => (e: unknown, isFatal?: boolean) => void;
        setGlobalHandler?: (h: (e: unknown, isFatal?: boolean) => void) => void;
      };
    };
    const EU = g.ErrorUtils;
    if (EU?.getGlobalHandler && EU?.setGlobalHandler) {
      const prev = EU.getGlobalHandler();
      EU.setGlobalHandler((e: unknown, isFatal?: boolean) => {
        const err = e as Error;
        void append({
          at: Date.now(),
          kind: 'sync',
          message: `${isFatal ? '[FATAL] ' : ''}${err?.name ?? 'Error'}: ${err?.message ?? String(e)}`,
          stack: err?.stack,
          context,
        });
        // 仍然调用原处理器，保持默认行为（红屏/退出）
        prev(e, isFatal);
      });
    }
  } catch {
    /* 环境不支持就算了 */
  }

  // 2) 未处理的 Promise rejection
  try {
    const g = globalThis as unknown as {
      addEventListener?: (t: string, h: (ev: unknown) => void) => void;
    };
    g.addEventListener?.('unhandledrejection', (ev: unknown) => {
      const e = ev as { reason?: unknown };
      const r = e?.reason;
      const err = r as Error;
      void append({
        at: Date.now(),
        kind: 'promise',
        message: err?.message ? `${err.name ?? 'Error'}: ${err.message}` : String(r),
        stack: err?.stack,
        context,
      });
    });
  } catch {
    /* ignore */
  }
}

/** 供 ErrorBoundary 调用 */
export function logRenderError(error: Error, componentStack?: string | null) {
  void append({
    at: Date.now(),
    kind: 'render',
    message: `${error.name}: ${error.message}`,
    stack: `${error.stack ?? ''}\n--- component stack ---\n${componentStack ?? ''}`,
  });
}

/**
 * 主动记一条故障（不一定是异常）。
 *
 * 用途：像"凭据读不到"这种**在用户手机上才复现**的问题，
 * 与其来回问，不如就地记下来 —— 用户到「设置 → 崩溃日志」截一张图就够了。
 */
export function logFault(message: string, context?: string) {
  void append({ at: Date.now(), kind: 'promise', message, context });
}

/** 让人读得懂的格式化 */
export function formatCrash(rec: CrashRecord): string {
  const d = new Date(rec.at);
  const p = (n: number) => String(n).padStart(2, '0');
  const time = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `[${time}] (${rec.kind}) ${rec.message}${rec.context ? ` @${rec.context}` : ''}`;
}
