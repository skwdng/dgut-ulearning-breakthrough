/**
 * 纯 JS 路由 —— 替代 expo-router / react-navigation。
 *
 * 为什么自己写：
 * 实测在鸿蒙（HarmonyOS）上，react-navigation 的原生栈（由 react-native-screens 提供）
 * 会让界面直接白屏且无法操作，只能大退。
 * 这个崩溃发生在**原生层**，JS 的错误边界和全局钩子都收不到。
 * 华为开发者论坛也有对应反馈：
 * https://developer.huawei.com/consumer/cn/forum/topic/0208225281800297243
 *
 * 因此改成完全不依赖原生导航的方案：
 *   - 页面栈是一个普通的 React state 数组
 *   - 所有页面都是普通组件，渲染在同一个 React 树里
 *   - 没有任何原生 Screen / Fragment 参与
 *
 * 代价：
 *   - 没有原生转场动画（自己做了淡入 + 右滑入场）
 *   - 不支持系统返回手势（用页面内返回按钮 + 安卓物理返回键兜底）
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Animated, BackHandler, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useTopInset } from '../theme/useInsets';
import { color, spacing } from '../theme/tokens';
import { Txt } from '../components';

/* ══════════════════ 类型 ══════════════════ */

/**
 * 顶层页面 key（底部滑动栏切换的那几个）。
 *
 * ⚠️ 这里**没有**小操作 ——
 *    它不是顶层页，而是**优学院**下面的二级入口（和「任务查询」同级）。
 *    见 screens/tab-youxue.tsx 与 screens/xiaocao.tsx。
 */
export type TopTabKey = 'index' | 'youxue' | 'food' | 'ai';

/** 二级页面路径 */
export type RoutePath =
  | '/settings'
  | '/profile'
  | '/schedule'
  | '/todo'
  | '/youxue-bind'
  | '/youxue-web-login'
  | '/youxue-task'
  /**
   * ★「小操作」—— 优学院下面的二级入口（和 /youxue-task 同级）。
   * ⚠️ 它**需要授权码**，门槛在 screens/xiaocao.tsx 的 `<LicensedScreen>`。
   */
  | '/xiaocao'
  | '/sign-qr'
  | '/sign-location'
  /**
   * ★ 课程签到位置设置（地图围范围，2026-10 新增）。
   *
   * ⚠️ 它是**签到类**页面（设置后影响定位签到提交什么坐标），
   *    所以在 screens.tsx 里也过了 `licensed(...)` 授权码门槛。
   */
  | '/course-location'
  | '/sign-oneshot'
  /**
   * ⚠️ `/checkin` 已删除 —— 那是「自动签到设置页」，用户明确说不要自动签到。
   *    底层 checkinStore 保留（其他 store 从这里取 account），
   *    但轮询受 autoEnabled 闸住，不开就永远不会跑。
   */
  | '/checkin-manual'
  | '/checkin-log'
  | '/modules'
  | '/license'
  | '/diagnostics'
  /**
   * ══════════════ ★★★ 这里删掉了两个路由 ══════════════
   *
   * 用户要求（2026-10）：
   *   「帮我把小操作里的接口测试器和崩溃日志还有签到功能里的接口测试删掉」
   *   → `/crash-log` 与 `/api-tester` 已删（连同页面文件）
   *
   * ⚠️ 底层能力保留：崩溃仍会记录到磁盘（crashLog.ts 的 logFault），
   *    只是不再有查看入口；要看用 /diagnostics。
   */
  /** ★ 点不中 —— 老师发起选人时别抽到我（只碰课堂互动，不碰考勤） */
  | '/dianbuzhong'
  /**
   * ★ 服务器用户管理（2026-10 新增）。
   *
   * 用户需求：「把某个账号踢出我的服务器，别人查的时候找不到我」。
   *
   * ⚠️ 这一页**不套授权码门槛**（`licensed()`）：
   *    它管的是"服务器上的账号名单"，不是签到功能；
   *    而且它自己有更强的门槛 —— **HTTP Basic 管理口令**（只存内存）。
   */
  | '/server-admin'
  /**
   * ★ 「作业 / 投票」接口探测（2026-10 新增）。
   *
   * 从「小操作」进入：只发只读 GET，读取作业 / 投票接口的真实返回，
   * 为之后做「补交作业」「改投票」打地基。
   * 授权门槛由 /xiaocao 那层的 LicensedScreen 兜着（rawApi 自身也有一道闸）。
   */
  | '/vote-homework'
  /**
   * ★ 「投票 / 答题」（2026-10 新增，真实功能页）。
   *
   * 与 `/vote-homework`（只读探测页）不同：这页会**真的提交**投票/答题，
   * 但只在活动**进行中**时允许；已结束只能看结果（事后补交不做）。
   *
   * 接口来自优学院移动端 H5 的 API 模块（见 services/interactionApi.ts 文件头），
   * 不是猜的。
   */
  | '/vote-list'
  /**
   * ★ 「课堂 id」查询（2026-10 新增）。
   *
   * 用户要求：「我怎么知道课堂 id 啊，单独加一个查看课程 id 功能，
   * 选中课程，列出这个课程以往所有的课程 id」。
   *
   * 数据来自已查到的签到记录（不额外发请求），按课程分课堂 id。
   * 点「查投票 / 答题」会带着 classroomId 跳到 `/vote-list`。
   */
  | '/classroom-ids';

