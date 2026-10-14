/**
 * 签到模块状态管理。
 *
 * 功能范围（按需求）：自动搜索签到环节、查看状态、更改状态。
 *
 * 字段映射（源码确认，勿改）：
 *   status = 学生签到状态：0缺勤 1/2已签到 3迟到 4早退 5病假 6事假
 *   type   = 签到方式：  0位置 1二维码 2数字码 3一键签到
 *   state  = 活动是否结束："0"已结束 "1"进行中
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { SignCourse, SignDetail, SignMethod, SignOverview, SignSubmitResult, YouxueUser } from '../domain/checkin';
import { isReallyOngoing, isSignedState } from '../domain/checkin';
import { YouxueSignApi } from '../services/checkin/signApi';
import type { ProbeResult } from '../services/checkin/probeActivityApi';
import { parseUserIdFromCookie } from '../services/checkin/youxueAdapter';
import { store, STORE_KEYS } from '../services/storage';
import { consumeQuota, getServerBase } from '../services/serverClient';
import { logFault } from '../services/crashLog';
import { useCheckin } from './checkinStore';
import { useUnlock } from './unlockStore';

interface StoredCred {
  cookies?: Record<string, string>;
  userAgent?: string;
  studentId: string;
  userId?: number;
}

interface State {
  ready: boolean;
  overview: SignOverview | null;
  user: YouxueUser | null;
  courses: SignCourse[];
  loading: boolean;
  /** 搜索进度（逐条读详情时更新） */
  progress: { done: number; total: number } | null;
  /**
   * ★ 已提前回报的条数。
   *
   * 查询分两段跑：先出"要处理的"，再补历史。
   * 界面靠这个值告诉用户"这几条已经能操作了，历史还在加载"。
   */
  hotCount: number;
  /**
   * ★ 其中**真正正在进行**的条数。
   *
   * ⚠️ 必须与 hotCount 分开：不能拿列表长度当"进行中"的条数。
   *    踩过的坑 —— 界面写「先显示正在进行的 140 条」，
   *    而 140 其实是还没筛过的总记录数。文案骗人比不显示更糟。
   */
  hotOngoing: number;
  lastQueryAt?: number;
  lastSubmit: (SignSubmitResult & { at: number; attendanceID?: number; method?: SignMethod }) | null;
  error: string | null;
}

const initialState: State = {
  ready: false,
  overview: null,
  user: null,
  courses: [],
  loading: false,
  progress: null,
  hotCount: 0,
  hotOngoing: 0,
  lastSubmit: null,
  error: null,
};

type Action =
  | { type: 'HYDRATE'; payload: Partial<State> }
  | { type: 'START'; }
  | { type: 'PROGRESS'; done: number; total: number }
  | { type: 'HOT_RECORDS'; ongoing: SignDetail[]; unsigned: SignDetail[] }
  | { type: 'SET_OVERVIEW'; overview: SignOverview }
  | { type: 'SET_SUBMIT'; result: State['lastSubmit'] }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'RESET' }
  | { type: 'DONE' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, ...action.payload, ready: true };
    /**
     * 清空所有查询结果。
     *
     * ⚠️ 必须存在：**切换账号时如果不清，界面会继续显示上一个账号的数据**。
     *    踩过的坑：登录别人的账号后，签到列表还是自己的 —— 因为：
     *      ① 缓存 key 是全局的（不分账号）
     *      ② 切换账号时没有重置内存里的 state
     *    现在两条都修了（见下面两个 useEffect）。
     */
    case 'RESET':
      return { ...initialState, ready: true };
    case 'START':
      return { ...state, loading: true, progress: null, error: null };
    case 'PROGRESS':
      return { ...state, progress: { done: action.done, total: action.total } };

    /**
     * ★ 提前回报「用户要处理的」。
     *
     * ══════════════ ⚠️ 这里踩过一个坑 ══════════════
     * 用户反馈：「先显示的应该是正在进行签到的，而不是说先显示 140 条」
     *
     * 第一版把**整批 140 条**都塞进列表，然后界面写「先显示正在进行的 140 条」。
     * 两处都错：
     *   · 140 是总记录数，不是"进行中"的条数 —— 文案在骗人
     *   · 一堆已签到的历史记录被提前塞进来，等于没做优先
     *
     * 现在只装两类，且**分开计数**，界面才能说对话：
     *   ongoing  真正正在进行的（要马上签）
     *   unsigned 未签到的（可能有漏签）
     */
    case 'HOT_RECORDS': {
      /**
       * ⚠️ 刻意**不复用上次的 records** —— 那批可能是上一个账号的，
       *    混进来就等于串数据。这里只装本次刚抓到的、确定属于当前账号的。
       *    （user 可以沿用：它是"当前登录者"，切换账号时 state 已被 RESET。）
       *
       * ⚠️ 顺序：**进行中的排最前**。用户要的是"点开就能签"。
       *    用 Map 去重 —— 一条记录可能同时属于两类（进行中且未签到）。
       */
      const seen = new Set<number>();
      const list: SignDetail[] = [];
      for (const r of [...action.ongoing, ...action.unsigned]) {
        if (seen.has(r.attendanceID)) continue;
        seen.add(r.attendanceID);
        list.push(r);
      }

      const merged: SignOverview = {
        user: state.overview?.user ?? null,
        courses: [],
        allRecords: list,
        summary: {
          total: list.length,
          signed: list.filter((r) => isSignedState(r.state)).length,
          absent: list.filter((r) => r.state === 'absent').length,
          signedRate: 0,
        },
        fetchedAt: Date.now(),
        complete: false,
        warnings: [],
      };
      return {
        ...state,
        overview: merged,
        courses: [],
        /** 真正"正在进行"的条数 —— 界面文案必须用它，不能用列表长度 */
        hotOngoing: action.ongoing.length,
        /** 提前回报的总条数（进行中 + 未签到） */
        hotCount: list.length,
      };
    }
    case 'DONE':
      return { ...state, loading: false, progress: null };
    case 'SET_OVERVIEW':
      return {
        ...state,
        overview: action.overview,
        user: action.overview.user,
        courses: action.overview.courses,
        lastQueryAt: action.overview.fetchedAt,
        error: action.overview.warnings.length ? action.overview.warnings.join('；') : null,
      };
    case 'SET_SUBMIT':
      return { ...state, lastSubmit: action.result };
    case 'SET_ERROR':
      return { ...state, error: action.error, loading: false, progress: null };
    default:
      return state;
  }
}

