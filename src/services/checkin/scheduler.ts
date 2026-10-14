/**
 * 轮询调度器 —— 对齐 tech-spec §4。
 *
 * 核心观点：签到是"短窗口事件"，不是"定时任务"。
 * - 热（上课时段，含前后 10 分钟缓冲）：10~15s
 * - 温（当天有课但不在时段）：3~5 分钟
 * - 冷（无课/夜间）：停止
 * 并且所有间隔都做 ±30% 抖动，避免形成固定时序指纹。
 */
import type { Course, PollPlan, PollTier } from '../../domain/types';
import { DEFAULT_POLL_PLAN } from '../../domain/types';

const HOT_BUFFER_MIN = 10;

export interface TierInput {
  now: Date;
  courses: Course[];
  plan: PollPlan;
  autoEnabled: boolean;
}

export interface TierDecision {
  tier: PollTier;
  reason: string;
  /** 下一次轮询间隔（已含抖动） */
  intervalMs: number;
  /** 本轮是否需要跳过（休眠） */
  sleeping: boolean;
}

function hhmmToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** 当前是否处于某节课的时间窗口（含缓冲） */
export function isInClassWindow(now: Date, courses: Course[]): { inClass: boolean; course?: Course } {
  const dow = now.getDay() === 0 ? 7 : now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const course of courses) {
    if (!course.autoCheckin) continue;
    for (const slot of course.schedule) {
      if (slot.dayOfWeek !== dow) continue;
      const start = hhmmToMinutes(slot.startTime) - HOT_BUFFER_MIN;
      const end = hhmmToMinutes(slot.endTime) + HOT_BUFFER_MIN;
      if (minutes >= start && minutes <= end) return { inClass: true, course };
    }
  }
  return { inClass: false };
}

function inNightSilence(now: Date, [from, to]: [number, number]): boolean {
  const h = now.getHours();
  return from > to ? h >= from || h < to : h >= from && h < to;
}

/** 加抖动：±jitterRatio，按用户维度做种子可保持"同用户稳定、跨用户不同" */
export function applyJitter(baseMs: number, ratio: number, seed = 0.5): number {
  const wave = Math.sin(seed * 12.9898) * 43758.5453;
  const r = wave - Math.floor(wave); // 0..1 伪随机但确定性
  return Math.round(baseMs * (1 + (r - 0.5) * 2 * ratio));
}

export function decideTier(input: TierInput): TierDecision {
  const { now, courses, plan, autoEnabled } = input;

  if (!autoEnabled) {
    return { tier: 'cold', reason: '用户已关闭自动签到', intervalMs: 0, sleeping: true };
  }
  if (inNightSilence(now, plan.nightSilence)) {
    return { tier: 'cold', reason: '夜间静默（省电与降低风控面）', intervalMs: 0, sleeping: true };
  }
  if (courses.length === 0) {
    return { tier: 'warm', reason: '未拉取到课程，低频兜底', intervalMs: applyJitter(5 * 60_000, plan.jitterRatio, 3), sleeping: false };
  }

  const { inClass, course } = isInClassWindow(now, courses);
  if (inClass) {
    const base = plan.tier === 'hot' ? Math.min(plan.baseIntervalMs, 15000) : 15000;
    return {
      tier: 'hot',
      reason: `上课时段（${course?.name ?? ''}）→ 高频检测`,
      intervalMs: applyJitter(base, plan.jitterRatio, course?.name.length ?? 7),
      sleeping: false,
    };
  }

  const todayHasClass = courses.some(
    (c) => c.autoCheckin && c.schedule.some((s) => s.dayOfWeek === (now.getDay() === 0 ? 7 : now.getDay())),
  );
  if (todayHasClass) {
    return {
      tier: 'warm',
      reason: '今日有课，时段外低频兜底',
      intervalMs: applyJitter(4 * 60_000, plan.jitterRatio, 5),
      sleeping: false,
    };
  }

  return { tier: 'cold', reason: '今日无课', intervalMs: 0, sleeping: true };
}

/** 提交前的随机延迟：检测到窗口后不要 0 秒内提交 */
export function submitDelay(plan: PollPlan): number {
  if (!plan.randomDelayEnabled) return 0;
  const [min, max] = plan.submitDelayMs;
  return Math.round(min + Math.random() * (max - min));
}

export { DEFAULT_POLL_PLAN };
