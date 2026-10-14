/**
 * 优学院数据接口 —— 课程、课件、作业。
 *
 * ══════════ 路径前缀规律（反复踩过）══════════
 *   /courseapi/*              → 不加 /apps
 *   /apps/newAttendance/*     → 必须加 /apps
 * 加错任一方向都是 404。
 *
 * ══════════ 端点来源 ══════════
 *   课程列表：手机 App 首页实测
 *   课件列表：从 App JS 里挖出 + 实测 200（/courseapi/course/content）
 *   作业：**未接入** —— 作业页在 PC 版 SPA（lms.dgut.edu.cn/mooc/pc.html）里，
 *        不在手机 App 包内，尚未定位到可用接口。
 */
import { HttpClient } from './http';
import type { RawCourse } from '../../domain/checkin';
import type { CoursewareItem, CoursewareDetail, HomeworkItem } from '../../domain/youxue';
import { BUILD_CONFIG } from '../../config/buildConfig';

/** 已验证的端点 */
export const YOUXUE_ENDPOINTS = {
  /** 我的课程（实测 total=25，含教师名/班级/学习进度） */
  myCourses: (type = 1) =>
    `/courseapi/courses/students?publishStatus=1&pn=1&ps=99999&type=${type}`,
  /**
   * 某门课的课件列表。
   * 实测：返回 {pageNum,pageSize,total,list}。
   * ⚠️ 必须带 classId，否则可能取不到数据。
   */
  courseContent: (ocId: number, classId: number, opts: { parentId?: number | string; pn?: number; ps?: number; classroomId?: number | string; keyword?: string } = {}) => {
    const q = new URLSearchParams({
      ocId: String(ocId),
      classId: String(classId),
      type: '',
      parentId: String(opts.parentId ?? ''),
      teacherId: '',
      keyword: opts.keyword ?? '',
      pn: String(opts.pn ?? 1),
      ps: String(opts.ps ?? 200),
      classroomId: String(opts.classroomId ?? ''),
      version: '2',
    });
    return `/courseapi/course/content?${q.toString()}`;
  },
  /**
   * ★ 学生端作业列表（实测可用）。
   *
   * ⚠️ 踩过的坑：`/courseapi/homeworks`（不带 /student）是**教师接口**，
   * 学生调用返回 403「只有课程管理员、教师或助教才能查看作业列表」。
   * 学生端必须用 `/courseapi/homeworks/student`。
   */
  studentHomeworks: (ocId: number, classId: number, userId: number, pn = 1, ps = 100) =>
    `/courseapi/homeworks/student?ocId=${ocId}&classId=${classId}&userId=${userId}&pn=${pn}&ps=${ps}`,
  /** 单个课件详情 */
  courseContentDetail: (contentId: number, resourceFlag = 1) =>
    `/courseapi/course/content/${contentId}?id=${contentId}&resourceFlag=${resourceFlag}`,
  /** 用户信息（含真实姓名） */
  userInfo: (userId: number) => `/apps/user/getUserByUserID/${userId}`,
} as const;

export class YouxueCourseApi {
  private http: HttpClient;
  private host: string;
  readonly userId: number;

  constructor(opts: { userId: number; cookies?: Record<string, string>; userAgent?: string; host?: string }) {
    this.userId = opts.userId;
    this.http = new HttpClient({ cookies: opts.cookies, userAgent: opts.userAgent });
    this.host = opts.host ?? BUILD_CONFIG.hosts.lms;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = this.http.cookies.AUTHORIZATION ?? this.http.cookies.token ?? '';
    return {
      ...(token ? { AUTHORIZATION: token } : {}),
      'X-Requested-With': 'cn.ulearning.yxy',
      Referer: `${this.host}/umobile/?timestamp=${Date.now()}`,
      Accept: 'application/json, text/plain, */*',
      ...extra,
    };
  }

