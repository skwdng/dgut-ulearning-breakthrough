/**
 * Mock 适配器 —— 无需任何真实账号即可跑通全流程。
 *
 * 设计目标：把真实世界里"检测 → 延迟 → 提交 → 失败/成功"的时序真实地演出来，
 * 这样 UI 的每一个状态（含 need_manual / failed / rate_limited）都能被肉眼验证。
 *
 * 行为：
 * - 绑定后返回一份课表；
 * - 开启监控后，在"上课时段内"按概率起一个签到窗口（默认 3 分钟）；
 * - 也支持 devTriggerRollcall() 手动立刻制造一个窗口，方便演示与测试；
 * - 按 signType 表现不同：normal/number/location 可自动；qrcode/gesture 需人工。
 */
import type {
  CheckinAdapter,
  BindResult,
  DetectResult,
  SessionImportInput,
  SubmitPayload,
  SubmitResult,
  PasswordLoginInput,
} from './types';
import type {
  Course,
  PollPlan,
  RollcallTask,
  SessionState,
  SignType,
  TenantCode,
  YouxueAccount,
} from '../../domain/types';
import { DEFAULT_POLL_PLAN } from '../../domain/types';
import { makeError } from './errors';
import { store, STORE_KEYS } from '../storage';

/**
 * 凭据结构。
 * ⚠️ 和 youxueAdapter 里的那个保持一致（那个没有导出，这里单独声明一份，
 * 避免为了共享一个内部类型而改动真实适配器的导出面）。
 */
interface StoredCredential {
  mode: 'session' | 'password';
  studentId: string;
  cookies: Record<string, string>;
  userAgent?: string;
  userId?: number;
}

const MOCK_STUDENT_ID = '2024xxxxxx';
const WINDOW_MS = 3 * 60 * 1000;

interface MockRollcall {
  rollcallId: string;
  courseId: string;
  courseName: string;
  signType: SignType;
  code?: string;
  windowStart: number;
  windowEnd: number;
  signed: boolean;
}

export interface MockAdapterOptions {
  /** 每次 submit 的失败概率（用于验证失败态与退避），默认 0 */
  failRate?: number;
  /** 限流概率（用于验证 rate_limited），默认 0 */
  rateLimitRate?: number;
  /** 自动起窗口的概率系数（0 关掉自动，全部手动触发） */
  autoWindowChance?: number;
}

export class MockCheckinAdapter implements CheckinAdapter {
  readonly id = 'mock';
  tenant: TenantCode;
  private account?: YouxueAccount;
  private courses: Course[] = [];
  private rollcalls = new Map<string, MockRollcall>();
  private opts: Required<MockAdapterOptions>;
  private recentSubmits: number[] = [];

  constructor(tenant: TenantCode, options: MockAdapterOptions = {}) {
    this.tenant = tenant;
    this.opts = {
      failRate: options.failRate ?? 0,
      rateLimitRate: options.rateLimitRate ?? 0,
      autoWindowChance: options.autoWindowChance ?? 0.35,
    };
  }

  // ---------------- 认证 ----------------

  async loginWithPassword(input: PasswordLoginInput): Promise<BindResult> {
    // 真实实现会走 CAS（salt → AES-CBC 加密 → MFA），mock 直接放行
    await delay(600);
    if (input.password.length < 4) {
      return { ok: false, error: makeError('E_MFA_REQUIRED', '密码过短（mock 校验）') };
    }
    return await this.finishBind(input.studentId, input.studentName);
  }

  async submitMfa(_continuation: string, code: string): Promise<BindResult> {
    await delay(400);
    if (!/^\d{4,6}$/.test(code)) {
      return { ok: false, error: makeError('E_MFA_REQUIRED', '验证码格式不正确') };
    }
    return await this.finishBind(MOCK_STUDENT_ID);
  }
  async importSession(input: SessionImportInput): Promise<BindResult> {
    await delay(500);
    const hasAuth = Object.keys(input.cookies).some((k) => /authorization|jsessionid|token/i.test(k));
    if (!hasAuth) {
      return { ok: false, error: makeError('E_SESSION_EXPIRED', '未从会话中找到登录凭据（mock 校验）') };
    }
    return await this.finishBind(input.studentId, input.studentName);
  }

