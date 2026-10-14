/**
 * 上报队列 —— 解决"服务器没开时上报丢失"。
 *
 * ══════════════ 为什么需要它 ══════════════
 * 管理员的需求原话：
 *   「我要做的不是实时去管理，而是需要的时候去刷新一下」
 *
 * 也就是说**服务器的开关是随意的** —— 管理员电脑可能几天没开。
 * 而原先 `reportUser` 是"发一次就算了"：
 *
 *   const r = await fetchJson(base, '/api/register', ...);
 *   return r.ok ? { ok: true } : { ok: false, error: r.error };
 *   //                                        ↑ 失败就永久丢掉了
 *
 * 结果：在那段时间登录过的人，管理页上**永远看不到**。
 *
 * ══════════════ 现在的做法 ══════════════
 * 「先落地，再上报」：
 *   ① 每次上报**先写进本地队列**（同步、必成功）
 *   ② 再尝试发送；成功才把这条从队列里删掉
 *   ③ App 启动时 / 手动重试时，把队列里积压的全部补发
 *
 * 这样无论服务器什么时候开，数据最终都会到 —— 只是晚一点。
 *
 * ⚠️ 队列按学号去重：同一个人反复登录只保留**最新**的一条，
 *    否则离线久了会攒出几百条同一个人的记录。
 */
import { store, STORE_KEYS } from './storage';
import { fetchUserAuth, grantPersonalCode, reportUser } from './serverClient';

/** 待补发的一条上报 */
export interface PendingReport {
  studentId: string;
  studentName?: string;
  school?: string;
  tenant?: string;
  /** 第一次尝试上报的时间 */
  firstAt: number;
  /** 最近一次尝试的时间 */
  lastTryAt: number;
  /** 试过几次（用于界面提示"试了 N 次"） */
  tries: number;
}

const KEY = STORE_KEYS.pendingReports;

/** 读队列（容错：坏数据当作空） */
export async function loadPending(): Promise<PendingReport[]> {
  try {
    const v = await store.get<PendingReport[] | null>(KEY, null);
    if (!Array.isArray(v)) return [];
    return v.filter((x) => x && typeof x.studentId === 'string' && x.studentId);
  } catch {
    return [];
  }
}

async function savePending(list: PendingReport[]): Promise<void> {
  try {
    await store.set(KEY, list);
  } catch {
    /* 存不下就算了，不能因为队列把主流程搞挂 */
  }
}

/**
 * 记一条待上报（按学号去重，保留最新的姓名等信息）。
 * ⚠️ 这一步**必须先做**，再做网络请求 —— 顺序反了就等于没兜底。
 */
export async function enqueueReport(info: {
  studentId: string;
  studentName?: string;
  school?: string;
  tenant?: string;
}): Promise<void> {
  if (!info.studentId) return;
  const list = await loadPending();
  const now = Date.now();
  const i = list.findIndex((x) => x.studentId === info.studentId);
  if (i >= 0) {
    const prev = list[i];
    list[i] = {
      ...prev,
      // 姓名等以最新的为准（用户后来补填了姓名）
      studentName: info.studentName || prev.studentName,
      school: info.school || prev.school,
      tenant: info.tenant || prev.tenant,
      lastTryAt: now,
    };
  } else {
    list.push({
      studentId: info.studentId,
      studentName: info.studentName,
      school: info.school,
      tenant: info.tenant,
      firstAt: now,
      lastTryAt: now,
      tries: 0,
    });
  }
  await savePending(list);
}

/** 上报成功 → 从队列移除 */
async function dequeue(studentId: string): Promise<void> {
  const list = await loadPending();
  const next = list.filter((x) => x.studentId !== studentId);
  if (next.length !== list.length) await savePending(next);
}

/** 上报失败 → 只累加计数，不删除 */
async function bumpTries(studentId: string): Promise<void> {
  const list = await loadPending();
  const i = list.findIndex((x) => x.studentId === studentId);
  if (i < 0) return;
  list[i] = { ...list[i], tries: list[i].tries + 1, lastTryAt: Date.now() };
  await savePending(list);
}

/**
 * ★ 主入口：登录后调用。
 *
 * 先入队 → 再尝试发 → 成功就出队。失败**不抛错**
 *（上报只是给管理员看，绝不能影响登录本身）。
 */
export async function reportUserQueued(
  base: string,
  info: { studentId: string; studentName?: string; school?: string; tenant?: string },
): Promise<{ ok: boolean; queued: boolean; error?: string }> {
  if (!info.studentId) return { ok: false, queued: false, error: '缺少学号' };
  // ① 先落地（这一步必须成功，否则离线期间就真丢了）
  await enqueueReport(info);
  // ② 没配服务器 → 就留在队列里等
  if (!base) return { ok: false, queued: true, error: '没有配置服务器地址' };
  // ③ 尝试发送
  try {
    const r = await reportUser(base, info);
    if (r.ok) {
      await dequeue(info.studentId);
      return { ok: true, queued: false };
    }
    await bumpTries(info.studentId);
    return { ok: false, queued: true, error: r.error };
  } catch (e) {
    await bumpTries(info.studentId);
    return { ok: false, queued: true, error: (e as Error).message };
  }
}

/**
 * ★ 补发队列里积压的上报。
 *
 * 什么时候调：
 *   · App 启动时（管理员说过"需要的时候刷新一下"，启动就该尝试）
 *   · 用户在设置里点了「重试」
 *
 * 返回补发结果，供界面显示。
 */
export async function flushPendingReports(base: string): Promise<{
  total: number;
  sent: number;
  failed: number;
  /** 还有多少条没发出去 */
  remaining: number;
}> {
  const list = await loadPending();
  if (!list.length) return { total: 0, sent: 0, failed: 0, remaining: 0 };
  if (!base) return { total: list.length, sent: 0, failed: list.length, remaining: list.length };

  let sent = 0;
  let failed = 0;
  for (const item of list) {
    try {
      const r = await reportUser(base, {
        studentId: item.studentId,
        studentName: item.studentName,
        school: item.school,
        tenant: item.tenant,
      });
      if (r.ok) {
        await dequeue(item.studentId);
        sent += 1;
      } else {
        await bumpTries(item.studentId);
        failed += 1;
      }
    } catch {
      await bumpTries(item.studentId);
      failed += 1;
    }
  }
  const remaining = (await loadPending()).length;
  return { total: list.length, sent, failed, remaining };
}

/** 队列里有多少条没发出去（给设置页显示） */
export async function pendingCount(): Promise<number> {
  return (await loadPending()).length;
}

/** 清空队列（用户主动放弃时用） */
export async function clearPending(): Promise<void> {
  await savePending([]);
}

// 这几个是给别的模块复用的透传，避免各处重复 import
export { fetchUserAuth, grantPersonalCode };
