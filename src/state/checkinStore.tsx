/**
 * 签到模块的全局状态（React Context + reducer）。
 *
 * 职责边界：
 * - 这里只做"状态与编排"：轮询循环、提交、重试、熔断、记录；
 * - 网络细节全在 adapter 里；
 * - 页面只读状态 + 调 action，不直接碰 adapter。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  DEFAULT_POLL_PLAN,
  type CheckinError,
  type CheckinStats,
  type Course,
  type PollPlan,
  type PollTier,
  type RollcallTask,
  type SessionState,
  type SignType,
  type YouxueAccount,
  AUTO_SIGN_TYPES,
} from '../domain/types';
import { getAdapter, getMockAdapter } from '../services/checkin';
import type { NeedMfaSignal } from '../services/checkin/types';
import { backoffMs, CIRCUIT_BREAK_MS, CIRCUIT_THRESHOLD, RATE_LIMIT_BACKOFF_MS } from '../services/checkin/errors';
import { decideTier, submitDelay } from '../services/checkin/scheduler';
import { store, STORE_KEYS } from '../services/storage';
/** ★ 启动计时打点 —— 用于定位"更新后进去要等一阵" */
import { mark } from '../services/startupTiming';

export interface CheckinState {
  ready: boolean;
  account: YouxueAccount | null;
  courses: Course[];
  tasks: RollcallTask[];
  history: RollcallTask[];
  stats: CheckinStats;
  autoEnabled: boolean;
  sessionState: SessionState;
  plan: PollPlan;
  tier: PollTier;
  tierReason: string;
  nextPollInMs: number;
  polling: boolean;
  lastError: CheckinError | null;
  /** 待人工介入的任务（UI 用横幅提示） */
  manualTask: RollcallTask | null;
  /** 风控熔断到期时间 */
  cooldownUntil: number;
  consecutiveRateLimits: number;
  todaySubmitCount: number;
  needMfa: (NeedMfaSignal & { studentId: string }) | null;
  log: Array<{ at: number; level: 'info' | 'warn' | 'error'; text: string }>;
}

const initialState: CheckinState = {
  ready: false,
  account: null,
  courses: [],
  tasks: [],
  history: [],
  stats: { todayDone: 0, todayTotal: 0, successRate: 0, streakDays: 0 },
  autoEnabled: false,
  sessionState: 'unknown',
  plan: DEFAULT_POLL_PLAN,
  tier: 'cold',
  tierReason: '尚未开始监控',
  nextPollInMs: 0,
  polling: false,
  lastError: null,
  manualTask: null,
  cooldownUntil: 0,
  consecutiveRateLimits: 0,
  todaySubmitCount: 0,
  needMfa: null,
  log: [],
};

type Action =
  | { type: 'HYDRATE'; payload: Partial<CheckinState> }
  | { type: 'SET_ACCOUNT'; account: YouxueAccount | null }
  | { type: 'SET_COURSES'; courses: Course[] }
  | { type: 'PATCH_COURSE'; courseId: string; patch: Partial<Course> }
  | { type: 'UPSERT_TASKS'; tasks: RollcallTask[] }
  | { type: 'SET_TASKS'; tasks: RollcallTask[] }
  | { type: 'PATCH_TASK'; id: string; patch: Partial<RollcallTask> }
  | { type: 'SET_HISTORY'; history: RollcallTask[] }
  | { type: 'SET_STATS'; stats: CheckinStats }
  | { type: 'SET_AUTO'; enabled: boolean }
  | { type: 'SET_SESSION'; state: SessionState }
  | { type: 'SET_PLAN'; plan: PollPlan }
  | { type: 'SET_TIER'; tier: PollTier; reason: string; nextPollInMs: number }
  | { type: 'SET_POLLING'; polling: boolean }
  | { type: 'SET_ERROR'; error: CheckinError | null }
  | { type: 'SET_MANUAL'; task: RollcallTask | null }
  | { type: 'RATE_LIMIT_HIT' }
  | { type: 'RESET_COOLDOWN' }
  | { type: 'SET_MFA'; payload: (NeedMfaSignal & { studentId: string }) | null }
  | { type: 'LOG'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'CLEAR_LOG' };