  private async finishBind(studentId: string, studentName?: string): Promise<BindResult> {
    this.account = {
      id: `mock-${studentId}`,
      tenant: this.tenant,
      studentId,
      studentName: studentName?.trim() || '测试同学',
      school: '东莞理工学院',
      sessionState: 'valid',
      authMode: 'session',
      boundAt: Date.now(),
      lastProbeAt: Date.now(),
      lastProbeOk: true,
      capabilities: {
        mockLocation: true,
        backgroundKeepAlive: false,
        notification: true,
        camera: true,
      },
    };
    this.courses = buildMockCourses();

    // ⚠️ 必须也写一份凭据！
    // 之前 mock 不写凭据，导致"任务查询/签到"读不到 cred 而报"未绑定"，
    // 但账号本身又存在 —— 表现就是"明明绑定了却说未绑定"，极难排查。
    // 现在 mock 也写，保证两种适配器下数据流一致。
    await store.set(`${STORE_KEYS.account}.cred.${this.account.id}`, {
      mode: 'session',
      studentId,
      cookies: { AUTHORIZATION: 'mock-token', USER_INFO: encodeURIComponent(JSON.stringify({ userId: 1, studentId })) },
      userAgent: 'mock',
      userId: 1,
    } satisfies StoredCredential);

    return { ok: true, account: this.account };
  }

  async probeSession(_account: YouxueAccount): Promise<SessionState> {
    await delay(200);
    return this.account ? 'valid' : 'expired';
  }

  async unbind(_accountId: string): Promise<void> {
    this.account = undefined;
    this.courses = [];
    this.rollcalls.clear();
  }

  // ---------------- 数据 ----------------

  /**
   * ⚠️ `prev` 用于**保留本地字段**（location / autoCheckin）——
   *    与真实实现 youxueAdapter.fetchCourses 行为一致。
   *    mock 的课程是内存里造的本来就不会丢，但接口必须一致，
   *    否则真实实现改了签名而 mock 没改会编译不过。
   */
  async fetchCourses(_account: YouxueAccount, prev?: Course[]): Promise<Course[]> {
    await delay(300);
    if (this.courses.length === 0) this.courses = buildMockCourses();
    if (!prev?.length) return this.courses;
    const prevById = new Map(prev.map((c) => [c.id, c]));
    return this.courses.map((c) => {
      const old = prevById.get(c.id);
      return old ? { ...c, location: old.location, autoCheckin: old.autoCheckin } : c;
    });
  }

  async fetchStats(_account: YouxueAccount) {
    await delay(200);
    return {
      todayDone: 2,
      todayTotal: 3,
      successRate: 0.985,
      streakDays: 15,
    };
  }

  async fetchHistory(_account: YouxueAccount, limit = 20): Promise<RollcallTask[]> {
    await delay(300);
    const courses = await this.fetchCourses(_account);
    const now = Date.now();
    return Array.from({ length: Math.min(limit, 12) }).map((_, i) => {
      const c = courses[i % courses.length];
      const at = now - i * 26 * 60 * 60 * 1000;
      const failed = i === 4;
      return {
        id: `hist-${i}`,
        accountId: this.account?.id ?? 'mock',
        courseId: c.id,
        courseName: c.name,
        teacher: c.teacher,
        location: c.schedule[0]?.location,
        signType: (['normal', 'number', 'location', 'qrcode'] as SignType[])[i % 4],
        state: failed ? 'failed' : 'success',
        attempts: failed ? 3 : 1,
        lastError: failed ? makeError('E_OUT_OF_RANGE') : undefined,
        submittedAt: at,
        confirmedAt: failed ? undefined : at + 4200,
        method: 'auto',
      } satisfies RollcallTask;
    });
  }

  // ---------------- 签到 ----------------

