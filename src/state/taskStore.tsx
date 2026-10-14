/**
 * 任务数据 store —— 聚合「未完成作业」与「未看完课件」。
 *
 * 为什么要单独一个 store：
 *   作业和课件来自两个不同接口（/courseapi/homeworks/student 与 /courseapi/course/content），
 *   而"任务"在用户眼里是**一个**概念（我还有哪些事没做完），
 *   所以在这里合并、排序、缓存，页面只管展示。
 *
 * 完成度判定：
 *   作业  submitState === 'unsubmitted'  → 未完成
 *   课件  studyProgress < 100 且不是目录 → 未看完
 */
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { YouxueCourseApi } from '../services/checkin/youxueCourseApi';
import { parseUserIdFromCookie } from '../services/checkin/youxueAdapter';
import { store, STORE_KEYS } from '../services/storage';
import { logFault } from '../services/crashLog';
import { useCheckin } from './checkinStore';
import type { CoursewareItem, HomeworkItem } from '../domain/youxue';

/** 带课程信息的条目 */
export interface TaskHomework extends HomeworkItem {
  courseName: string;
}
export interface TaskCourseware extends CoursewareItem {
  courseName: string;
  ocId: number;
}

interface State {
  /** **未提交**的作业（已提交的不进这里，避免把做过的也说成没做） */
  homeworks: TaskHomework[];
  /** 已提交/已批改的作业，供「已提交」筛选查看 */
  submittedHomeworks: TaskHomework[];
  /** 未看完课件 */
  coursewares: TaskCourseware[];
  loading: boolean;
  progress: { done: number; total: number; phase: 'homework' | 'courseware' } | null;
  lastQueryAt?: number;
  error: string | null;
  warnings: string[];
}

interface Actions {
  query(): Promise<void>;
}

const Ctx = createContext<(State & { actions: Actions; bound: boolean }) | null>(null);

const initialState: State = {
  homeworks: [],
  submittedHomeworks: [],
  coursewares: [],
  loading: false,
  progress: null,
  error: null,
  warnings: [],
};

/**
 * 把凭据故障写进崩溃日志。
 *
 * 目的：这类问题在手机上复现、在我这边复现不了，
 * 与其来回问，不如让 App 自己把现场记下来 ——
 * 用户到「设置 → 崩溃日志」截一张图就够了。
 */
function logTaskFault(detail: string) {
  logFault(`[任务查询] ${detail}`, 'taskStore.makeApi');
}