  /**
   * ══════════ ⚠️ 为什么需要这个"带诊断"的版本 ══════════
   *
   * 原先只有 `getJson`，它在失败时**统一返回 null**：
   *     if (res.status !== 200) return null;
   *     } catch { return null; }
   *
   * 于是三种完全不同的情况变得无法区分：
   *     · 401/403 会话失效
   *     · 超时 / 网络错误
   *     · 返回了非 JSON（被网关拦、返回 HTML 登录页）
   * 全是 null → 上层 `raw?.courseList ?? []` → 变成"空数组" →
   * 最终界面上只有一句含糊的「没有取到课程（会话可能已失效）」。
   *
   * 用户反馈过「为什么有时候会有这种情况」—— 就是查不出原因，
   * 因为**失败现场在最底层就被丢掉了**。
   *
   * 现在把状态码与返回片段带出来。
   */
  private async getJsonDetailed<T>(
    path: string,
  ): Promise<{ data: T | null; status: number; snippet: string; error?: string }> {
    try {
      const res = await this.http.get(`${this.host}${path}`, { headers: this.headers() });
      const text = String(res.body ?? '').trim();
      const snippet = text.replace(/\s+/g, ' ').slice(0, 160);
      if (res.status !== 200) {
        return { data: null, status: res.status, snippet, error: `HTTP ${res.status}` };
      }
      if (!text) {
        return { data: null, status: res.status, snippet: '', error: '返回内容为空' };
      }
      try {
        return { data: JSON.parse(text) as T, status: res.status, snippet };
      } catch {
        // 返回了非 JSON —— 常见于被网关拦、或返回了 HTML 登录页
        return { data: null, status: res.status, snippet, error: '返回的不是 JSON' };
      }
    } catch (e) {
      return { data: null, status: 0, snippet: '', error: `请求异常：${(e as Error).message}` };
    }
  }

  private async getJson<T>(path: string): Promise<T | null> {
    const r = await this.getJsonDetailed<T>(path);
    return r.data;
  }

  /**
   * 我的课程。
   *
   * ⚠️ **失败时抛错，不再静默返回空数组。**
   *
   * 原先失败返回 `[]`，调用方没法区分"没有课程"和"请求失败"，
   * 于是界面上只能给一句含糊的「没有取到课程（会话可能已失效）」——
   * 用户看到这句话既不知道该怎么办，我也查不出原因。
   *
   * 现在抛出的错误里带 HTTP 状态与返回片段，
   * 界面能照着说清楚（见 taskStore 的处理）。
   */
  async fetchCourses(): Promise<RawCourse[]> {
    const r = await this.getJsonDetailed<{ total?: number; courseList?: RawCourse[] }>(
      YOUXUE_ENDPOINTS.myCourses(),
    );
    if (r.data === null) {
      throw new Error(
        `取课程列表失败：${r.error ?? '未知原因'}` +
          (r.snippet ? `\n返回片段：${r.snippet}` : ''),
      );
    }
    return r.data.courseList ?? [];
  }

  /** 某门课的课件列表 */
  async fetchCourseware(ocId: number, classId: number, opts: { parentId?: number | string; pn?: number; ps?: number } = {}): Promise<CoursewareItem[]> {
    const raw = await this.getJson<{ total?: number; list?: unknown[] }>(
      YOUXUE_ENDPOINTS.courseContent(ocId, classId, opts),
    );
    const list = raw?.list;
    if (!Array.isArray(list)) return [];
    return list.map(normalizeCourseware).filter((x) => x.id > 0);
  }

  /**
   * 学生端作业列表（单门课）。
   * 实测：返回 {pn,ps,total,homeworkList}。
   */
  async fetchHomeworks(ocId: number, classId: number, pn = 1, ps = 100): Promise<HomeworkItem[]> {
    const raw = await this.getJson<{ total?: number; homeworkList?: unknown[] }>(
      YOUXUE_ENDPOINTS.studentHomeworks(ocId, classId, this.userId, pn, ps),
    );
    const list = raw?.homeworkList;
    if (!Array.isArray(list)) return [];
    return list.map(normalizeHomework).filter((x) => x.id > 0);
  }