export type RouteParams = Record<string, string | number | undefined>;

/* ══════════════════ 状态 ══════════════════ */

interface StackEntry {
  path: RoutePath;
  params: RouteParams;
  /** 每次 push 换新 key，保证 React 视为新实例 */
  key: string;
}

interface RouterValue {
  tab: TopTabKey;
  stack: StackEntry[];
  push: (path: RoutePath, params?: RouteParams) => void;
  replace: (path: RoutePath, params?: RouteParams) => void;
  back: () => void;
  /** 切顶层页面，并清空二级栈 */
  switchTab: (t: TopTabKey) => void;
}

const RouterCtx = createContext<RouterValue | null>(null);

/** 当前页面的参数作用域 —— 每个二级页各有一份，供 useLocalSearchParams 读取 */
const ParamsCtx = createContext<RouteParams>({});

let seq = 0;
const nextKey = () => `s${(seq += 1)}`;

export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [tab, setTab] = useState<TopTabKey>('index');
  const [stack, setStack] = useState<StackEntry[]>([]);

  const push = useCallback((path: RoutePath, params: RouteParams = {}) => {
    setStack((s) => [...s, { path, params, key: nextKey() }]);
  }, []);

  const replace = useCallback((path: RoutePath, params: RouteParams = {}) => {
    setStack((s) =>
      s.length === 0 ? [{ path, params, key: nextKey() }] : [...s.slice(0, -1), { path, params, key: nextKey() }],
    );
  }, []);

  const back = useCallback(() => {
    setStack((s) => (s.length === 0 ? s : s.slice(0, -1)));
  }, []);

  const switchTab = useCallback((t: TopTabKey) => {
    setTab(t);
    setStack([]);
  }, []);

  // 安卓物理返回键：有二级页时先退二级页，否则交给系统
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 0) {
        back();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [stack.length, back]);

  const value = useMemo<RouterValue>(
    () => ({ tab, stack, push, replace, back, switchTab }),
    [tab, stack, push, replace, back, switchTab],
  );

  return <RouterCtx.Provider value={value}>{children}</RouterCtx.Provider>;
}

export function useNavigation(): RouterValue {
  const ctx = useContext(RouterCtx);
  if (!ctx) throw new Error('useNavigation 必须在 RouterProvider 内使用');
  return ctx;
}

/**
 * 兼容 expo-router 的写法，支持两种调用：
 *   router.push('/settings')
 *   router.push({ pathname: '/checkin-manual', params: { taskId: 'x' } })
 */
export function useRouter() {
  const { push, replace, back } = useNavigation();
  return useMemo(
    () => ({
      push: (t: RoutePath | { pathname: RoutePath; params?: RouteParams }, p?: RouteParams) => {
        if (typeof t === 'string') push(t, p);
        else push(t.pathname, t.params);
      },
      replace: (t: RoutePath | { pathname: RoutePath; params?: RouteParams }, p?: RouteParams) => {
        if (typeof t === 'string') replace(t, p);
        else replace(t.pathname, t.params);
      },
      back,
    }),
    [push, replace, back],
  );
}

/** 兼容 expo-router：读当前页面参数 */
export function useLocalSearchParams<T extends RouteParams = RouteParams>(): T {
  return useContext(ParamsCtx) as T;
}

/* ══════════════════ 页面容器 ══════════════════ */

/**
 * 顶部导航条（自绘，不依赖原生 header）。
 *
 * ⚠️ 这里用 useSafeAreaInsets 显式加 paddingTop，而不是 SafeAreaView ——
 * 因为本组件被 absoluteFill 的容器包着，SafeAreaView 的 padding 会被绝对定位忽略。
 */
export function NavHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const topInset = useTopInset();
  return (
    <View style={[styles.headerSafe, { paddingTop: topInset }]}>
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          hitSlop={12}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="返回"
        >
          <Txt variant="h1" c={color.text.primary} style={{ lineHeight: 30 }}>
            ‹
          </Txt>
        </Pressable>
        <Txt variant="title" weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
          {title}
        </Txt>
        <View style={styles.backBtn} />
      </View>
    </View>
  );
}

/** 入场动画：淡入 + 轻微右滑（替代原生转场） */
function SlideIn({ children }: { children: React.ReactNode }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 190,
      useNativeDriver: true,
    }).start();
  }, [anim]);
  return (
    <Animated.View
      style={{
        flex: 1,
        opacity: anim,
        transform: [{ translateX: anim.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }) }],
      }}
    >
      {children}
    </Animated.View>
  );
}

/**
 * 一个二级页面的外层：header + 参数作用域 + 入场动画。
 * 由 NavigationShell 调用，业务页面本身不需要关心这些。
 */
export function PushedScreen({
  title,
  params,
  onBack,
  children,
}: {
  title: string;
  params: RouteParams;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.screen}>
      <NavHeader title={title} onBack={onBack} />
      <ParamsCtx.Provider value={params}>
        <SlideIn>
          <View style={{ flex: 1 }}>{children}</View>
        </SlideIn>
      </ParamsCtx.Provider>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.background.secondary },
  headerSafe: { backgroundColor: color.background.primary },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 50,
    paddingHorizontal: spacing.sm,
    backgroundColor: color.background.primary,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.neutral[200],
  },
  backBtn: { width: 44, alignItems: 'center', justifyContent: 'center' },
});
