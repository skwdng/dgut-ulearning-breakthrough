/**
 * 「上次启动没走完」探测 —— 用来抓**原生层**的闪退。
 *
 * ══════════════ 为什么需要它 ══════════════
 *
 * 用户反馈：「早上用的时候点击软件会闪退几次」。
 *
 * 而现有的崩溃日志（services/crashLog.ts）只能抓到 **JS 层的异常**：
 *   · `ErrorUtils.setGlobalHandler` 捕 JS 报错
 *   · `console.error` 重定向
 *
 * ⚠️ 但有一类闪退**根本走不到 JS 层**：
 *
 *   ```
 *   Android 的 ANR（Application Not Responding）：
 *     启动时 JS 线程被长时间阻塞 → 系统直接杀掉进程
 *     → 没有 JS 异常 → 崩溃日志里**一条都没有**
 *     → 用户看到的就是"点几次才进去"
 *   ```
 *
 * 用户描述的现象（"闪退几次，隔一阵子才能进"）**恰好符合 ANR 的特征**：
 * 冷启动时阻塞被杀，重试时进程已热、负载轻，就进去了。
 *
 * ══════════════ 这个模块怎么工作 ══════════════
 *
 *   ① App 启动最早期 → `beginStartup()` 记下"正在启动"
 *   ② 首屏渲染完成后 → `completeStartup()` 清掉标记
 *   ③ 下次启动时若发现标记**还在** → 说明上次**没走完**就被杀了
 *
 * 这样即使 JS 层没抓到任何异常，也能知道"上次启动异常结束"，
 * 并且能统计**连续几次**（连续多次 = 稳定复现的问题，不是偶发）。
 *
 * ⚠️ 只记"有没有走完"，不记用户数据，不涉及隐私。
 */
import { store, STORE_KEYS } from './storage';

/** 存在存储里的标记 */
interface StartupMark {
  /** 本次启动开始的时间戳 */
  at: number;
  /** 应用版本，便于判断是不是某个版本引入的 */
  version?: string;
  /**
   * 连续多少次启动没走完。
   * ⚠️ 这个数字最有用：连续 3 次以上说明是稳定问题，而不是偶发。
   */
  streak: number;
}

/**
 * 读上次的标记（**不修改**）—— 供 UI 展示用。
 */
export async function readStartupMark(): Promise<StartupMark | null> {
  try {
    return await store.get<StartupMark | null>(STORE_KEYS.startupMark, null);
  } catch {
    return null;
  }
}

/**
 * ① 启动最早期调用：检查上次有没有走完，并写下本次的标记。
 *
 * @returns 上次未完成的信息（null = 上次正常结束 或 首次启动）
 */
export async function beginStartup(version?: string): Promise<StartupMark | null> {
  let prev: StartupMark | null = null;
  try {
    prev = await store.get<StartupMark | null>(STORE_KEYS.startupMark, null);
  } catch {
    prev = null;
  }

  /** 上次的标记还在 → 上次没走到 completeStartup */
  const unfinished = prev && typeof prev.at === 'number' ? prev : null;

  try {
    await store.set(STORE_KEYS.startupMark, {
      at: Date.now(),
      version,
      /** 连续计数：上次没走完就 +1，走完了就归 1（表示"本次开始"） */
      streak: unfinished ? (prev?.streak ?? 1) + 1 : 1,
    } satisfies StartupMark);
  } catch {
    /* 写不进去也不该影响启动 */
  }

  return unfinished;
}

/**
 * ② 首屏渲染完成后调用：清掉标记（表示这次走完了）。
 */
export async function completeStartup(): Promise<void> {
  try {
    await store.remove(STORE_KEYS.startupMark);
  } catch {
    /* 清不掉也没关系，下次会误报一次"没走完"，不影响功能 */
  }
}