  /**
   * 所有课程的作业（并发拉取，逐个失败不影响整体）。
   *
   * 实测：25 门课里有 9 门有作业，共 90+ 条；并发 5 时约 3 秒。
   */
  async fetchAllHomeworks(
    courses: Array<{ id: number; classId?: number; name: string }>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ items: HomeworkItem[]; warnings: string[] }> {
    const warnings: string[] = [];
    const items: HomeworkItem[] = [];
    let done = 0;
    let next = 0;
    const total = courses.length;

    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= total) return;
        const c = courses[i];
        if (!c.classId) {
          done += 1;
          onProgress?.(done, total);
          continue;
        }
        try {
          const list = await this.fetchHomeworks(c.id, c.classId);
          for (const h of list) items.push({ ...h, courseName: c.name, ocId: c.id, classId: c.classId });
        } catch {
          warnings.push(`「${c.name}」作业读取失败`);
        }
        done += 1;
        onProgress?.(done, total);
      }
    };

    await Promise.all(Array.from({ length: Math.min(5, total || 1) }, () => worker()));
    // 按"紧急度"排序：进行中 → 未开始（近期） → 已结束 → 远期未开始沉底
    items.sort(compareHomeworkUrgency);
    return { items, warnings };
  }

  /**
   * 所有课程的课件（并发拉取，逐个失败不影响整体）。
   *
   * 与 fetchAllHomeworks 同构。课件的"没看完"由 studyProgress < 100 判断。
   */
  async fetchAllCourseware(
    courses: Array<{ id: number; classId?: number; name: string }>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ items: CoursewareItem[]; warnings: string[] }> {
    const warnings: string[] = [];
    const items: CoursewareItem[] = [];
    let done = 0;
    let next = 0;
    const total = courses.length;

    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= total) return;
        const c = courses[i];
        if (!c.classId) {
          done += 1;
          onProgress?.(done, total);
          continue;
        }
        try {
          const list = await this.fetchCourseware(c.id, c.classId, { ps: 100 });
          for (const it of list) items.push({ ...it, courseName: c.name, ocId: c.id });
        } catch {
          warnings.push(`「${c.name}」课件读取失败`);
        }
        done += 1;
        onProgress?.(done, total);
      }
    };

    await Promise.all(Array.from({ length: Math.min(5, total || 1) }, () => worker()));
    return { items, warnings };
  }

  /** 课件详情 */
  async fetchCoursewareDetail(contentId: number): Promise<CoursewareDetail | null> {
    const raw = await this.getJson<Record<string, unknown>>(YOUXUE_ENDPOINTS.courseContentDetail(contentId));
    if (!raw) return null;
    const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return {
      id: num(raw.id) ?? contentId,
      title: str(raw.title) ?? str(raw.name) ?? '',
      type: num(raw.type),
      url: str(raw.url) ?? str(raw.furl),
      size: num(raw.size),
      duration: num(raw.duration),
      remark3: str(raw.remark3),
      cantDownload: num(raw.remark3) === 1,
      raw,
    };
  }
}

/**
 * 作业排序 —— 按"该不该现在处理"排，而不是简单按状态或时间。
 *
 * 为什么不能只按截止时间倒序：
 * 实测「求是读书计划」有 54 条未开始的读书心得，截止在 2029 年。
 * 单纯排序会让这些长期任务占满列表顶部，把真正紧急的挤下去。
 *
 * 分档（数字越小越靠前）：
 *   0 进行中、未提交          ← 最该处理
 *   1 进行中、已提交
 *   2 已结束、未提交          ← 错过了，需要补
 *   3 未开始                  ← 接受提交但还没到期
 *   4 已结束、已提交          ← 已完成，沉底
 *   5 其他
 *
 * 同档内：按"距离现在多远"排，近的优先（未开始的正向，已结束的反向）。
 */
function homeworkRank(h: HomeworkItem): number {
  if (h.timeState === 'ongoing') return h.submitState === 'unsubmitted' ? 0 : 1;
  if (h.timeState === 'ended') return h.submitState === 'unsubmitted' ? 2 : 4;
  if (h.timeState === 'notStarted') return 3;
  return 5;
}

export function compareHomeworkUrgency(a: HomeworkItem, b: HomeworkItem): number {
  const ra = homeworkRank(a);
  const rb = homeworkRank(b);
  if (ra !== rb) return ra - rb;

  // 同档内按距现在的距离排序
  const ea = a.endTime ?? 0;
  const eb = b.endTime ?? 0;
  // 未开始：截止越早越靠前（正向）
  if (ra === 3) return ea - eb;
  // 已结束：离现在越近越靠前（反向）
  return eb - ea;
}

