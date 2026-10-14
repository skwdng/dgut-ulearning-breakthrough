/**
 * 错误码 → UI 文案与处置策略。
 * 对齐 tech-spec §8.4：错误必须能被用户看懂，并且知道下一步做什么。
 */
import type { CheckinError, ErrorCode } from '../../domain/types';

export const ERROR_META: Record<
  ErrorCode,
  { title: string; suggestion: string; retryable: boolean }
> = {
  E_SESSION_EXPIRED: {
    title: '登录已过期',
    suggestion: '优学院会话失效，请重新绑定账号',
    retryable: false,
  },
  E_MFA_REQUIRED: {
    title: '学校要求短信验证',
    suggestion: '请输入收到的短信验证码以继续',
    retryable: true,
  },
  E_WINDOW_CLOSED: {
    title: '签到已结束',
    suggestion: '本次签到窗口已关闭，无法补签',
    retryable: false,
  },
  E_ALREADY_SIGNED: {
    title: '已完成签到',
    suggestion: '无需重复签到',
    retryable: false,
  },
  E_CODE_INVALID: {
    title: '签到码不正确',
    suggestion: '请重新输入教师给出的数字码，或重新扫码',
    retryable: true,
  },
  E_OUT_OF_RANGE: {
    title: '定位不在签到范围',
    suggestion: '请检查课程签到位置设置，或手动到范围内签到',
    retryable: true,
  },
  E_SIGNATURE: {
    title: '接口已更新',
    suggestion: '优学院接口参数可能变更，请升级 App 或等待适配更新',
    retryable: true,
  },
  E_RATE_LIMITED: {
    title: '操作过于频繁',
    suggestion: '已自动退避，稍后恢复；期间请勿频繁手动重试',
    retryable: true,
  },
  E_NETWORK: {
    title: '网络异常',
    suggestion: '请检查网络后重试，已自动重试若干次',
    retryable: true,
  },
  E_UNKNOWN: {
    title: '签到失败',
    suggestion: '已记录诊断信息，可在签到日志中查看并反馈',
    retryable: true,
  },
};

export function makeError(code: ErrorCode, message?: string): CheckinError {
  const meta = ERROR_META[code];
  return {
    code,
    message: message ?? meta.title,
    retryable: meta.retryable,
    suggestion: meta.suggestion,
  };
}

/** 把服务端返回的任意错误翻译成标准错误码 */
export function mapServerError(raw: unknown): CheckinError {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  const dict: Array<[RegExp, ErrorCode]> = [
    [/登录|未登录|会话|token|401|unauthor/i, 'E_SESSION_EXPIRED'],
    [/验证码|多因子|mfa|reauth/i, 'E_MFA_REQUIRED'],
    [/已签到|重复签到|already/i, 'E_ALREADY_SIGNED'],
    [/结束|关闭|超时|过期|closed|expired/i, 'E_WINDOW_CLOSED'],
    [/签到码|数字|口令|错误|invalid/i, 'E_CODE_INVALID'],
    [/范围|定位|距离|location/i, 'E_OUT_OF_RANGE'],
    [/签名|参数|sign|param/i, 'E_SIGNATURE'],
    [/频繁|限流|429|too many/i, 'E_RATE_LIMITED'],
    [/网络|超时|timeout|network/i, 'E_NETWORK'],
  ];
  for (const [re, code] of dict) {
    if (re.test(text)) return makeError(code, text.slice(0, 200));
  }
  return makeError('E_UNKNOWN', text.slice(0, 200));
}

/**
 * 退避策略：失败重试 3 次，间隔 2s / 8s / 30s（指数 + 抖动）
 * 限流命中 → 退避 5 分钟；连续 3 次 → 熔断 30 分钟。
 */
export function backoffMs(attempt: number): number {
  const table = [2000, 8000, 30000];
  const base = table[Math.min(attempt, table.length - 1)];
  return Math.round(base * (1 + (Math.random() - 0.5) * 0.3));
}

export const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
export const CIRCUIT_BREAK_MS = 30 * 60 * 1000;
export const CIRCUIT_THRESHOLD = 3;