  async detect(account: YouxueAccount, courses: Course[]): Promise<DetectResult> {
    await delay(250);
    const now = Date.now();
    const found: RollcallTask[] = [];
    const closed: RollcallTask[] = [];

    // 1) 按课表概率自动起窗口（每个课程每个时段最多一次）
    for (const course of courses) {
      if (!course.autoCheckin) continue;
      if (!this.hasRollcallFor(course.id) && this.shouldAutoOpen(course, now)) {
        this.openRollcall(course, now);
      }
    }

    // 2) 汇总活跃窗口
    for (const rc of this.rollcalls.values()) {
      const course = courses.find((c) => c.id === rc.courseId);
      const task = toTask(rc, course, account.id);
      if (now > rc.windowEnd) {
        closed.push({ ...task, state: 'failed', lastError: makeError('E_WINDOW_CLOSED') });
        continue;
      }
      if (!rc.signed) found.push(task);
    }

    // 清理过期窗口
    for (const [id, rc] of this.rollcalls) {
      if (Date.now() > rc.windowEnd + 60_000) this.rollcalls.delete(id);
    }

    return { found, closed, sessionState: 'valid' };
  }

  async submit(_account: YouxueAccount, payload: SubmitPayload): Promise<SubmitResult> {
    const { task, signCode, qrPayload, location } = payload;
    this.recentSubmits = this.recentSubmits.filter((t) => Date.now() - t < 60_000);
    this.recentSubmits.push(Date.now());

    // 提交也要花时间：模拟服务端往返
    await delay(400 + Math.random() * 600);

    if (this.recentSubmits.length > 10) {
      return { ok: false, error: makeError('E_RATE_LIMITED', '请求过于频繁（mock 触发）') };
    }
    if (Math.random() < this.opts.rateLimitRate) {
      return { ok: false, error: makeError('E_RATE_LIMITED', '服务端返回 429（mock）') };
    }
    if (Math.random() < this.opts.failRate) {
      return { ok: false, error: makeError('E_NETWORK', '网络抖动（mock）') };
    }

    const rc = task.rollcallId ? this.rollcalls.get(task.rollcallId) : undefined;
    if (!rc) return { ok: false, error: makeError('E_WINDOW_CLOSED', '窗口不存在（mock）') };
    if (Date.now() > rc.windowEnd) return { ok: false, error: makeError('E_WINDOW_CLOSED', '窗口已关闭（mock）') };
    if (rc.signed) return { ok: true, confirmedAt: Date.now() };

    if (rc.signType === 'number') {
      if (!signCode) return { ok: false, error: makeError('E_CODE_INVALID', '缺少数字码') };
      if (signCode !== rc.code) {
        return { ok: false, error: makeError('E_CODE_INVALID', `数字码错误，教师给出的是 ${rc.code}（mock 提示）`) };
      }
    }
    if (rc.signType === 'qrcode' && !qrPayload) {
      return { ok: false, error: makeError('E_CODE_INVALID', '缺少二维码内容') };
    }
    if (rc.signType === 'location') {
      if (!location) return { ok: false, error: makeError('E_OUT_OF_RANGE', '缺少定位') };
    }

    rc.signed = true;
    return { ok: true, confirmedAt: Date.now() };
  }

  supportedSignTypes(): SignType[] {
    return ['normal', 'number', 'location', 'gesture', 'qrcode'];
  }

  pollPlan(): PollPlan {
    return { ...DEFAULT_POLL_PLAN, baseIntervalMs: 10000 };
  }

  // ---------------- 演示/测试辅助 ----------------

  /** 立刻制造一个签到窗口（演示与手工测试用） */
  devTriggerRollcall(signType: SignType = 'normal'): RollcallTask | undefined {
    const course = this.courses.find((c) => c.autoCheckin) ?? this.courses[0];
    if (!course) return undefined;
    const rc = this.openRollcall(course, Date.now(), signType);
    return toTask(rc, course, this.account?.id ?? 'mock');
  }

  /** 让某个窗口剩余时间变成只剩 ms 毫秒，用于验证窗口关闭 */
  devShortenWindow(rollcallId: string, ms: number): void {
    const rc = this.rollcalls.get(rollcallId);
    if (rc) rc.windowEnd = Date.now() + ms;
  }

