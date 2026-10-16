/**
 * 签到 adapter 契约层。
 *
 * 为什么要有这一层：
 * 1. 优学院是多租户 SaaS，不同学校域名/参数不同 → 每个学校一个 adapter；
 * 2. 现阶段先用 mock adapter 打通全部页面与状态机，真实接口一到位只换实现；
 * 3. 若将来改为接入第三方签到服务，也只需新增一个 adapter，UI 零改动。
 */
import type {
  CheckinError,
  Course,
  PollPlan,
  RollcallTask,
  SessionState,
  SignType,
  TenantCode,
  YouxueAccount,
} from '../../domain/types';

/** 登录过程中需要人工介入时抛出/返回的中断信号 */
export interface NeedMfaSignal {
  kind: 'need_mfa';
  /** 回传给学生端，用于继续登录 */
  continuation: string;
  hint: string;
}

export interface BindResult {
  ok: boolean;
  account?: YouxueAccount;
  needMfa?: NeedMfaSignal;
  error?: CheckinError;
}

/** 一次检测的结果 */
export interface DetectResult {
  /** 新发现的待签到活动 */
  found: RollcallTask[];
  /** 已知但窗口已关闭/已完成的 */
  closed: RollcallTask[];
  /** 会话是否仍有效 */
  sessionState: SessionState;
}

/** 提交参数（数字码/二维码/坐标按需给） */
export interface SubmitPayload {
  task: RollcallTask;
  signCode?: string;
  qrPayload?: string;
  location?: { latitude: number; longitude: number; accuracy?: number };
}

export interface SubmitResult {
  ok: boolean;
  confirmedAt?: number;
  error?: CheckinError;
}

/** 账号密码登录入参 */
export interface PasswordLoginInput {
  tenant: TenantCode;
  studentId: string;
  password: string;
  /**
   * 姓名（用户填写）。
   * 优学院登录接口不需要姓名，这里只是为了在本地账号上显示"这是谁"。
   * 不填也能登录。
   */
  studentName?: string;
}

/** 会话导入入参（WebView 抓到的 Cookie） */
export interface SessionImportInput {
  tenant: TenantCode;
  studentId: string;
  /** name -> value，大小写敏感，禁止归一化 */
  cookies: Record<string, string>;
  userAgent?: string;
  /** 姓名（可选，仅用于本地显示） */
  studentName?: string;
}

/**
 * 签到服务适配器。
 * 真实实现必须遵守 tech-spec §5 的请求头一致性与 §6 的节流要求。
 */
export interface CheckinAdapter {
  readonly id: string;
  readonly tenant: TenantCode;

  // ---- 认证 ----
  loginWithPassword(input: PasswordLoginInput): Promise<BindResult>;
  /** 提交短信验证码，续跑被 MFA 中断的登录 */
  submitMfa(continuation: string, code: string): Promise<BindResult>;
  importSession(input: SessionImportInput): Promise<BindResult>;
  /** 会话健康检查（冷启动/轮询前调用，需按 5 分钟节流） */
  probeSession(account: YouxueAccount): Promise<SessionState>;
  unbind(accountId: string): Promise<void>;

  // ---- 数据 ----
  /**
   * 拉课程列表。
   *
   * ⚠️ `prev` 是**上一次的课程数组** —— 实现方**必须**把它里面
   *    属于本地的字段合并回来（`location` 签到位置、`autoCheckin` 课程开关）。
   *
   *    原因见 youxueAdapter.fetchCourses 的注释：服务端**不返回**这两个字段，
   *    不合并就会"每次查课程都把用户设置清掉"——
   *    用户圈好的签到范围会莫名其妙消失，关掉的课程会自己开回来。
   */
  fetchCourses(account: YouxueAccount, prev?: Course[]): Promise<Course[]>;
  fetchStats(account: YouxueAccount): Promise<{ todayDone: number; todayTotal: number; successRate: number; streakDays: number }>;
  fetchHistory(account: YouxueAccount, limit?: number): Promise<RollcallTask[]>;

  // ---- 签到 ----
  detect(account: YouxueAccount, courses: Course[]): Promise<DetectResult>;
  submit(account: YouxueAccount, payload: SubmitPayload): Promise<SubmitResult>;

  /** 该 adapter 支持的签到方式（用于 UI 提前告知可自动化程度） */
  supportedSignTypes(): SignType[];

  /** 轮询计划（不同平台/学校可覆盖） */
  pollPlan(): PollPlan;
}

/** adapter 工厂签名 */
export type AdapterFactory = (tenant: TenantCode) => CheckinAdapter;
