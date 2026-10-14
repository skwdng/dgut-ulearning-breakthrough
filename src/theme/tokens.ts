/**
 * 设计系统 Token —— 严格对齐 ui-spec.md 第 1 节
 * 所有页面禁止硬编码颜色/字号/间距，一律从这里取。
 */

export const color = {
  primary: {
    50: '#EEF2FF',
    100: '#E0E7FF',
    200: '#C7D2FE',
    300: '#A5B4FC',
    400: '#818CF8',
    500: '#6366F1',
    600: '#4F46E5',
    700: '#4338CA',
    800: '#3730A3',
    900: '#312E81',
  },
  success: { 50: '#ECFDF5', 100: '#D1FAE5', 500: '#10B981', 600: '#059669' },
  warning: { 50: '#FFFBEB', 100: '#FEF3C7', 500: '#F59E0B', 600: '#D97706' },
  error: { 50: '#FEF2F2', 100: '#FEE2E2', 500: '#EF4444', 600: '#DC2626' },
  neutral: {
    50: '#F9FAFB',
    100: '#F3F4F6',
    200: '#E5E7EB',
    300: '#D1D5DB',
    400: '#9CA3AF',
    500: '#6B7280',
    600: '#4B5563',
    700: '#374151',
    800: '#1F2937',
    900: '#111827',
  },
  background: {
    primary: '#FFFFFF',
    secondary: '#F8F9FC',
    tertiary: '#F1F2F7',
  },
  text: {
    primary: '#111827',
    secondary: '#6B7280',
    tertiary: '#9CA3AF',
    inverse: '#FFFFFF',
  },
} as const;

export const font = {
  size: {
    h1: 28,
    h2: 24,
    h3: 20,
    title: 18,
    body: 16,
    body2: 14,
    caption: 12,
    small: 10,
  },
  weight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
  lineHeight: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.7,
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 20,
  full: 9999,
} as const;

export const shadow = {
  sm: {
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  lg: {
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  float: {
    shadowColor: color.primary[500],
    shadowOpacity: 0.25,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
} as const;

/** 状态徽章配色（签到页/课程卡用） */
export const statusTheme = {
  idle: { fg: color.success[500], bg: color.success[50], label: '监控中' },
  detecting: { fg: color.primary[500], bg: color.primary[50], label: '检测到签到' },
  submitting: { fg: color.primary[500], bg: color.primary[50], label: '提交中' },
  success: { fg: color.success[500], bg: color.success[50], label: '签到成功' },
  failed: { fg: color.error[500], bg: color.error[50], label: '签到失败' },
  need_manual: { fg: color.warning[500], bg: color.warning[50], label: '需手动签到' },
  rate_limited: { fg: color.warning[600], bg: color.warning[50], label: '已限流退避' },
  paused: { fg: color.neutral[500], bg: color.neutral[100], label: '已暂停' },
  expired: { fg: color.error[500], bg: color.error[50], label: '会话失效' },
  unbound: { fg: color.neutral[500], bg: color.neutral[100], label: '未绑定' },
} as const;

export type CheckinStateKey = keyof typeof statusTheme;