function reducer(state: CheckinState, action: Action): CheckinState {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, ...action.payload, ready: true };
    /**
     * 设置当前账号。
     *
     * ══════════ 身份变化守卫（踩过的坑）══════════
     * 换账号时**必须把属于上一个账号的数据一起清掉**，否则界面会继续显示旧数据：
     * 登录别人的账号后，签到列表、课程、任务还是自己的。
     *
     * 这里做守卫而不是只在 unbind 里清，是因为换账号有不止一条路径：
     *   · 手动「解除绑定」后再登录      → unbind 已经清了
     *   · 直接用另一个学号登录（本次踩的）→ **没人清**
     * 放在 reducer 里，所有路径都会被覆盖。
     *
     * 判据用 account.id（形如 `dgut-2099000000116`），它唯一标识一个账号。
     */
    case 'SET_ACCOUNT': {
      const prevId = state.account?.id ?? null;
      const nextId = action.account?.id ?? null;
      if (prevId === nextId) return { ...state, account: action.account };

      const changed = prevId !== nextId;
      return {
        ...state,
        account: action.account,
        // 换了人 → 这些都属于上一个人，全部清空
        courses: changed ? [] : state.courses,
        tasks: changed ? [] : state.tasks,
        history: changed ? [] : state.history,
        stats: changed ? { todayDone: 0, todayTotal: 0, successRate: 0, streakDays: 0 } : state.stats,
        manualTask: changed ? null : state.manualTask,
        // 自动轮询的冷却也跟着重置，免得新账号一进来就被上一个人的限流挡着
        cooldownUntil: changed ? 0 : state.cooldownUntil,
        consecutiveRateLimits: changed ? 0 : state.consecutiveRateLimits,
        lastError: changed ? null : state.lastError,
        log: changed
          ? pushLog(state.log, 'info', `已切换到账号 ${nextId ?? '(未绑定)'}，已清空上一个账号的缓存数据`)
          : state.log,
      };
    }
    case 'SET_COURSES':
      return { ...state, courses: action.courses };
    case 'PATCH_COURSE':
      return {
        ...state,
        courses: state.courses.map((c) => (c.id === action.courseId ? { ...c, ...action.patch } : c)),
      };
    case 'UPSERT_TASKS': {
      const map = new Map(state.tasks.map((t) => [t.id, t]));
      for (const t of action.tasks) map.set(t.id, { ...map.get(t.id), ...t });
      return { ...state, tasks: Array.from(map.values()).slice(-50) };
    }
    case 'SET_TASKS':
      return { ...state, tasks: action.tasks };
    case 'PATCH_TASK':
      return { ...state, tasks: state.tasks.map((t) => (t.id === action.id ? { ...t, ...action.patch } : t)) };
    case 'SET_HISTORY':
      return { ...state, history: action.history };
    case 'SET_STATS':
      return { ...state, stats: action.stats };
    case 'SET_AUTO':
      return { ...state, autoEnabled: action.enabled };
    case 'SET_SESSION':
      return { ...state, sessionState: action.state };
    case 'SET_PLAN':
      return { ...state, plan: action.plan };
    case 'SET_TIER':
      return { ...state, tier: action.tier, tierReason: action.reason, nextPollInMs: action.nextPollInMs };
    case 'SET_POLLING':
      return { ...state, polling: action.polling };
    case 'SET_ERROR':
      return { ...state, lastError: action.error };
    case 'SET_MANUAL':
      return { ...state, manualTask: action.task };
    case 'RATE_LIMIT_HIT': {
      const n = state.consecutiveRateLimits + 1;
      const cooldown = n >= CIRCUIT_THRESHOLD ? CIRCUIT_BREAK_MS : RATE_LIMIT_BACKOFF_MS;
      return {
        ...state,
        consecutiveRateLimits: n,
        cooldownUntil: Date.now() + cooldown,
        log: pushLog(state.log, 'warn', `命中限流第 ${n} 次，退避 ${Math.round(cooldown / 60000)} 分钟`),
      };
    }
    case 'RESET_COOLDOWN':
      return { ...state, cooldownUntil: 0, consecutiveRateLimits: 0 };
    case 'SET_MFA':
      return { ...state, needMfa: action.payload };
    case 'LOG':
      return { ...state, log: pushLog(state.log, action.level, action.text) };
    case 'CLEAR_LOG':
      return { ...state, log: [] };
    default:
      return state;
  }
}

