/**
 * 启动计时 —— 用来定位"更新后进去会卡一阵子"。
 *
 * ══════════════ 用户实测的现象 ══════════════
 *
 * 「每次更新完再进去都会闪退，要隔一阵子才能进入」
 *
 * 注意这句话的含义：**不是真的崩了**，而是**进去之后卡住、要等**。
 * （真崩的话是应用直接退出，而不是"隔一阵子能进"。）
 *
 * 但到底是卡在哪一步？—— 光看代码猜不出来，因为启动时有一堆事：
 *   · 7 层 Provider 依次 hydrate 本地存储
 *   · 读出账号 / 凭据 / 课程缓存 / 授权码 / 更新记录…
 *   · 若干网络请求（授权码校验、服务器授权状态）
 *
 * ══════════════ 这个模块干什么 ══════════════
 *
 * 打点记时间，并在**超过阈值**时写进崩溃日志。这样下次用户说"卡"，
 * 日志里会直接写着"哪一段花了多少毫秒" —— 不用再猜。
 *
 * ⚠️ 只在超过阈值时记日志：否则每次启动都写一条，会把
 *    崩溃日志的 30 条窗口占满（那个坑踩过 —— 正常操作把真崩溃挤出去了）。
 *
 * ⚠️ 阈值取多少：冷启动本身在低端机上就可能几百毫秒。
 *    取 1500ms 起步 —— 明显不正常才记。
 *
 * 用法：
 *   markStart();                       // 在最早处调一次
 *   mark('providers-mounted');         // 各阶段打点
 *   await timeIt('read-account', fn);  // 或者包住一段异步
 */
import { logFault } from './crashLog';

/** 启动原点（模块加载时刻） */
let originAt: number | null = null;
/** 上一个打点时刻，用于算"这一段的耗时" */
let lastAt: number | null = null;
/** 已记录的点，避免重复打点造成噪音 */
const marks = new Set<string>();

/** 超过这个毫秒数才写日志（避免噪音把真崩溃挤出 30 条窗口） */
const SLOW_MS = 1500;

/**
 * 启动计时开始。越早调越好。
 *
 * ⚠️ 必须在 `installCrashLogger` 之后调 —— 否则日志写不进去。
 */
export function markStart(): void {
  if (originAt !== null) return;
  originAt = Date.now();
  lastAt = originAt;
}

/**
 * 打一个点，记录"从上一个点到现在"和"从启动到现在"的耗时。
 *
 * @param name 阶段名（会出现在日志里，写短一点）
 */
export function mark(name: string): void {
  if (originAt === null) return;
  if (marks.has(name)) return;
  marks.add(name);

  const now = Date.now();
  const sinceLast = lastAt === null ? 0 : now - lastAt;
  const sinceStart = now - originAt;
  lastAt = now;

  /**
   * ⚠️ 只有**这一段**慢才记，不是总耗时慢才记。
   *    否则一旦启动总时长超了，后面每个点都会记一遍。
   */
  if (sinceLast >= SLOW_MS) {
    logFault(
      `[启动慢] ${name} 花了 ${sinceLast}ms（启动至今 ${sinceStart}ms）`,
      'startup',
    );
  }
}

/**
 * 包住一段异步逻辑并计时。
 *
 * 返回原函数的返回值，**异常照常抛出**（不吞）。
 */
export async function timeIt<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const cost = Date.now() - t0;
    if (cost >= SLOW_MS) {
      logFault(`[启动慢] ${name} 花了 ${cost}ms`, 'startup');
    }
  }
}

/**
 * 启动完成 —— 记一条总耗时（只有真的很久才记）。
 */
export function markReady(): void {
  if (originAt === null) return;
  const total = Date.now() - originAt;
  if (total >= SLOW_MS * 2) {
    logFault(`[启动慢] 启动总耗时 ${total}ms（阈值 ${SLOW_MS * 2}ms）`, 'startup');
  }
  mark('ready');
}