export interface SignActions {
  /** 自动搜索：遍历所有课程/课堂/点名，逐条取状态 */
  query(): Promise<void>;
  /** 按签到方式提交（内部统一走 doSubmit） */
  signByMethod(input: { attendanceID: number; classID?: number; method: SignMethod; credential?: string }): Promise<SignSubmitResult>;
  /** 改状态为已签到（位置方式） */
  signByLocation(input: { attendanceID: number; classID?: number; location: string; address?: string }): Promise<SignSubmitResult>;
  /** 改状态为已签到（二维码方式） */
  signByQrCode(input: { attendanceID: number; classID?: number; code: string }): Promise<SignSubmitResult>;
  /** 改状态为已签到（数字码方式） */
  signByNumCode(input: { attendanceID: number; classID?: number; code: string }): Promise<SignSubmitResult>;
  /** 拉服务端签到码 */
  fetchCode(attendanceID: number): Promise<string | null>;
  /** 尝试取消签到（把状态改回未签）—— 学生端是否有此接口待确认，见 signApi 注释 */
  cancelSign(input: { attendanceID: number; classID?: number }): Promise<SignSubmitResult>;
  /** 逐个真试所有「改状态」方案，返回每个的服务端结果 */
  tryStatusPlans(input: {
    attendanceID: number;
    classID?: number;
  }): Promise<Array<{ key: string; label: string; ok: boolean; detail: string }>>;
  /** 尝试把状态改成任意值（含教师权限状态），返回每个接口的服务端结果 */
  trySetStatus(input: {
    attendanceID: number;
    classID?: number;
    status: number;
  }): Promise<Array<{ label: string; ok: boolean; detail: string }>>;
  /**
   * 改签到状态（走已验证可用的教师接口）。
   * @param targetUserId 这条记录属于谁；不传 = 当前登录者。
   *                     个人码权限下只能等于自己的 userId，否则会被拒。
   */
  setStatus(input: {
    attendanceID: number;
    classID?: number;
    status: number;
    targetUserId?: number;
  }): Promise<{ ok: boolean; message: string; raw?: string }>;
  /** 参数矩阵（排查用） */
  probeTeacherSignShape(input: {
    attendanceID: number;
    classID?: number;
  }): Promise<Array<{ label: string; ok: boolean; detail: string }>>;
  /** 探测「取消/改状态」候选路由是否存在 */
  probeStatusRoutes(input: {
    attendanceID: number;
    classID?: number;
  }): Promise<Array<{ label: string; path: string; detail: string; exists: boolean }>>;
  /**
   * ★ 探测「加减分 / 点不中」需要的候选接口。
   *
   * ⚠️ 只发 GET，不改任何数据。
   */
  probeActivityApi(input: {
    classroomId?: number;
    classID?: number;
  }): Promise<ProbeResult[]>;
  /**
   * ══════════════ ★★★ 通用接口测试（「接口测试器」用）══════════════
   *
   * ⚠️⚠️ **这个能改真实数据**（支持 POST / DELETE）——
   *      是 App 里唯一这样的入口，界面上必须写清警告。
   *
   * 为什么需要它：做「加减分 / 点不中」时，**接口路径已实测确认**
   *   （`/apps/selectperson/*`，405/400 响应证明存在且会话有效、无角色校验），
   * 但**请求体字段名还没有权威来源** —— 前端调用这些接口的 chunk 没抓到，
   * 而我已经猜错三轮路径了，**不想再猜第四轮**。
   *
   * 所以做成"能自己试"的工具：填方法 + body，看服务端怎么答。
   * 400 的 `{"message":"…"}` 会直接指出缺什么字段。
   */
  rawApi(input: {
    path: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
  }): Promise<{ status: number; body: string; ok: boolean }>;
  /**
   * ★★★ 「点不中」试用矩阵（照签到当年的做法：发完复核）。
   *
   * ⚠️ 会**真的改活动设置**（selectType），但最后会自动回滚。
   *    走 `denyStatusChange` 的闸（授权 + 范围）。
   */
  probeSelectPerson(input: {
    activityId: number;
    roleId?: number;
  }): Promise<Array<{ label: string; path: string; method: string; detail: string; changed: string }>>;
  /**
   * ★★★ 「这节选人别抽我」—— 把当前登录者从**进行中的选人活动**里删掉。
   *
   * ⚠️ 只碰 `/apps/selectperson/*`（课堂互动），**绝不碰考勤**。
   * ⚠️ 只对当前这一个活动生效，下次要再操作。
   */
  removeSelfFromCall(input: { classroomId?: number }): Promise<{
    ok: boolean;
    steps: string[];
    activityId?: number;
    title?: string;
  }>;
  /**
   * ★ roleId 穷举 —— 试通 `deleteSelectedPersonActivity`
   * （优学院前端"踢人出选人活动"用的就是它）。
   *
   * ⚠️ 全是 DELETE，会真的删数据。请用**已结束**的活动 id 试。
   */
  probeRoleId(input: { activityId: number }): Promise<
    Array<{ roleId: number; status: number; body: string; ok: boolean; note: string }>
  >;
  /**
   * ★★★ 一键：把整个课程里"我还在名单上"的选人活动全删掉。
   *
   * 用户原话：「能不能一键删掉没有删过的，一个课程里的选人活动中」
   *
   * ⚠️ 只删"我在名单里"的那几条；不在名单里的**跳过**（不做无差别删除）。
   * ⚠️ 同样过两道闸（授权 + 范围）。
   */
  removeSelfFromAllCalls(input: { classroomId: number }): Promise<{
    ok: boolean;
    steps: string[];
    deleted: number;
    skipped: number;
    failed: number;
  }>;
  /**
   * ★★★ 列出我的课程 → 每门课的课堂 id。
   *
   * ⚠️ 解决用户的问题：「我没法从签到那里获得课程 id 怎么搞」——
   *    课堂 id 原先只在签到记录里显示，从没签到过的课就拿不到 id，
   *    而那恰恰是最需要"点不中"的课（人在实习、没去上课）。
   *    这里直接从课程列表拿，不依赖签到记录。
   */
  listCourseClassrooms(): Promise<
    Array<{
      ocId: number;
      courseName: string;
      teacher?: string;
      classroomCount: number;
      classrooms: Array<{ id: number; title: string; teacher?: string }>;
    }>
  >;
  /**
   * ★★★ 扫这门课的**全部课堂**，删掉我在名单里的选人活动。
   *
   * ⚠️ 解决「按了不管用」：一门课有很多课堂（每次上课一个），
   *    原来要精确选中当次那个课堂 id，选错就"共 0 条选人活动"。
   *    现在给课程 id，自动遍历所有课堂。
   */
  removeSelfFromCourse(input: { ocId: number }): Promise<{
    ok: boolean;
    steps: string[];
    deleted: number;
    skipped: number;
    failed: number;
    scanned: number;
  }>;
  /**
   * ★★★ **只删今天**的选人活动（用户明确要求）。
   *
   * 用户原话：「我要做的不是删除全部，我要做的只有删除当天的」
   *
   * ⚠️ 只处理 `beginTime` 落在**今天**的选人活动，**不动历史记录**。
   */
  removeSelfFromCourseToday(input: { ocId: number; dayOffset?: number }): Promise<{
    ok: boolean;
    steps: string[];
    deleted: number;
    skipped: number;
    failed: number;
    scanned: number;
    todayCount: number;
  }>;
  clearSubmit(): void;
}