function pushLog(
  log: CheckinState['log'],
  level: 'info' | 'warn' | 'error',
  text: string,
): CheckinState['log'] {
  const next = [...log, { at: Date.now(), level, text }];
  return next.length > 300 ? next.slice(-300) : next;
}

// ---------------- Context ----------------

export interface CheckinActions {
  bindWithPassword(studentId: string, password: string, studentName?: string): Promise<{ ok: boolean; error?: CheckinError }>;
  /**
   * 用已拿到的会话 cookie 绑定账号。
   * 返回 userId 是为了让界面能把"服务端认到的身份"显示出来 ——
   * 换账号串数据那次就是看不到这个值才排查了很久。
   */
  bindWithSession(
    studentId: string,
    cookies: Record<string, string>,
  ): Promise<{ ok: boolean; error?: CheckinError; userId?: number }>;
  submitMfaCode(code: string): Promise<{ ok: boolean; error?: CheckinError }>;
  unbind(): Promise<void>;
  refreshCourses(): Promise<void>;
  refreshHistory(): Promise<void>;
  toggleAuto(enabled: boolean): Promise<void>;
  toggleCourse(courseId: string, enabled: boolean): Promise<void>;
  /**
   * ★ 设置 / 清除一门课的签到位置（地围栏圈）。
   *
   * 传 `null` 清除。设置后，这门课的位置签到会用**圈内随机取点**提交，
   * 而不是手机真实 GPS（见 utils/geo.ts 的 pickInsideWithJitter）。
   */
  setCourseLocation(
    courseId: string,
    location: { latitude: number; longitude: number; radius?: number; address?: string } | null,
  ): Promise<void>;
  updatePlan(patch: Partial<PollPlan>): Promise<void>;
  /** 立刻检测一次（手动） */
  detectNow(): Promise<void>;
  /** 手动提交（数字码/二维码/坐标） */
  submitManual(input: {
    task: RollcallTask;
    signCode?: string;
    qrPayload?: string;
    location?: { latitude: number; longitude: number; accuracy?: number };
  }): Promise<{ ok: boolean; error?: CheckinError }>;
  /**
   * 扫到二维码后直接提交：自动挑选最相关的待签到任务。
   * 返回实际提交的课程名，便于 UI 回显；没有可提交任务时返回 needsTask=true。
   */
  submitQrScan(payload: string): Promise<{
    ok: boolean;
    needsTask?: boolean;
    courseName?: string;
    error?: CheckinError;
  }>;
  /** 演示：制造一个签到窗口（仅 mock 适配器） */
  devTrigger(signType?: SignType): void;
  dismissManual(): void;
  clearCooldown(): void;
  clearLog(): void;
}

const CheckinContext = createContext<(CheckinState & { actions: CheckinActions }) | null>(null);