export function TaskProvider({ children }: { children: React.ReactNode }) {
  const { account } = useCheckin();
  const [state, setState] = useState<State>(initialState);
  const runningRef = useRef(false);

  /** 用当前账号的凭据造一个 API 客户端 */
  const makeApi = useCallback(async (): Promise<{ api: YouxueCourseApi | null; why: string }> => {
    if (!account) return { api: null, why: '还没有绑定优学院账号' };
    const key = `${STORE_KEYS.account}.cred.${account.id}`;
    const cred = await store.get<{
      cookies?: Record<string, string>;
      userAgent?: string;
      userId?: number;
    } | null>(key, null);
    if (!cred) {
      // 记进崩溃日志，方便用户一次性把现场发出来（不用来回问）
      await logTaskFault(`凭据缺失 key=${key} account.id=${account.id}`);
      return { api: null, why: `本地没有这个账号的登录凭据（key=${key}）—— 请重新绑定一次` };
    }

    let userId = cred.userId ?? parseUserIdFromCookie(cred.cookies);
    const token = cred.cookies?.AUTHORIZATION ?? cred.cookies?.token ?? '';
    if (!token) {
      await logTaskFault(`凭据里没有 token key=${key} cookies=${Object.keys(cred.cookies ?? {}).join(',')}`);
      return { api: null, why: '登录会话已失效（找不到 token）—— 请重新绑定一次' };
    }
    if (!userId) {
      await logTaskFault(`凭据里没有 userId key=${key}`);
      return { api: null, why: '拿不到你的数字 userId —— 请重新绑定一次' };
    }

    // 自愈：把缺失的 userId 补回凭据
    if (!cred.userId) {
      await store.set(key, { ...cred, userId });
    }

    return {
      api: new YouxueCourseApi({ userId, cookies: cred.cookies, userAgent: cred.userAgent }),
      why: '',
    };
  }, [account]);

  const query = useCallback(async () => {
    if (runningRef.current) return;
    const { api, why } = await makeApi();
    if (!api) {
      setState((s) => ({ ...s, error: why }));
      return;
    }
    runningRef.current = true;
    setState((s) => ({ ...s, loading: true, error: null, warnings: [] }));
    try {
      const courses = await api.fetchCourses();
      const withClass = courses
        .filter((c) => c.classId)
        .map((c) => ({ id: c.id, classId: c.classId as number, name: c.name }));

      /**
       * ══════════ ⚠️ "没有取到课程"有两种完全不同的原因 ══════════
       *
       * 用户反馈过「为什么有时候会有这种情况，查询有问题」，
       * 而原来的提示只有一句「没有取到课程（会话可能已失效）」——
       * **两种原因混成一句话，用户和我都没法判断该做什么。**
       *
       *   ① 课程**列表是空的**（请求成功了，但没课程）
       *      → 常见于"这个学期还没选课"或"接口按学期给的"
       *      → 会话**没问题**，让他过阵子再试就行
       *
       *   ② 课程**请求失败**（取不到列表，可能是 401/超时/网络）
       *      → 这才是"会话失效"
       *      → 需要重新登录
       *
       * 所以现在分开报，并把 HTTP 状态与返回片段带出来 ——
       * 没有这些信息，只能反复猜（踩过太多次）。
       */
      if (withClass.length === 0) {
        if (courses.length === 0) {
          /**
           * ⚠️ 注意：`fetchCourses` 现在**请求失败会抛错**（见 youxueCourseApi），
           *    所以能走到这里说明**请求成功、但课程列表确实是空的**。
           *    这和"会话失效"是两回事 —— 别混成一句话（踩过）。
           */
          setState((s) => ({
            ...s,
            loading: false,
            error:
              '课程列表是空的 —— 请求成功了，但这个账号名下没有课程。\n' +
              '常见原因：这学期还没选上课，或者学校按学期分批放出来。\n' +
              '（这不是登录问题，过一会儿或换个时间再查往往就有了。）',
          }));
        } else {
          setState((s) => ({
            ...s,
            loading: false,
            error:
              `取到 ${courses.length} 门课，但都没有班级号（classId），无法查作业。\n` +
              '这通常说明接口返回的字段和预期不一样 —— 请把这条信息发我。',
          }));
        }
        return;
      }

      // 作业
      setState((s) => ({ ...s, progress: { done: 0, total: withClass.length, phase: 'homework' } }));
      const hw = await api.fetchAllHomeworks(withClass, (done, total) =>
        setState((s) => ({ ...s, progress: { done, total, phase: 'homework' } })),
      );

      // 课件
      setState((s) => ({ ...s, progress: { done: 0, total: withClass.length, phase: 'courseware' } }));
      const cw = await api.fetchAllCourseware(withClass, (done, total) =>
        setState((s) => ({ ...s, progress: { done, total, phase: 'courseware' } })),
      );

      // 只留"没做完"的；已经交过的单独收起来给「已提交」筛选用
      const pendingHw = hw.items.filter((h) => h.submitState === 'unsubmitted') as TaskHomework[];
      const doneHw = hw.items.filter(
        (h) => h.submitState === 'submitted' || h.submitState === 'graded',
      ) as TaskHomework[];
      const pendingCw = cw.items.filter(
        (it) => !it.isFolder && (it.finished !== true) && (it.studyProgress ?? 0) < 100,
      ) as TaskCourseware[];

      setState({
        homeworks: pendingHw,
        submittedHomeworks: doneHw,
        coursewares: pendingCw,
        loading: false,
        progress: null,
        lastQueryAt: Date.now(),
        error: null,
        warnings: [...hw.warnings, ...cw.warnings].slice(0, 5),
      });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, progress: null, error: (e as Error).message }));
    } finally {
      runningRef.current = false;
    }
  }, [makeApi]);

  const value = useMemo(
    () => ({ ...state, actions: { query }, bound: Boolean(account) }),
    [state, query, account],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTask() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTask 必须在 TaskProvider 内使用');
  return ctx;
}