  get currentCodeHint(): string | undefined {
    for (const rc of this.rollcalls.values()) {
      if (!rc.signed && rc.signType === 'number') return `mock 数字码：${rc.code}`;
    }
    return undefined;
  }

  // ---------------- 内部 ----------------

  private hasRollcallFor(courseId: string): boolean {
    for (const rc of this.rollcalls.values()) {
      if (rc.courseId === courseId && Date.now() < rc.windowEnd + 30 * 60_000) return true;
    }
    return false;
  }

  private shouldAutoOpen(course: Course, now: number): boolean {
    if (this.opts.autoWindowChance <= 0) return false;
    const d = new Date(now);
    const dow = d.getDay() === 0 ? 7 : d.getDay();
    const minutes = d.getHours() * 60 + d.getMinutes();
    const slot = course.schedule.find((s) => s.dayOfWeek === dow);
    if (!slot) return false;
    const [sh, sm] = slot.startTime.split(':').map(Number);
    const startMin = sh * 60 + sm;
    // 上课后 5~20 分钟内随机起一次
    const delta = minutes - startMin;
    if (delta < 5 || delta > 20) return false;
    // 用 courseId 派生确定性伪随机，避免每次 detect 都掷骰子
    const seed = (course.id.length * 7 + delta) % 100;
    return seed / 100 < this.opts.autoWindowChance;
  }

  private openRollcall(course: Course, now: number, forceType?: SignType): MockRollcall {
    const pool: SignType[] = ['normal', 'number', 'location', 'qrcode'];
    const signType = forceType ?? pool[this.rollcalls.size % pool.length];
    const rc: MockRollcall = {
      rollcallId: `rc-${course.id}-${now}`,
      courseId: course.id,
      courseName: course.name,
      signType,
      code: signType === 'number' ? String(1000 + Math.floor(Math.random() * 9000)) : undefined,
      windowStart: now,
      windowEnd: now + WINDOW_MS,
      signed: false,
    };
    this.rollcalls.set(rc.rollcallId, rc);
    return rc;
  }
}

function toTask(rc: MockRollcall, course: Course | undefined, accountId: string): RollcallTask {
  return {
    id: rc.rollcallId,
    accountId,
    courseId: rc.courseId,
    courseName: rc.courseName,
    teacher: course?.teacher,
    location: course?.schedule.find((s) => s.location)?.location,
    rollcallId: rc.rollcallId,
    signType: rc.signType,
    state: 'detecting',
    windowStart: rc.windowStart,
    windowEnd: rc.windowEnd,
    attempts: 0,
    method: 'auto',
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 一份贴近真实形态的课表 */
export function buildMockCourses(): Course[] {
  return [
    {
      id: 'c1',
      name: '高等数学A',
      teacher: '张教授',
      autoCheckin: true,
      location: { latitude: 22.9015, longitude: 113.8182, address: '教学楼A-301', radius: 120 },
      schedule: [{ dayOfWeek: 1, startTime: '10:00', endTime: '11:40', location: '教学楼A-301' }],
      totalCheckins: 15,
      completedCheckins: 12,
    },
    {
      id: 'c2',
      name: '大学英语',
      teacher: '李老师',
      autoCheckin: true,
      location: { latitude: 22.9021, longitude: 113.8177, address: '外语楼-102', radius: 100 },
      schedule: [{ dayOfWeek: 2, startTime: '14:30', endTime: '16:10', location: '外语楼-102' }],
      totalCheckins: 15,
      completedCheckins: 10,
    },
    {
      id: 'c3',
      name: '程序设计基础',
      teacher: '王教授',
      autoCheckin: true,
      location: { latitude: 22.9008, longitude: 113.819, address: '实验楼B-205', radius: 150 },
      schedule: [{ dayOfWeek: 3, startTime: '08:00', endTime: '09:40', location: '实验楼B-205' }],
      totalCheckins: 15,
      completedCheckins: 14,
    },
  ];
}
