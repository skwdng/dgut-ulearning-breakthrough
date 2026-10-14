/**
 * 安全区（顶部/底部留白）—— 带兜底。
 *
 * ⚠️ 踩过的坑：
 *   鸿蒙上 `react-native-safe-area-context` 的 `useSafeAreaInsets()` 会返回 **0**，
 *   即使 JS 和原生代码都在包里（已用 tools/diag-safearea.cjs 确认）。
 *   结果是页面被状态栏压住 —— 首页的问候语、优学院页的卡片都被盖掉一截。
 *
 * 所以这里不单靠那个 Provider：
 *   1. 优先用 Provider 给的 inset（Android / iOS 正常时是准的）
 *   2. Provider 给 0 时，退回 `StatusBar.currentHeight`（Android 上可靠）
 *   3. 都没有时给一个最小值，保证至少不贴边
 *
 * 用最大值而不是"非零即用"，是为了避免某个来源给了偏小的值时又贴边。
 */
import { Platform, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** 顶部最小留白（dp）——任何来源都拿不到时用它 */
const MIN_TOP = 24;
/** 底部最小留白 */
const MIN_BOTTOM = 8;

/** Android 状态栏高度，拿不到时是 0 */
function androidStatusBarHeight(): number {
  if (Platform.OS !== 'android') return 0;
  const h = StatusBar.currentHeight;
  return typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : 0;
}

/**
 * 顶部安全区高度。
 * @param extra 额外再加多少（默认给一点呼吸空间）
 */
export function useTopInset(extra = 8): number {
  const insets = useSafeAreaInsets();
  const fromProvider = Number.isFinite(insets.top) ? insets.top : 0;
  const fallback = androidStatusBarHeight();
  return Math.max(fromProvider, fallback, MIN_TOP) + extra;
}

/** 底部安全区高度 */
export function useBottomInset(extra = 0): number {
  const insets = useSafeAreaInsets();
  const fromProvider = Number.isFinite(insets.bottom) ? insets.bottom : 0;
  return Math.max(fromProvider, MIN_BOTTOM) + extra;
}