export function CheckinProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const submittingRef = useRef(false);

  // ---------- 持久化读取 ----------
  // 账号相关的数据（课程/任务/历史）按账号分 key —— 见下面持久化写入的注释
  useEffect(() => {
    (async () => {
      const [account, plan, settings] = await Promise.all([
        store.get<YouxueAccount | null>(STORE_KEYS.account, null),
        store.get<PollPlan>(STORE_KEYS.pollPlan, DEFAULT_POLL_PLAN),
        store.get<{ autoEnabled: boolean }>(STORE_KEYS.settings, { autoEnabled: false }),
      ]);
      /** ★ 启动计时：账号与设置读完了 */
      mark('checkin-hydrate-account');

      // 账号相关数据按 account.id 分开存，避免换账号后串数据
      const suffix = account?.id ? `.${account.id}` : '';
      const [courses, tasks, history] = account?.id
        ? await Promise.all([
            store.get<Course[]>(`${STORE_KEYS.courses}${suffix}`, []),
            store.get<RollcallTask[]>(`${STORE_KEYS.tasks}${suffix}`, []),
            store.get<RollcallTask[]>(`${STORE_KEYS.history}${suffix}`, []),
          ])
        : [[], [], []];

      dispatch({
        type: 'HYDRATE',
        payload: {
          account,
          courses,
          tasks,
          history,
          plan,
          autoEnabled: settings.autoEnabled,
          sessionState: account ? account.sessionState : 'unknown',
        },
      });
    })();
  }, []);

  // ---------- 持久化写入 ----------
  /**
   * ⚠️ 课程/任务/历史**按账号分 key**。
   *
   * 原先用全局 key，导致换账号后：
   *   · 读到的还是上一个账号的课程与任务
   *   · 新账号一进来就用空数组把上一个账号的缓存覆盖掉（切回去也没了）
   * 现在带 account.id，两边都不受影响。
   */
  useEffect(() => {
    if (!state.ready) return;
    store.set(STORE_KEYS.account, state.account);
    store.set(STORE_KEYS.pollPlan, state.plan);
    store.set(STORE_KEYS.settings, { autoEnabled: state.autoEnabled });

    const id = state.account?.id;
    if (!id) return; // 没账号 → 不覆盖任何账号的数据
    store.set(`${STORE_KEYS.courses}.${id}`, state.courses);
    store.set(`${STORE_KEYS.tasks}.${id}`, state.tasks);
    store.set(`${STORE_KEYS.history}.${id}`, state.history);
  }, [state.ready, state.account, state.courses, state.tasks, state.history, state.plan, state.autoEnabled]);

  // ---------- 提交一个任务 ----------
  const doSubmit = useCallback(
    async (
      task: RollcallTask,
      extra?: {
        signCode?: string;
        qrPayload?: string;
        manual?: boolean;
        location?: { latitude: number; longitude: number; accuracy?: number };
      },
    ) => {
      const s = stateRef.current;
      const account = s.account;
      if (!account) return { ok: false, error: { code: 'E_SESSION_EXPIRED', message: '未绑定', retryable: false } as CheckinError };
      if (submittingRef.current) {
        dispatch({ type: 'LOG', level: 'warn', text: `跳过重复提交（并发上限 1）：${task.courseName}` });
        return { ok: false };
      }

      // 单日提交上限（tech-spec §6.2）
      if (!extra?.manual && s.todaySubmitCount >= s.plan.dailySubmitCap) {
        dispatch({ type: 'LOG', level: 'warn', text: `已达单日提交上限 ${s.plan.dailySubmitCap}，仅保留轮询` });
        return { ok: false };
      }

      submittingRef.current = true;
      dispatch({ type: 'PATCH_TASK', id: task.id, patch: { state: 'submitting', attempts: task.attempts + 1 } });
      dispatch({ type: 'LOG', level: 'info', text: `提交签到：${task.courseName}（${task.signType}）` });

      // 随机延迟：不要检测到 0 秒内提交
      const wait = extra?.manual ? 0 : submitDelay(s.plan);
      if (wait > 0) await sleep(wait);

      try {
        const adapter = getAdapter();
        const location =
          extra?.location ??
          (task.signType === 'location' ? courseLocation(s.courses, task.courseId) : undefined);
        const res = await adapter.submit(account, {
          task,
          signCode: extra?.signCode,
          qrPayload: extra?.qrPayload,
          location,
        });

        if (res.ok) {
          dispatch({
            type: 'PATCH_TASK',
            id: task.id,
            patch: { state: 'success', confirmedAt: res.confirmedAt ?? Date.now(), lastError: undefined },
          });
          dispatch({ type: 'SET_MANUAL', task: null });
          dispatch({ type: 'SET_ERROR', error: null });
          dispatch({ type: 'RESET_COOLDOWN' });
          dispatch({ type: 'LOG', level: 'info', text: `签到成功：${task.courseName}` });
        } else {
          const err = res.error ?? { code: 'E_UNKNOWN', message: '未知失败', retryable: true } as CheckinError;
          dispatch({ type: 'SET_ERROR', error: err });
          if (err.code === 'E_SESSION_EXPIRED') {
            dispatch({ type: 'SET_SESSION', state: 'expired' });
            dispatch({ type: 'SET_AUTO', enabled: false });
            dispatch({ type: 'PATCH_TASK', id: task.id, patch: { state: 'failed', lastError: err } });
            dispatch({ type: 'LOG', level: 'error', text: '会话失效，已暂停自动签到，需重新绑定' });
          } else if (err.code === 'E_RATE_LIMITED') {
            dispatch({ type: 'RATE_LIMIT_HIT' });
            dispatch({ type: 'PATCH_TASK', id: task.id, patch: { state: 'rate_limited', lastError: err } });
          } else if (err.code === 'E_ALREADY_SIGNED') {
            dispatch({ type: 'PATCH_TASK', id: task.id, patch: { state: 'success', lastError: undefined } });
          } else {
            dispatch({ type: 'PATCH_TASK', id: task.id, patch: { state: 'failed', lastError: err } });
            dispatch({ type: 'LOG', level: 'error', text: `签到失败：${task.courseName} → ${err.code} ${err.message}` });
          }
        }
        return res;
      } finally {
        submittingRef.current = false;
      }
    },
    [],
  );

  // ---------- 一轮轮询 ----------
  const pollOnce = useCallback(async () => {
    const s = stateRef.current;
    const account = s.account;
    if (!account || !s.autoEnabled) return;
    if (Date.now() < s.cooldownUntil) {
      dispatch({ type: 'LOG', level: 'warn', text: '风控退避中，跳过本轮轮询' });
      return;
    }

    dispatch({ type: 'SET_POLLING', polling: true });
    try {
      const adapter = getAdapter();

      // 会话探活（adapter 内部有 5 分钟节流）
      const session = await adapter.probeSession(account);
      if (session !== 'valid') {
        dispatch({ type: 'SET_SESSION', state: session });
        if (session === 'expired') {
          dispatch({ type: 'SET_AUTO', enabled: false });
          dispatch({ type: 'LOG', level: 'error', text: '会话失效，已暂停自动签到' });
          return;
        }
      }

      const res = await adapter.detect(account, s.courses);
      if (res.sessionState !== 'valid') {
        dispatch({ type: 'SET_SESSION', state: res.sessionState });
        dispatch({ type: 'SET_AUTO', enabled: false });
        return;
      }
      dispatch({ type: 'SET_SESSION', state: 'valid' });

      if (res.closed.length) {
        dispatch({ type: 'UPSERT_TASKS', tasks: res.closed });
      }

      for (const task of res.found) {
        const existing = s.tasks.find((t) => t.id === task.id);
        if (existing && (existing.state === 'success' || existing.state === 'submitting')) continue;
        dispatch({ type: 'UPSERT_TASKS', tasks: [{ ...task, state: 'detecting' }] });
        dispatch({ type: 'LOG', level: 'info', text: `发现签到：${task.courseName}（${task.signType}）` });

        if (AUTO_SIGN_TYPES.includes(task.signType)) {
          // 可全自动：直接提交
          await doSubmit(task);
        } else {
          // 二维码/拍照/未知：转人工
          dispatch({ type: 'PATCH_TASK', id: task.id, patch: { state: 'need_manual' } });
          dispatch({
            type: 'SET_MANUAL',
            task: { ...task, state: 'need_manual' },
          });
          dispatch({ type: 'LOG', level: 'warn', text: `需要人工签到：${task.courseName}（${task.signType}）` });
        }
      }

      // 刷新统计
      const stats = await adapter.fetchStats(account);
      dispatch({ type: 'SET_STATS', stats });
    } catch (e) {
      dispatch({ type: 'SET_ERROR', error: { code: 'E_NETWORK', message: (e as Error).message, retryable: true } });
      dispatch({ type: 'LOG', level: 'error', text: `轮询异常：${(e as Error).message}` });
    } finally {
      dispatch({ type: 'SET_POLLING', polling: false });
    }
  }, [doSubmit]);

  // ---------- 调度循环 ----------
  useEffect(() => {
    if (!state.ready) return;
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!state.autoEnabled || !state.account) {
      dispatch({ type: 'SET_TIER', tier: 'cold', reason: '自动签到未开启', nextPollInMs: 0 });
      return;
    }

    const decision = decideTier({
      now: new Date(),
      courses: state.courses,
      plan: state.plan,
      autoEnabled: state.autoEnabled,
    });
    dispatch({ type: 'SET_TIER', tier: decision.tier, reason: decision.reason, nextPollInMs: decision.intervalMs });

    if (decision.sleeping) return;

    timerRef.current = setTimeout(() => {
      void pollOnce();
    }, decision.intervalMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // 依赖 tier 变化触发下一轮：pollOnce 完成后会更新 stats/tasks → 这里用 tick 计数更稳
  }, [state.ready, state.autoEnabled, state.account, state.courses, state.plan, state.stats, state.tier, pollOnce]);

  // 前后台切换：回来时立刻检测一次
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active' && stateRef.current.autoEnabled) {
        dispatch({ type: 'LOG', level: 'info', text: 'App 回到前台，立即检测一次' });
        void pollOnce();
      }
    });
    return () => sub.remove();
  }, [pollOnce]);

  // ---------- actions ----------
  const actions = useMemo<CheckinActions>(
    () => ({
      async bindWithPassword(studentId, password, studentName) {
        const adapter = getAdapter();
        const res = await adapter.loginWithPassword({
          tenant: adapter.tenant,
          studentId,
          password,
          studentName,
        });
        if (res.needMfa) {
          dispatch({ type: 'SET_MFA', payload: { ...res.needMfa, studentId } });
          return { ok: false, error: { code: 'E_MFA_REQUIRED', message: res.needMfa.hint, retryable: true } };
        }
        if (res.ok && res.account) {
          const acc = res.account;
          /**
           * ★ 与 bindWithSession 同样的处理：**账号先落地，课程后台拉**。
           *   原因见 bindWithSession 里的长注释（登录不该等几十次网络往返）。
           */
          dispatch({ type: 'SET_ACCOUNT', account: acc });
          dispatch({ type: 'SET_SESSION', state: 'valid' });
          dispatch({ type: 'LOG', level: 'info', text: `绑定成功（账号密码）：${acc.studentId}` });
          void (async () => {
            try {
              const courses = await adapter.fetchCourses(acc, stateRef.current.courses);
              if (stateRef.current.account?.id !== acc.id) return;
              dispatch({ type: 'SET_COURSES', courses });
            } catch {
              /* 课程只是缓存，失败不影响登录 */
            }
          })();
        }
        return { ok: res.ok, error: res.error };
      },

      async bindWithSession(studentId, cookies) {
        const adapter = getAdapter();
        const res = await adapter.importSession({ tenant: adapter.tenant, studentId, cookies });
        if (res.ok && res.account) {
          const acc = res.account;
          /**
           * ══════════════ ★★★ 账号先落地，课程**后台再拉** ★★★ ══════════════
           *
           * 用户原话：「每次登录要等的时间都太久了」
           *
           * 根因：这里原来是
           *     const courses = await safe(() => adapter.fetchCourses(res.account!), []);
           *     dispatch({ type: 'SET_ACCOUNT', ... });   ← 等它完成才设账号
           * 而 `fetchCourses` 走 `fetchOverview`，会**遍历全部课程**：
           *     每门课取课堂 → 每个课堂取活动 → 部分活动还要取详情
           * 实际约 25 门课，几十次网络往返 —— 所以登录界面要卡很久。
           *
           * 但"绑定成功"这件事**根本不需要等课程**：
           *   账号信息（学号/userId/会话）在 importSession 里就已经拿到了。
           *
           * 所以现在：
           *   ① 立刻 SET_ACCOUNT → 界面马上显示"登录成功"
           *   ② 课程在后台异步拉，回来再补上（不阻塞登录）
           *
           * ⚠️ 失败不影响登录：`safe()` 已经把异常吞掉返回 []，
           *    而且课程本来就只是给"签到/任务"页做缓存的。
           */
          dispatch({ type: 'SET_ACCOUNT', account: acc });
          dispatch({ type: 'SET_SESSION', state: 'valid' });
          dispatch({
            type: 'LOG',
            level: 'info',
            text: `绑定成功（会话导入）：${studentId} userId=${acc.userId ?? '(空)'}`,
          });

          /** ★ 课程后台拉 —— 不 await，登录不等它 */
          void (async () => {
            try {
              /**
               * ⚠️ 传 `stateRef.current.courses` 作为 prev ——
               *    这样用户之前设的**签到位置**与**课程开关**不会被这次拉取清掉。
               *    详见 youxueAdapter.fetchCourses 的注释（这是个踩过的坑）。
               */
              const courses = await adapter.fetchCourses(acc, stateRef.current.courses);
              /**
               * ⚠️ 回来时**必须再确认账号没变** ——
               *    用户在等待期间可能又切了账号，那就不能把
               *    上一个账号的课程盖到他头上（这个坑踩过）。
               */
              if (stateRef.current.account?.id !== acc.id) return;
              dispatch({ type: 'SET_COURSES', courses });
              dispatch({
                type: 'LOG',
                level: 'info',
                text: `后台已加载课程 ${courses.length} 门`,
              });
            } catch (e) {
              dispatch({
                type: 'LOG',
                level: 'warn',
                text: `后台加载课程失败（不影响签到）：${(e as Error).message}`,
              });
            }
          })();
        }
        return { ok: res.ok, error: res.error, userId: res.account?.userId };
      },

      async submitMfaCode(code) {
        const pending = stateRef.current.needMfa;
        if (!pending) return { ok: false, error: { code: 'E_MFA_REQUIRED', message: '没有待处理的验证', retryable: false } };
        const adapter = getAdapter();
        const res = await adapter.submitMfa(pending.continuation, code);
        if (res.ok && res.account) {
          const acc = res.account;
          /** ★ 同样：账号先落地，课程后台拉（见 bindWithSession 的注释） */
          dispatch({ type: 'SET_ACCOUNT', account: acc });
          dispatch({ type: 'SET_MFA', payload: null });
          dispatch({ type: 'LOG', level: 'info', text: '短信验证通过，绑定完成' });
          void (async () => {
            try {
              const courses = await adapter.fetchCourses(acc, stateRef.current.courses);
              if (stateRef.current.account?.id !== acc.id) return;
              dispatch({ type: 'SET_COURSES', courses });
            } catch {
              /* 课程只是缓存，失败不影响登录 */
            }
          })();
        }
        return { ok: res.ok, error: res.error };
      },

      async unbind() {
        const account = stateRef.current.account;
        if (account) await getAdapter().unbind(account.id);
        dispatch({ type: 'SET_ACCOUNT', account: null });
        dispatch({ type: 'SET_COURSES', courses: [] });
        dispatch({ type: 'SET_TASKS', tasks: [] });
        dispatch({ type: 'SET_AUTO', enabled: false });
        dispatch({ type: 'SET_SESSION', state: 'unknown' });
        dispatch({ type: 'LOG', level: 'warn', text: '已解绑并删除本地凭据' });
      },

      async refreshCourses() {
        const account = stateRef.current.account;
        if (!account) return;
        /**
         * ⚠️ 这一处**最要紧** —— 它是用户手动点「刷新课程」走的路径。
         *    不传 prev 的话，用户圈好的签到位置会在这次刷新后消失，
         *    而他刚刚才在上一屏设好，最容易以为是"设了没用"。
         */
        const courses = await getAdapter().fetchCourses(account, stateRef.current.courses);
        dispatch({ type: 'SET_COURSES', courses });
      },

      async refreshHistory() {
        const account = stateRef.current.account;
        if (!account) return;
        const history = await getAdapter().fetchHistory(account, 30);
        dispatch({ type: 'SET_HISTORY', history });
      },

      async toggleAuto(enabled) {
        const account = stateRef.current.account;
        if (!account) return;
        dispatch({ type: 'SET_AUTO', enabled });
        dispatch({ type: 'LOG', level: 'info', text: enabled ? '开启自动签到' : '关闭自动签到' });
        if (enabled) {
          dispatch({ type: 'RESET_COOLDOWN' });
          void pollOnce();
        }
      },

      async toggleCourse(courseId, enabled) {
        dispatch({ type: 'PATCH_COURSE', courseId, patch: { autoCheckin: enabled } });
      },

      /**
       * ★ 设置一门课的签到位置（地围栏圈）。
       *
       * 用户需求（原话）：
       *   「给我把位置签到完善一下，要做到要在发起签到的设备围一个圈选位置」
       *   「要不就自己引用个地图，手指滑动，让标点对准位置」
       *
       * ⚠️ 为什么存在 `Course.location` 而不是新建一张表：
       *    这个字段**本来就有**（domain/types.ts），`courseLocation()` 一直在读它，
       *    只是从来没有界面去写它 —— 所以之前位置签到只能用手机真实 GPS。
       *    复用它是**最省事也最不容易出错**的做法：不用改存储格式，
       *    老用户升级后已存的 location 照旧生效。
       *
       * ⚠️ 传 `null` 表示**清除**这门课的位置 ——
       *    PATCH_COURSE 是浅合并，直接给 `location: undefined` 在
       *    JSON 序列化时会被丢掉，导致"看起来清了其实没清"。
       *    所以这里显式给 `null`，由 reducer 负责删掉这个键。
       */
      async setCourseLocation(
        courseId: string,
        location: { latitude: number; longitude: number; radius?: number; address?: string } | null,
      ) {
        dispatch({
          type: 'PATCH_COURSE',
          courseId,
          patch: { location: location ?? undefined },
        });
        const c = stateRef.current.courses.find((x) => x.id === courseId);
        dispatch({
          type: 'LOG',
          level: 'info',
          text: location
            ? `已设置「${c?.name ?? courseId}」的签到位置：` +
              `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}` +
              `　半径 ${location.radius ?? 120}m`
            : `已清除「${c?.name ?? courseId}」的签到位置`,
        });
      },

      async updatePlan(patch) {
        const plan = { ...stateRef.current.plan, ...patch };
        dispatch({ type: 'SET_PLAN', plan });
      },

      async detectNow() {
        dispatch({ type: 'LOG', level: 'info', text: '手动立即检测' });
        await pollOnce();
      },

      async submitManual({ task, signCode, qrPayload, location }) {
        return doSubmit(task, { signCode, qrPayload, location, manual: true });
      },

      async submitQrScan(payload) {
        const s = stateRef.current;
        // 挑选最相关的待签到任务：优先 need_manual / detecting，其次最近的
        const candidates = s.tasks
          .filter((t) => t.state === 'need_manual' || t.state === 'detecting' || t.state === 'failed')
          .sort((a, b) => (b.windowStart ?? 0) - (a.windowStart ?? 0));
        const task = s.manualTask ?? candidates[0];
        if (!task) {
          dispatch({ type: 'LOG', level: 'warn', text: '扫到二维码，但当前没有已知的签到任务' });
          return { ok: false, needsTask: true };
        }
        const res = await doSubmit(task, { qrPayload: payload, manual: true });
        dispatch({
          type: 'LOG',
          level: res.ok ? 'info' : 'error',
          text: `扫码签到：${task.courseName} → ${res.ok ? '成功' : res.error?.code ?? '失败'}`,
        });
        return { ok: res.ok, courseName: task.courseName, error: res.error };
      },

      devTrigger(signType) {
        const mock = getMockAdapter();
        if (!mock) {
          dispatch({ type: 'LOG', level: 'warn', text: '当前不是 mock 适配器，无法手动制造签到' });
          return;
        }
        const task = mock.devTriggerRollcall(signType);
        if (task) {
          dispatch({ type: 'UPSERT_TASKS', tasks: [{ ...task, state: 'detecting' }] });
          dispatch({ type: 'LOG', level: 'info', text: `[演示] 制造签到窗口：${task.courseName}（${task.signType}）` });
        }
      },

      dismissManual() {
        dispatch({ type: 'SET_MANUAL', task: null });
      },

      clearCooldown() {
        dispatch({ type: 'RESET_COOLDOWN' });
        dispatch({ type: 'LOG', level: 'info', text: '手动解除风控熔断' });
      },

      clearLog() {
        dispatch({ type: 'CLEAR_LOG' });
      },
    }),
    [doSubmit, pollOnce],
  );

  const value = useMemo(() => ({ ...state, actions }), [state, actions]);
  return <CheckinContext.Provider value={value}>{children}</CheckinContext.Provider>;
}

export function useCheckin() {
  const ctx = useContext(CheckinContext);
  if (!ctx) throw new Error('useCheckin 必须在 CheckinProvider 内使用');
  return ctx;
}

// ---------------- 辅助 ----------------

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ⚠️ 原来的 `safe(fn, fallback)` 辅助**已删除** ——
 *    它只被三条登录路径用来包裹 `fetchCourses`。
 *    现在改成"账号先落地、课程后台拉"，后台那段自己 try/catch，
 *    所以这个辅助没有调用方了（严格模式下会报未使用）。
 */

function courseLocation(courses: Course[], courseId: string) {
  const loc = courses.find((c) => c.id === courseId)?.location;
  if (!loc) return undefined;
  // 反检测：坐标做小幅扰动，避免所有提交都用完全相同的点
  const jitter = () => (Math.random() - 0.5) * 0.0002; // ~±11m
  return {
    latitude: loc.latitude + jitter(),
    longitude: loc.longitude + jitter(),
    accuracy: 20 + Math.random() * 15,
  };
}

export { backoffMs };
