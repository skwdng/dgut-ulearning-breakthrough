/**
 * 导航外壳 —— 把页面栈渲染成普通 View 树。
 *
 * 关键：**完全不使用原生导航组件**
 * （没有 @react-navigation/*、没有 react-native-screens）。
 * 鸿蒙上原生栈会导致整屏白屏且无法操作，详见 src/nav/router.tsx 的说明。
 *
 * 布局管理：
 *   - 顶层四个页面全部挂载，用 display:'none' 控制显隐（保留各自滚动位置）
 *   - 二级页面按栈顺序叠在上面，只给栈顶的加 pointerEvents:'auto'
 *   - 底部滑动栏始终固定在最下方
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';
import { BottomRail, type RailTab } from '../components/TopRail';
import { color, spacing } from '../theme/tokens';
import { useBottomInset, useTopInset } from '../theme/useInsets';
import { useModules } from '../state/moduleStore';
import { useNavigation, useRouter, PushedScreen, type TopTabKey } from './router';
import { PUSHED_SCREENS } from './screens';
import { TAB_SCREENS } from './tabs';

/**
 * 底部栏的页面。
 *
 * ⚠️ `moduleKey` 存在的项表示"这一页是一个功能模块" ——
 *    它可见与否**完全由模块开关决定**（用户在「设置 → 功能模块」里控制）。
 *    没有 `moduleKey` 的（首页 / 外卖 / AI）常驻。
 *
 * ⚠️ **「小操作」不在这里** ——
 *    它是「优学院」下面的二级入口（和「任务查询」同级），
 *    见 screens/tab-youxue.tsx 与 screens/xiaocao.tsx。
 */
const TABS: Array<RailTab & { key: TopTabKey; moduleKey?: string }> = [
  { key: 'index', label: '首页' },
  { key: 'youxue', label: '优学院', moduleKey: 'youxue' },
  { key: 'food', label: '外卖' },
  { key: 'ai', label: 'AI' },
];

/** 二级页面层：按栈顺序渲染，只有栈顶可交互 */
function PushedLayer() {
  const { stack } = useNavigation();
  const router = useRouter();

  if (stack.length === 0) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {stack.map((entry, i) => {
        const isTop = i === stack.length - 1;
        const def = PUSHED_SCREENS[entry.path];
        if (!def) return null;
        const { Component, title } = def;

        return (
          <View
            key={entry.key}
            style={[StyleSheet.absoluteFill, styles.page]}
            pointerEvents={isTop ? 'auto' : 'none'}
          >
            <PushedScreen title={title} params={entry.params} onBack={router.back}>
              <Component params={entry.params} isTop={isTop} />
            </PushedScreen>
          </View>
        );
      })}
    </View>
  );
}

export function NavigationShell() {
  const { tab, switchTab } = useNavigation();
  const router = useRouter();
  const topInset = useTopInset();
  const bottomInset = useBottomInset();
  const modules = useModules();

  /**
   * 底部栏可见的页面。
   *
   * ⚠️ 有 `moduleKey` 的页**必须**对应一个可见的模块 ——
   *    否则会出现"设置里关了这个功能，底部栏却还在"的矛盾状态。
   *    没有 moduleKey 的常驻显示。
   */
  const tabs = useMemo(
    () =>
      TABS.filter(
        (t) => !t.moduleKey || modules.visible.some((r) => r.def.key === t.moduleKey),
      ),
    [modules.visible],
  );

  // 当前页被关掉时（比如刚把优学院关了），自动退回首页，避免白屏
  useEffect(() => {
    if (!tabs.some((t) => t.key === tab)) switchTab('index');
  }, [tabs, tab, switchTab]);

  const activeKey = tabs.some((t) => t.key === tab) ? tab : 'index';
  const Screen = TAB_SCREENS[activeKey];

  const activeIndex = tabs.findIndex((t) => t.key === activeKey);

  /**
   * 左右滑动切页。
   *
   * 需求：**滑动时不跟手，滑完了才切换**。
   * 所以这里只累积位移、不做实时跟手动画；松手后判断是否够格，够就切。
   *
   * 用 RN 内置的 PanResponder + Animated，**不引入 react-native-gesture-handler** ——
   * 鸿蒙上新增原生模块风险高（react-native-screens 就是这么翻车的）。
   *
   * 只在「主页面」生效：二级页面打开时 PushedLayer 覆盖在上面，
   * 这里的 PanResponder 收不到事件，天然不会误切。
   */
  const dragX = useRef(new Animated.Value(0)).current;
  const widthRef = useRef(0);

  const go = useCallback(
    (dir: -1 | 1) => {
      const next = activeIndex + dir;
      if (next < 0 || next >= tabs.length) return;
      switchTab(tabs[next].key);
    },
    [activeIndex, tabs, switchTab],
  );

  const pan = useMemo(
    () =>
      PanResponder.create({
        // 只在明显是横向滑动时才接管，避免抢走页面内的纵向滚动
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > 18 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
        onPanResponderMove: (_e, g) => {
          dragX.setValue(g.dx);
        },
        onPanResponderRelease: (_e, g) => {
          // 门槛：滑过屏宽 1/4，或甩得够快
          const enough = Math.abs(g.dx) > Math.max(60, widthRef.current * 0.25) || Math.abs(g.vx) > 1.1;
          if (enough) {
            // dx < 0 是往左滑 → 看下一页
            go(g.dx < 0 ? 1 : -1);
          }
          // 不跟手：松手后位移归零，页面靠 key 切换重建
          Animated.timing(dragX, { toValue: 0, duration: 120, useNativeDriver: true }).start();
        },
        onPanResponderTerminate: () => {
          Animated.timing(dragX, { toValue: 0, duration: 120, useNativeDriver: true }).start();
        },
      }),
    [dragX, go],
  );

  return (
    <View style={styles.root}>
      {/*
        顶部留白。
        ⚠️ 踩过的坑（两次）：
          1. 用 <SafeAreaView edges={['top']}> 包住 → 里面页面是
             `StyleSheet.absoluteFill`，**绝对定位的子元素不参与父级 padding 的布局**，
             padding 白加。
          2. 改成父级加 paddingTop + 子级仍用 absoluteFill → 同样无效。
        所以最终**不再用绝对定位**：页面用 flex:1 正常参与布局，
        留白由父级 paddingTop 提供，一定生效。
      */}
      <View
        style={[styles.content, { paddingTop: topInset + spacing.base }]}
        onLayout={(e) => {
          widthRef.current = e.nativeEvent.layout.width;
        }}
        {...pan.panHandlers}
      >
        {/* key=activeKey：切页时重建组件，让各页滚动位置自然重置 */}
        <Screen key={activeKey} router={router} isActive />
      </View>

      {/* 二级页面层 */}
      <PushedLayer />

      {/* 底部固定滑动栏 */}
      <View style={[styles.railSafe, { paddingBottom: bottomInset }]}>
        <BottomRail
          tabs={tabs.map((t) => ({ key: t.key, label: t.label }))}
          activeKey={activeKey}
          onSelect={(k) => switchTab(k as TopTabKey)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.background.secondary },
  /** 内容区：页面用 flex:1 正常参与布局，顶部留白靠这里的 paddingTop */
  content: { flex: 1 },
  /** 二级页面层：占满全屏（含状态栏区域，顶部留白由 NavHeader 自己加） */
  page: { backgroundColor: color.background.secondary },
  railSafe: {
    backgroundColor: color.background.primary,
    flexGrow: 0,
    flexShrink: 0,
  },
});