/** 归一化课件项（字段名以实测为准） */
function normalizeCourseware(raw: unknown): CoursewareItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && /^\d+$/.test(v)) return Number(v);
    return undefined;
  };
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

  return {
    id: num(r.id ?? r.contentId) ?? 0,
    // 实测课件标题字段是 title
    title: str(r.title) ?? str(r.name) ?? '',
    type: num(r.type),
    resourceTypeName: str(r.resourceTypeName) ?? str(r.mimeType),
    parentId: num(r.parentId),
    isFolder: bool(r.isFolder) ?? false,
    // 实测大小字段是 contentSize
    size: num(r.contentSize ?? r.size),
    duration: num(r.duration),
    studyProgress: num(r.studyProgress ?? r.progress),
    finished: bool(r.finished) ?? num(r.studyProgress) === 100,
    cantDownload: num(r.remark3) === 1,
    viewTimes: num(r.viewTimes),
    downloadTimes: num(r.downloadTimes),
    /**
     * ★ 课件的创建/发布时间。
     *
     * ⚠️ 实测原始响应里**确实有** `createTime`（样本值 1790219564000），
     *    但原先归一化时被漏掉了 —— 结果是"最近三个月"这种按时间的筛选
     *    对课件完全没法做。
     *    多写几个候选字段名做兜底，因为这个接口改过名。
     */
    createTime: num(r.createTime ?? r.createDate ?? r.updateTime ?? r.publishTime),
  };
}

/**
 * 归一化作业项。
 * 映射依据：实测 90+ 条样本
 *   state  0 未开始 · 2 进行中 · 3 已结束 · 4 已批改 · 9 特殊
 *   status 2 未提交 · 3 已提交/已批改
 */
function normalizeHomework(raw: unknown): HomeworkItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return undefined;
  };
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

  const rawState = num(r.state);
  const rawStatus = num(r.status);
  const rawPersonStatus = num(r.personStatus);

  return {
    id: num(r.id) ?? 0,
    title: str(r.homeworkTitle) ?? str(r.title) ?? '',
    startTime: num(r.startTime),
    endTime: num(r.endTime),
    peerReviewTime: num(r.peerReviewTime),
    type: num(r.type),
    rawState,
    rawStatus,
    rawPersonStatus,
    timeState:
      rawState === 0 ? 'notStarted'
      : rawState === 2 ? 'ongoing'
      : rawState === 3 || rawState === 4 ? 'ended'
      : 'unknown',
    // ⚠️ 这张映射表是**实测校正**过的，别凭直觉改。
    //
    // 原先把 status===2 当成"未提交"，结果把**已交且已打分**的作业
    // 也显示成未提交（实测里一条 state=4 已批改、score=100 的作业 status 正是 2）。
    //
    // 横向对比多门课的真实数据后确认（每门课都同时看这三个字段）：
    //
    //   state        0=未开始（此阶段**一定**未提交）
    //                2=进行中   3/4=已结束/已批改
    //   status       2=已提交   3=已批改
    //   personStatus 1=未提交   2=已提交
    //
    // 实测样本（左为原始值，右为正确判定）：
    //   数据库 ×4     state=0 status=2 personStatus=1 → 未提交   （未开始的课）
    //   数字逻辑      state=2 status=2 personStatus=2 → 已提交
    //   人工智能 作业2 state=4 status=2 personStatus=2 → 已提交（score=30）
    //   人工智能 作业1 state=4 status=3 personStatus=2 → 已批改
    //   大学物理 ×2   state=4 status=2/3 personStatus=2 → 已提交/已批改（score=100）
    submitState:
      rawState === 0 ? 'unsubmitted'
      : rawStatus === 3 || rawPersonStatus === 3 ? 'graded'
      : rawStatus === 2 || rawPersonStatus === 2 ? 'submitted'
      : rawStatus === 1 || rawPersonStatus === 1 ? 'unsubmitted'
      : 'unknown',
    score: num(r.score),
    publisher: str(r.publisher),
    hasPeerReview: num(r.peerStatus) !== undefined,
  };
}
