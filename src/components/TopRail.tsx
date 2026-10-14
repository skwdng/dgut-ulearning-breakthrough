/**
 * 底部横向滑动栏 —— 顶层页面切换。
 *
 * 布局（按手绘稿）：
 *   ┌──────────────────┐
 *   │  页面内容         │
 *   ├────┬─────┬───┬───┤
 *   │ 首页│优学院│外卖│ AI│  ← 这一条可左右滑动
 *   └────┴─────┴───┴───┘
 *
 * 设计要点：
 * - 横向 ScrollView，**首页在最左**，往右依次是优学院 / 点餐 / 专属AI
 * - 点击切换；选中项 = 填充胶囊 + 上划线 + 加粗，三重提示
 * - 未选中项用浅底胶囊，让整条看起来是"一排可点的东西"
 * - 项数少时不滚动；项数多时自动可滚，选中项自动滚入视野
 * - 顶部一条细分隔线，把内容和栏分开
 *
 * 为什么不用 react-navigation 的 material-top-tabs：
 * 需要额外依赖 @react-navigation/material-top-tabs + react-native-pager-view，
 * 而这里只需"点击切换"，自绘更可控、也不用引入原生依赖。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { color, radius, spacing } from '../theme/tokens';
import { Txt } from './index';

export interface RailTab {
  key: string;
  label: string;
  /** 可选角标数字（>0 时显示） */
  badge?: number;
}

export function BottomRail({
  tabs,
  activeKey,
  onSelect,
  style,
}: {
  tabs: RailTab[];
  activeKey: string;
  onSelect: (key: string) => void;
  style?: object;
}) {
  const scrollRef = useRef<ScrollView>(null);
  /** 记录每个 tab 的横向位置，用于自动滚动 */
  const layouts = useRef<Record<string, { x: number; width: number }>>({});
  const [viewportW, setViewportW] = useState(0);

  // 选中项变化时，确保它在可视区域内
  useEffect(() => {
    const l = layouts.current[activeKey];
    if (!l || !viewportW) return;
    const target = Math.max(0, l.x - (viewportW - l.width) / 2);
    scrollRef.current?.scrollTo({ x: target, animated: true });
  }, [activeKey, viewportW]);

  const onTabLayout = (key: string) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    layouts.current[key] = { x, width };
  };

  return (
    <View style={[styles.wrap, style]} onLayout={(e) => setViewportW(e.nativeEvent.layout.width)}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {tabs.map((t) => {
          const active = t.key === activeKey;
          return (
            <Pressable
              key={t.key}
              onLayout={onTabLayout(t.key)}
              onPress={() => onSelect(t.key)}
              style={styles.tabHit}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={t.label}
            >
              {/* 选中上划线 */}
              <View style={[styles.underline, active && styles.underlineActive]} />
              <View style={[styles.pill, active ? styles.pillActive : styles.pillIdle]}>
                {t.badge && t.badge > 0 ? (
                  <View style={[styles.badge, active && styles.badgeActive]}>
                    <Txt variant="small" c={active ? color.primary[500] : color.text.inverse}>
                      {t.badge > 99 ? '99+' : String(t.badge)}
                    </Txt>
                  </View>
                ) : null}
                <Txt
                  variant={active ? 'body' : 'body2'}
                  weight={active ? 'bold' : 'medium'}
                  c={active ? color.text.inverse : color.text.secondary}
                >
                  {t.label}
                </Txt>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** 兼容旧名字（避免其他文件引用报错） */
export const TopRail = BottomRail;

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: color.background.primary,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.neutral[200],
  },
  content: {
    paddingHorizontal: spacing.md,
    paddingTop: 6,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    alignItems: 'center',
  },
  tabHit: {
    alignItems: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.base,
    paddingVertical: 8,
    borderRadius: radius.full,
  },
  pillIdle: {
    backgroundColor: color.neutral[100],
  },
  pillActive: {
    backgroundColor: color.primary[500],
  },
  badge: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.error[500],
  },
  badgeActive: {
    backgroundColor: color.background.primary,
  },
  underline: {
    height: 2.5,
    width: 0,
    marginBottom: 4,
    borderRadius: 2,
    backgroundColor: 'transparent',
  },
  underlineActive: {
    width: '70%',
    backgroundColor: color.primary[500],
  },
});