const Ctx = createContext<(State & { actions: SignActions; bound: boolean }) | null>(null);

export function SignProvider({ children }: { children: React.ReactNode }) {
  const { account } = useCheckin();
  /**
   * 授权状态 —— 所有签到写操作的前置条件。
   *
   * App.tsx 的 Provider 顺序保证 UnlockProvider 在 SignProvider 外层，
   * 所以这里能拿到（改动顺序会直接崩，见 App.tsx 的注释）。
   */
  /**
   * ⚠️ 用 `quotaCode` 而不是 `code`。
   *
   * `code` 是"当前生效的那份码"，万能码被服务器改掉时会**降级**成个人码；
   * 而那份个人码是当初换来的，**服务器换码后就作废了** →
   * 送上去会得到「这个授权码不属于当前学号」（用户截图报过）。
   *
   * `quotaCode` 的规则是"手里有万能码就送万能码"，见 unlockStore 里的说明。
   */
  const { entitled, serverAuth, serverAuthMessage, scope, quotaCode: unlockCode } = useUnlock();
  const [state, dispatch] = useReducer(reducer, initialState);
  const apiRef = useRef<YouxueSignApi | null>(null);
  /**
   * 「进行中且我还没签」的数量。
   *
   * ⚠️ 为什么单独拎出来：这是**最紧急**的信息。
   *    老师刚发起点名时，那条记录如果不突出显示，
   *    用户得翻过一堆旧记录才看得到 —— 而点名是有时限的。
   *    全 App 都能读它，用于在入口处提醒（比如"有 2 个点名进行中"）。
   */
  const [activeCount, setActiveCount] = useState(0);

  /**
   * 造 API 客户端。
   *
   * ⚠️ 这里做了**自愈**：早期版本绑定时没把 userId 写进凭据，
   * 导致这些账号的签到功能整个不可用（接口全部需要数字 userId，
   * 学号字符串会被服务端 400 拒绝）。
   * 现在如果发现 userId 缺失，就从 cookie 里重新解析并补写回凭据，
   * 用户不用重新绑定。
   */
  /**
   * ══════════════ ★ 返回"为什么失败"而不是光返回 null ══════════════
   *
   * 踩过的坑：原来只会 `return null`，调用方统一报
   *     「缺少会话，请重新登录优学院」
   * 但失败原因有**四种**，混在一起就查不出来：
   *     ① 没有当前账号（换账号的空窗期）
   *     ② 这个账号的凭据不存在
   *     ③ 凭据里没有 token
   *     ④ 凭据里没有数字 userId
   *
   * 用户实测的现象是"点修改报错，查询之后就好了" ——
   * 说明是 ①② 这类**状态没准备好**的问题，而不是会话真的失效。
   * 但原话分不出来，只能反复猜。现在把原因带出来。
   */
  const explainNoApi = useCallback(async (): Promise<string> => {
    if (!account) return '还没有绑定优学院账号';
    const key = `${STORE_KEYS.account}.cred.${account.id}`;
    let cred: StoredCred | null = null;
    try {
      cred = await store.get<StoredCred | null>(key, null);
    } catch {
      return '读本地凭据时出错';
    }
    if (!cred) {
      /**
       * ⚠️ 这条最可能就是用户遇到的那个：**当前账号还没有凭据**。
       *    典型场景是刚换过账号（万能码登别人），account 已经变了，
       *    但那个账号的凭据还没落盘 / 还没读到。
       *    **先点一次「查询」就能好** —— 查询会走完整流程把连接建起来。
       */
      return `当前账号（${account.studentId}）还没有本地登录凭据 —— 先点一次「查询」把连接建起来，或重新登录一次`;
    }
    const token = cred.cookies?.AUTHORIZATION ?? cred.cookies?.token ?? '';
    if (!token) return '登录凭据里没有 token（会话不完整）—— 请重新登录一次';
    if (!(cred.userId ?? parseUserIdFromCookie(cred.cookies))) {
      return '登录凭据里没有数字 userId（签到接口需要它）—— 请重新登录一次';
    }
    return '初始化签到接口失败';
  }, [account]);

  const ensureApi = useCallback(async (): Promise<YouxueSignApi | null> => {
    if (apiRef.current) return apiRef.current;
    if (!account) return null;
    const key = `${STORE_KEYS.account}.cred.${account.id}`;
    const cred = await store.get<StoredCred | null>(key, null);
    if (!cred) return null;

    const token = cred.cookies?.AUTHORIZATION ?? cred.cookies?.token ?? '';
    let userId = cred.userId ?? parseUserIdFromCookie(cred.cookies);

    if (!token) return null;
    if (!userId) return null;

    // 自愈：把补出来的 userId 写回凭据，下次就不用再解析
    if (!cred.userId) {
      await store.set(key, { ...cred, userId });
    }

    apiRef.current = new YouxueSignApi({
      token,
      userId,
      cookies: cred.cookies,
      userAgent: cred.userAgent,
    });
    return apiRef.current;
  }, [account]);

  useEffect(() => {
    apiRef.current = null;
  }, [account?.id]);

  /**
   * ══════════ 缓存必须按账号分开（踩过的坑）══════════
   *
   * 原先用的是全局单一 key `STORE_KEYS.signOverview`，于是：
   *   用 A 查过一次 → 存进全局 key
   *   换成 B 登录    → 读到的还是 A 的缓存 → **界面显示 A 的数据**
   *
   * 现在 key 里带上 userId，并且读缓存时**再校验一次归属**
   * （防止历史遗留的旧 key 或者手工改过的数据串号）。
   */
  const overviewKey = account?.userId
    ? `${STORE_KEYS.signOverview}.${account.userId}`
    : null;

  // 读取本账号上次的搜索结果
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 没登录 / 拿不到 userId → 没有任何可显示的数据，直接清空
      if (!overviewKey || !account?.userId) {
        dispatch({ type: 'RESET' });
        return;
      }

      let cached = await store.get<SignOverview | null>(overviewKey, null);

      /**
       * ══════════ 旧版本数据迁移 ══════════
       *
       * 早期版本把概览存在**全局 key** `signOverview`（不分账号）。
       * 改成按 userId 分 key 之后，老数据就"看不见"了 ——
       * 用户看到的是"查询结果没了"，而不是"数据还在只是换了位置"。
       *
       * 这里做一次性搬运：只有当全局 key 里的数据**确实属于当前账号**时才搬，
       * 搬完就把旧 key 删掉（避免以后又串号）。
       */
      if (!cached) {
        const legacy = await store.get<SignOverview | null>(STORE_KEYS.signOverview, null);
        if (cancelled) return;
        if (legacy && legacy.user?.userId === account.userId) {
          cached = legacy;
          dispatch({
            type: 'HYDRATE',
            payload: { overview: legacy, user: legacy.user, courses: legacy.courses, lastQueryAt: legacy.fetchedAt },
          });
          void store.set(overviewKey, legacy);
          void store.remove(STORE_KEYS.signOverview);
          return;
        }
        // 全局 key 里是**别人**的数据（或已无用）→ 一律清掉。
        // 不清的话它会一直躺在磁盘上，下次再被误认（踩过）。
        if (legacy) void store.remove(STORE_KEYS.signOverview);
      }

      if (cancelled) return;

      // ★ 归属校验：缓存里的 userId 必须就是当前账号
      if (!cached || cached.user?.userId !== account.userId) {
        dispatch({ type: 'RESET' });
        return;
      }

      dispatch({
        type: 'HYDRATE',
        payload: { overview: cached, user: cached.user, courses: cached.courses, lastQueryAt: cached.fetchedAt },
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [overviewKey, account?.userId]);

  useEffect(() => {
    if (!state.ready || !state.overview || !overviewKey) return;
    // 只保存属于当前账号的结果
    if (state.overview.user?.userId !== account?.userId) return;
    store.set(overviewKey, state.overview);
  }, [state.ready, state.overview, overviewKey, account?.userId]);

  const query = useCallback(async () => {
    // 先给出**具体**的失败原因，别只说"信息不完整"让人无从下手
    if (!account) {
      dispatch({ type: 'SET_ERROR', error: '还没有绑定优学院账号 —— 请先到「优学院 → 去绑定」登录一次' });
      return;
    }
    const cred = await store.get<StoredCred | null>(`${STORE_KEYS.account}.cred.${account.id}`, null);
    if (!cred) {
      logFault(
        `[签到查询] 凭据缺失 key=${STORE_KEYS.account}.cred.${account.id} account.id=${account.id}`,
        'signStore.query',
      );
      dispatch({
        type: 'SET_ERROR',
        error: '本地没有这个账号的登录凭据（可能换过设备或清过数据）—— 请重新绑定一次',
      });
      return;
    }
    const token = cred.cookies?.AUTHORIZATION ?? cred.cookies?.token ?? '';
    const userId = cred.userId ?? parseUserIdFromCookie(cred.cookies);
    if (!token) {
      dispatch({ type: 'SET_ERROR', error: '登录会话已失效（找不到 token）—— 请重新绑定一次' });
      return;
    }
    if (!userId) {
      dispatch({
        type: 'SET_ERROR',
        error: '拿不到你的数字 userId，签到接口无法调用 —— 请重新绑定一次',
      });
      return;
    }

    const api = await ensureApi();
    if (!api) {
      /** ★ 与 setStatus 同样：把"为什么"说清楚并记进日志 */
      const why = await explainNoApi();
      logFault(`[签到查询] 建不起接口：${why} account.id=${account.id}`, 'signStore.query');
      dispatch({ type: 'SET_ERROR', error: why });
      return;
    }
    dispatch({ type: 'START' });
    try {
      const overview = await api.fetchOverview(
        (done, total) => dispatch({ type: 'PROGRESS', done, total }),
        /**
         * ★ 要处理的记录一抓到就立刻显示 —— 紧急情况不用等历史。
         *
         * 注意这里**不 dispatch DONE**：loading 保持 true，
         * 界面会说"这几条已经能操作了，其余还在查"。
         */
        (hot) => dispatch({ type: 'HOT_RECORDS', ongoing: hot.ongoing, unsigned: hot.unsigned }),
      );

      /**
       * ══════════ 归属校验（最后一道防线）══════════
       *
       * 服务端回来的 user.userId 必须与当前账号一致。
       * 不一致说明**用错了会话**（比如适配器单例里残留了上一个账号的 signApi），
       * 这时宁可报错，也绝不能把别人的数据当成自己的显示出来 ——
       * 用户就是被这个坑过：「换账号后查询还都是我的数据」。
       */
      const gotId = overview.user?.userId;
      const wantId = account.userId;
      if (gotId && wantId && gotId !== wantId) {
        logFault(
          `[签到查询] 账号不匹配：期望 userId=${wantId}(${account.studentId}) 实际拿到 ${gotId} ` +
            `—— 可能用了上一个账号的会话`,
          'signStore.query',
        );
        dispatch({
          type: 'SET_ERROR',
          error:
            `查询结果属于另一个账号（期望 ${wantId}，拿到 ${gotId}）。` +
            `已丢弃这次结果。请到「优学院 → 换账号」重新绑定后再查。`,
        });
        return;
      }

      dispatch({ type: 'SET_OVERVIEW', overview });

      /**
       * 统计「进行中且未签到」的数量。
       *
       * 判定复用列表页那套（不能只看服务端的 activityState ——
       * 实测 2022 年的老记录 state 仍是 "1"，会把三年前的当成进行中）。
       * 这里同步一份到 store，让**任何页面**都能提醒用户。
       */
      try {
        const n = overview.allRecords.filter((r) => !isSignedState(r.state) && isReallyOngoing(r)).length;
        setActiveCount(n);
      } catch {
        setActiveCount(0);
      }
    } catch (e) {
      const raw = (e as Error).message ?? '';

      /**
       * ══════════ 会话失效时给出**能照做**的提示 ══════════
       *
       * 用户反馈：「有时候必须重新登录才能用任务和签到」，
       * 查询时报 `HTTP=401 {"code":2101,"message":"无效的token"}`。
       * 原先这个 401 原文直接扔到界面上，用户不知道该怎么办。
       *
       * 现在识别出来并明确告诉他：会话过期了，去重新登录。
       */
      const isAuthError = /401|无效的\s*token|invalid\s*token|未登录/i.test(raw);
      if (isAuthError) {
        logFault(`[签到查询] 会话失效（401）：${raw.slice(0, 200)}`, 'signStore.query');
        // 丢掉缓存的 API 客户端，逼下次重新取凭据
        apiRef.current = null;
        dispatch({
          type: 'SET_ERROR',
          error:
            '优学院的登录会话已过期，需要重新登录。\n' +
            '去「优学院 → 换账号 → 用网页登录」重新登一次即可。\n' +
            '（这不是密码错，是会话有效期到了，学校那边会定期失效。）',
        });
        return;
      }

      dispatch({ type: 'SET_ERROR', error: raw });
    } finally {
      dispatch({ type: 'DONE' });
    }
  }, [ensureApi, account]);

  /**
   * 签到前的**授权把关**。
   *
   * 三层：
   *   ① 本地：授权码里的学号哈希 == 当前登录的学号
   *      —— 拿别人的授权码会被这里挡
   *   ② 服务器：管理员没有在管理页关掉这个学号
   *   ③ **范围**：个人码只能改自己的
   *      —— `signByTea` 接口本身接受任意 userID，服务端不校验"你改的是不是自己"，
   *         所以这一层必须在客户端把关，否则个人码也能改别人。
   *
   * @returns 通过返回 null，不通过返回拒绝结果
   */
  const denyReason = useCallback((): SignSubmitResult | null => {
    if (!entitled) {
      if (serverAuth === 'denied') {
        return {
          ok: false,
          message: `签到未授权：${serverAuthMessage || '管理员已关闭这个学号的授权'}。`,
        };
      }
      return {
        ok: false,
        message:
          '签到未授权：当前登录的学号与授权码不匹配。' +
          '授权码是绑定学号的 —— 换个账号登录就会失效。',
      };
    }
    return null;
  }, [entitled, serverAuth, serverAuthMessage]);

  /**
   * 「改状态」的额外把关：**个人码不能改别人**。
   *
   * 为什么单独一个函数：签到（signByStu 用当前登录者的 userId）天然只能改自己；
   * 而改状态走的是教师接口 `signByTea`，**它的 userID 是参数**，
   * 服务端不检查"你是不是在改自己" —— 所以必须在这里拦。
   *
   * @param targetUserId 这条记录属于谁（不传 = 当前登录者）
   */
  const denyStatusChange = useCallback(
    (targetUserId?: number): SignSubmitResult | null => {
      const base = denyReason();
      if (base) return base;

      if (scope !== 'all') {
        const mine = account?.userId;
        // 拿不到自己的 userId 时保守拒绝（没法确认改的是不是自己）
        if (!mine) {
          return {
            ok: false,
            message: '改状态需要确认你的账号 userId，请重新登录优学院账号后再试。',
          };
        }
        if (targetUserId !== undefined && targetUserId !== mine) {
          return {
            ok: false,
            message:
              '你的权限是「个人授权码」，只能改自己的签到。' +
              '要改别人的状态需要管理员给你万能码。',
          };
        }
      }
      return null;
    },
    [account?.userId, denyReason, scope],
  );

  /**
   * ★ 配额把关：截止时间 + 次数。
   *
   * ══════════════ 为什么单独一层 ══════════════
   * 需求：「所有人默认永久 + 无限次，我可以在管理端自由设定生效时间和次数，
   *        次数根据改了几次状态来算」。
   *
   *   · 截止时间：码里编了到期日，`checkCodeForStudent` 已经会拦（断网也有效）
   *   · **次数**：只有服务器知道 → 写操作前问 `/api/consume`，服务端顺手 +1
   *
   * ⚠️ 关键区分（踩过的思路）：
   *     connOk === false（连不上）→ **放行**
   *        服务器挂了不该把所有人挡死 —— 与 serverAuth 的宽松策略一致。
   *     allow === false（服务器明确说不行）→ **拦住**，并告诉用户原因。
   *
   * @returns 通过返回 null，不通过返回拒绝结果
   */
  const denyByQuota = useCallback(async (): Promise<SignSubmitResult | null> => {
    const sid = account?.studentId;
    if (!sid) return null; // 没绑账号走别的分支（后面会报"请先绑定"）

    const base = await getServerBase();
    if (!base) return null; // 没配服务器 → 无配额信息可用，放行

    const r = await consumeQuota(base, { studentId: sid, code: unlockCode ?? undefined });
    if (!r.ok) return null; // 连不上 → 放行（宽松）
    if (r.allow) return null; // 通过（服务端已计数）

    return {
      ok: false,
      message:
        r.message ||
        (r.reason === 'expired'
          ? '授权已过期，请联系管理员'
          : '授权次数已用完，请联系管理员'),
    };
  }, [account?.studentId, unlockCode]);

  const doSubmit = useCallback(
    async (
      kind: SignMethod,
      input: { attendanceID: number; classID?: number; location?: string; address?: string; code?: string },
    ) => {
      // ★ 授权把关：不通过就根本不发请求
      const denied = denyReason();
      if (denied) {
        dispatch({
          type: 'SET_SUBMIT',
          result: { ...denied, at: Date.now(), attendanceID: input.attendanceID, method: kind },
        });
        return denied;
      }

      /**
       * ★ 配额把关（到期 / 次数）。
       *   放在 denyReason 之后：先确认"有没有权限"，
       *   再看"还有没有额度" —— 顺序反了会给没权限的人白扣次数。
       */
      const quotaDenied = await denyByQuota();
      if (quotaDenied) {
        dispatch({
          type: 'SET_SUBMIT',
          result: { ...quotaDenied, at: Date.now(), attendanceID: input.attendanceID, method: kind },
        });
        return quotaDenied;
      }

      const api = await ensureApi();
      if (!api) {
        const r: SignSubmitResult = { ok: false, message: '未绑定账号或缺少 userId，请重新绑定' };
        dispatch({ type: 'SET_SUBMIT', result: { ...r, at: Date.now(), attendanceID: input.attendanceID, method: kind } });
        return r;
      }
      const res = await api.submitSign({
        attendanceID: input.attendanceID,
        userID: api.userId,
        classID: input.classID,
        method: kind,
        location: input.location,
        address: input.address,
        attendanceCode: input.code,
      });
      dispatch({ type: 'SET_SUBMIT', result: { ...res, at: Date.now(), attendanceID: input.attendanceID, method: kind } });
      if (res.ok) void query();
      return res;
    },
    // ⚠️ denyByQuota 必须进依赖 —— 它闭包里带着 account.studentId 与当前授权码
    [denyReason, denyByQuota, ensureApi, query],
  );

  const actions = useMemo<SignActions>(
    () => ({
      query,
      signByMethod: ({ attendanceID, classID, method, credential }) =>
        doSubmit(method, {
          attendanceID,
          classID,
          location: method === 'location' ? credential : undefined,
          code: method === 'location' ? undefined : credential,
        }),
      signByLocation: (input) =>
        doSubmit('location', {
          attendanceID: input.attendanceID,
          classID: input.classID,
          location: input.location,
          address: input.address,
        }),
      signByQrCode: (input) =>
        doSubmit('qrcode', { attendanceID: input.attendanceID, classID: input.classID, code: input.code }),
      signByNumCode: (input) =>
        doSubmit('numcode', { attendanceID: input.attendanceID, classID: input.classID, code: input.code }),
      fetchCode: async (attendanceID) => {
        const api = await ensureApi();
        if (!api) return null;
        return api.fetchAttendanceCode(attendanceID);
      },
      cancelSign: async (input) => {
        const api = await ensureApi();
        if (!api) return { ok: false, message: '未绑定账号或缺少 userId，请重新绑定' };
        const res = await api.cancelSign({
          attendanceID: input.attendanceID,
          classID: input.classID,
        });
        dispatch({
          type: 'SET_SUBMIT',
          result: { ...res, at: Date.now(), attendanceID: input.attendanceID },
        });
        return res;
      },
      tryStatusPlans: async (input) => {
        const api = await ensureApi();
        if (!api) return [{ key: 'no-api', label: '未绑定账号', ok: false, detail: '缺少会话，请重新登录' }];
        return api.tryStatusPlans(input);
      },
      trySetStatus: async (input) => {
        const api = await ensureApi();
        if (!api) return [{ label: '未绑定账号', ok: false, detail: '缺少会话，请重新登录' }];
        return api.trySetStatus(input);
      },
      setStatus: async (input) => {
        // ★ 改状态是写操作，且走的是"能指定 userID"的教师接口 ——
        //   所以既要过授权，也要过**范围**（个人码只能改自己）
        const denied = denyStatusChange(input.targetUserId);
        if (denied) {
          const r = { ok: false, message: denied.message ?? '签到未授权' };
          dispatch({
            type: 'SET_SUBMIT',
            result: { ok: false, message: r.message, at: Date.now(), attendanceID: input.attendanceID },
          });
          return r;
        }

        /**
         * ★ 配额把关 —— 「次数根据改了几次状态来算」，
         *   所以"改状态"同样要计一次、也要先查额度。
         */
        const quotaDenied = await denyByQuota();
        if (quotaDenied) {
          const r = { ok: false, message: quotaDenied.message ?? '授权次数已用完' };
          dispatch({
            type: 'SET_SUBMIT',
            result: { ...r, at: Date.now(), attendanceID: input.attendanceID },
          });
          return r;
        }

        const api = await ensureApi();
        if (!api) {
          const why = await explainNoApi();
          /** ★ 记进故障日志 —— 下次"改状态报错"能直接看到是哪一种 */
          logFault(
            `[改状态] 建不起接口：${why} attendanceID=${input.attendanceID} ` +
              `account.id=${account?.id ?? '(无)'} studentId=${account?.studentId ?? '(无)'}`,
            'signStore.setStatus',
          );
          const r = { ok: false, message: why };
          dispatch({
            type: 'SET_SUBMIT',
            result: { ...r, at: Date.now(), attendanceID: input.attendanceID },
          });
          return r;
        }
        const res = await api.setStatusByTeacher({
          attendanceID: input.attendanceID,
          status: input.status,
        });
        dispatch({
          type: 'SET_SUBMIT',
          result: {
            ok: res.ok,
            message: res.message,
            raw: res.raw,
            at: Date.now(),
            attendanceID: input.attendanceID,
          },
        });
        return res;
      },
      probeTeacherSignShape: async (input) => {
        const api = await ensureApi();
        if (!api) return [{ label: '未绑定账号', ok: false, detail: '缺少会话，请重新登录' }];
        return api.probeTeacherSignShape(input);
      },
      probeStatusRoutes: async (input) => {
        const api = await ensureApi();
        if (!api) {
          return [{ label: '未绑定账号', path: '-', detail: '缺少会话，请重新登录', exists: false }];
        }
        return api.probeStatusRoutes(input);
      },
      /**
       * ★ 探测「加减分 / 点不中」的候选接口。
       *
       * ⚠️ 只发 GET，不改数据 —— 见 probeActivityApi 的注释。
       */
      probeActivityApi: async (input) => {
        const api = await ensureApi();
        if (!api) {
          return [
            {
              group: '错误',
              label: '未绑定账号',
              path: '-',
              status: 0,
              detail: '缺少会话，请先登录优学院',
              guess: '不确定' as const,
            },
          ];
        }
        return api.probeActivityApi(input);
      },
      /**
       * ★★★ 通用接口测试 —— **唯一能改真实数据的入口**。
       *
       * ⚠️ 授权与配额都必须先过：
       *    这个入口能 POST/DELETE，等于绕过界面直接调接口，
       *    所以不能让它成为"未授权也能写"的后门。
       *    用 `denyStatusChange()` 把两道闸都过一遍（它就是写作操作的闸）。
       */
      rawApi: async (input) => {
        const denied = denyStatusChange();
        if (denied) {
          return { status: 0, ok: false, body: denied.message ?? '未授权，不能调用写接口' };
        }
        const api = await ensureApi();
        if (!api) {
          const why = await explainNoApi();
          return { status: 0, ok: false, body: why };
        }
        return api.rawRequest(input);
      },
      /**
       * ★★★ 「点不中」试用矩阵。
       *
       * ⚠️ 与 rawApi 同样的两道闸（授权 + 范围）—— 它会真的改活动设置。
       */
      probeSelectPerson: async (input) => {
        const denied = denyStatusChange();
        if (denied) {
          return [
            {
              label: '未授权',
              path: '-',
              method: '-',
              detail: denied.message ?? '未授权，不能调用写接口',
              changed: '-',
            },
          ];
        }
        const api = await ensureApi();
        if (!api) {
          const why = await explainNoApi();
          return [{ label: '建不起接口', path: '-', method: '-', detail: why, changed: '-' }];
        }
        return api.probeSelectPerson(input);
      },
      /** ★★★ 「这节选人别抽我」—— 同样过两道闸（它会真的删数据） */
      removeSelfFromCall: async (input) => {
        const denied = denyStatusChange();
        if (denied) {
          return { ok: false, steps: [denied.message ?? '未授权，不能调用写接口'] };
        }
        const api = await ensureApi();
        if (!api) {
          const why = await explainNoApi();
          return { ok: false, steps: [why] };
        }
        return api.removeSelfFromCall(input);
      },
      /** ★ roleId 穷举 —— 同样过两道闸 */
      probeRoleId: async (input) => {
        const denied = denyStatusChange();
        if (denied) {
          return [{ roleId: 0, status: 0, body: denied.message ?? '未授权', ok: false, note: '未授权' }];
        }
        const api = await ensureApi();
        if (!api) {
          const why = await explainNoApi();
          return [{ roleId: 0, status: 0, body: why, ok: false, note: '建不起接口' }];
        }
        return api.probeRoleId(input);
      },
      /** ★★★ 一键批量剔除 —— 同样过两道闸（会真的删数据） */
      removeSelfFromAllCalls: async (input) => {
        const denied = denyStatusChange();
        if (denied) {
          return { ok: false, steps: [denied.message ?? '未授权'], deleted: 0, skipped: 0, failed: 0 };
        }
        const api = await ensureApi();
        if (!api) {
          const why = await explainNoApi();
          return { ok: false, steps: [why], deleted: 0, skipped: 0, failed: 0 };
        }
        return api.removeSelfFromAllCalls(input);
      },
      /** ★ 列课程→课堂 id（只读，不需要写权限，但建 api 仍要账号） */
      listCourseClassrooms: async () => {
        const api = await ensureApi();
        if (!api) return [];
        return api.listCourseClassrooms();
      },
      /** ★★★ 扫整门课的所有课堂 —— 同样过两道闸（会真的删数据） */
      removeSelfFromCourse: async (input) => {
        const denied = denyStatusChange();
        if (denied) {
          return {
            ok: false,
            steps: [denied.message ?? '未授权'],
            deleted: 0,
            skipped: 0,
            failed: 0,
            scanned: 0,
          };
        }
        const api = await ensureApi();
        if (!api) {
          const why = await explainNoApi();
          return { ok: false, steps: [why], deleted: 0, skipped: 0, failed: 0, scanned: 0 };
        }
        return api.removeSelfFromCourse(input);
      },
      /** ★★★ 只删今天的 —— 同样过两道闸（会真的删数据） */
      removeSelfFromCourseToday: async (input) => {
        const denied = denyStatusChange();
        if (denied) {
          return {
            ok: false,
            steps: [denied.message ?? '未授权'],
            deleted: 0,
            skipped: 0,
            failed: 0,
            scanned: 0,
            todayCount: 0,
          };
        }
        const api = await ensureApi();
        if (!api) {
          const why = await explainNoApi();
          return { ok: false, steps: [why], deleted: 0, skipped: 0, failed: 0, scanned: 0, todayCount: 0 };
        }
        /**
         * ══════════════ ★★★ 身份一致性校验（删错人的最后一道闸）══════════════
         *
         * 用户专门问过：「你确定删掉我的那个我是号主吧」
         *
         * 链路本来是可靠的：
         *   · 凭据按 `account.cred.${account.id}` 分开存
         *   · `this.userId` 取自该凭据
         *   · 判断"我在不在名单里"和"删除我"用的是**同一个** `this.userId`
         *
         * ⚠️ 但那是**间接保证**。这里加一道**直接**检查：
         *    会话里的 userId 必须等于当前账号的 userId，否则拒绝执行。
         *    万一凭据存储出问题（迁移/损坏），就不会删错人。
         */
        const sessionUid = api.sessionUserId;
        const accountUid = account?.userId;
        if (accountUid && sessionUid && sessionUid !== accountUid) {
          return {
            ok: false,
            steps: [
              `✗ **账号不一致，已拒绝执行**：`,
              `   当前账号 userId=${accountUid}`,
              `   会话 userId=${sessionUid}`,
              `为防删错人，请先重新登录优学院账号再试。`,
            ],
            deleted: 0,
            skipped: 0,
            failed: 0,
            scanned: 0,
            todayCount: 0,
          };
        }
        return api.removeSelfFromCourseToday(input);
      },
      clearSubmit: () => dispatch({ type: 'SET_SUBMIT', result: null }),
    }),
    [query, doSubmit, ensureApi, denyStatusChange, denyReason, denyByQuota],
  );

  const value = useMemo(
    () => ({ ...state, actions, bound: Boolean(account), activeCount }),
    [state, actions, account, activeCount],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSign() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSign 必须在 SignProvider 内使用');
  return ctx;
}
