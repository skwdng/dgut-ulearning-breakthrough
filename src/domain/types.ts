/**
 * 领域模型 —— 对齐 ui-spec.md 第 6 节，并按签到自动化需要做了扩展。
 */

export type TenantCode = 'dgut';

/** 会话状态 */
export type SessionState = 'valid' | 'expired' | 'unknown';

/** 绑定方式 */
export type AuthMode = 'session' | 'password' | 'manual';

/** 整机能力自检结果（决定哪些签到类型可用） */
export interface Capabilities {
  mockLocation: boolean;
  backgroundKeepAlive: boolean;
  notification: boolean;
  camera: boolean;
}

/** 优学院账号 */
export interface YouxueAccount {
  id: string;
  tenant: TenantCode;
  studentId: string;
  studentName?: string;
  school?: string;
  /**
   * 优学院的数字 userId（如 90990001）。
   *
   * ⚠️ 与学号不是一回事：学号形如 2099000000116，而接口要的是数字 userId。
   *    做「只能改自己的签到」这类判断时必须用它比对 ——
   *    教师接口 `signByTea` 的 userID 就是数字，服务端不检查"你是不是在改自己"。
   *    拿不到时（老凭据里没有）为 undefined，调用方应保守拒绝。
   */
  userId?: number;
  sessionState: SessionState;
  authMode: AuthMode;
  boundAt: number;
  lastProbeAt?: number;
  lastProbeOk?: boolean;
  capabilities: Capabilities;
}

/** 签到方式 —— 覆盖优学院已知类型 */
export type SignType =
  | 'normal'
  | 'number'
  | 'qrcode'
  | 'location'
  | 'gesture'
  | 'photo'
  | 'unknown';

/**
 * 签到动作语义。
 *
 * 实测结论（见 recon-report.md）：普通/扫码/数字/手势签到在服务端**不需要提交业务参数**，
 * 本质是"把该学生标记为已签"（状态变更）；只有定位签到必须带坐标。
 * 因此模型里区分 sign / unsign（对应"开启/取消签到"），而不是"提交表单"。
 */
export type SignAction = 'sign' | 'unsign';

/** 可全自动的签到类型（其余需要人工介入） */
export const AUTO_SIGN_TYPES: SignType[] = ['normal', 'number', 'location', 'gesture'];

export const SIGN_TYPE_LABEL: Record<SignType, string> = {
  normal: '一键签到',
  number: '数字签到',
  qrcode: '二维码签到',
  location: '定位签到',
  gesture: '手势签到',
  photo: '拍照签到',
  unknown: '未知方式',
};

/** 任务状态机 —— 对齐 tech-spec §7.1 */
export type TaskState =
  | 'idle'
  | 'detecting'
  | 'submitting'
  | 'success'
  | 'failed'
  | 'need_manual'
  | 'rate_limited'
  | 'paused';

/** 错误码 —— 对齐 tech-spec §8.4 */
export type ErrorCode =
  | 'E_SESSION_EXPIRED'
  | 'E_MFA_REQUIRED'
  | 'E_WINDOW_CLOSED'
  | 'E_ALREADY_SIGNED'
  | 'E_CODE_INVALID'
  | 'E_OUT_OF_RANGE'
  | 'E_SIGNATURE'
  | 'E_RATE_LIMITED'
  | 'E_NETWORK'
  | 'E_UNKNOWN';

export interface CheckinError {
  code: ErrorCode;
  message: string;
  /** 是否可自动重试 */
  retryable: boolean;
  /** 建议用户动作（用于 UI 文案） */
  suggestion?: string;
}

/** 一次签到任务/记录 */
export interface RollcallTask {
  id: string;
  accountId: string;
  courseId: string;
  courseName: string;
  teacher?: string;
  location?: string;
  rollcallId?: string;
  signType: SignType;
  state: TaskState;
  windowStart?: number;
  windowEnd?: number;
  attempts: number;
  lastError?: CheckinError;
  submittedAt?: number;
  confirmedAt?: number;
  method: 'auto' | 'manual';
}

/** 课程 */
export interface Course {
  id: string;
  name: string;
  teacher: string;
  /** 课程维度独立开关；关闭后该课不参与自动签到 */
  autoCheckin: boolean;
  /** 常用签到位置（定位签到用） */
  location?: { latitude: number; longitude: number; address?: string; radius?: number };
  schedule: Array<{
    dayOfWeek: number; // 1-7
    startTime: string; // "10:00"
    endTime: string; // "11:40"
    location?: string;
  }>;
  totalCheckins: number;
  completedCheckins: number;
}

/** 轮询计划 —— 对齐 tech-spec §4.2 */
export type PollTier = 'hot' | 'warm' | 'cold';

export interface PollPlan {
  tier: PollTier;
  baseIntervalMs: number;
  jitterRatio: number;
  submitDelayMs: [number, number];
  dailySubmitCap: number;
  nightSilence: [number, number]; // 小时，[23, 7]
  randomDelayEnabled: boolean;
}

export const DEFAULT_POLL_PLAN: PollPlan = {
  tier: 'hot',
  baseIntervalMs: 15000,
  jitterRatio: 0.3,
  submitDelayMs: [3000, 25000],
  dailySubmitCap: 60,
  nightSilence: [23, 7],
  randomDelayEnabled: true,
};

/** 统计 */
export interface CheckinStats {
  todayDone: number;
  todayTotal: number;
  successRate: number;
  streakDays: number;
}

/** 首页概览 */
export interface HomeOverview {
  todoCount: number;
  scheduleCount: number;
  progress: number;
}
