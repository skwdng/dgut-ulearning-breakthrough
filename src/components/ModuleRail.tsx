/**
 * 首页的「功能模块」横向滑动选择器。
 *
 * 数据来自模块注册表（plugins），**按平台能力自动过滤**：
 * 例如 iOS 上「外卖」不会出现在这里。
 * 用户主动开启但平台不支持的模块仍会显示，并带"不可用"标记与原因。
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Txt } from './index';
import { color, radius, shadow, spacing } from '../theme/tokens';
import type { ModuleRuntime } from '../domain/modules';

const TILE_W = 84;

export function ModuleRail({
  items,
  activeKey,
  onSelect,
  badges,
}: {
  items: ModuleRuntime[];
  activeKey: string;
  onSelect: (key: string) => void;
  /** 每个模块的角标（未处理数量等） */
  badges?: Record<string, number>;
}) {
  return (
    <View style={{ marginTop: spacing.lg }}>
      <View style={{ paddingHorizontal: spacing.base, marginBottom: spacing.md }}>
        <Txt variant="title" weight="semibold">功能模块</Txt>
        <Txt variant="caption" c={color.text.tertiary} style={{ marginTop: 2 }}>
          左右滑动选择，点击切换
        </Txt>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.base, gap: spacing.md }}
        decelerationRate="fast"
        snapToInterval={TILE_W + spacing.md}
      >
        {items.map(({ def, usable, platformSupported, missing, license }) => {
          const active = def.key === activeKey;
          const badge = badges?.[def.key];
          const locked = Boolean(license?.required && !license.granted);
          return (
            <Pressable
              key={def.key}
              onPress={() => onSelect(def.key)}
              style={[styles.tile, active ? styles.tileActive : null]}
            >
              <View
                style={[
                  styles.glyphBox,
                  {
                    backgroundColor: active
                      ? def.tint
                      : usable
                        ? `${def.tint}1A`
                        : color.neutral[100],
                  },
                ]}
              >
                <Txt variant="h3" c={active ? color.text.inverse : usable ? def.tint : color.neutral[400]}>
                  {locked ? '🔒' : def.glyph}
                </Txt>
              </View>

              <Txt
                variant="caption"
                weight={active ? 'semibold' : 'regular'}
                c={active ? color.primary[600] : usable ? color.text.secondary : color.neutral[400]}
                style={{ marginTop: 8 }}
              >
                {def.label}
              </Txt>

              {/* 状态标记：未授权 > 平台不支持 > 待授权 */}
              {locked ? (
                <Txt variant="small" c={color.warning[600]} style={{ marginTop: 2 }}>
                  未授权
                </Txt>
              ) : !platformSupported ? (
                <Txt variant="small" c={color.error[500]} style={{ marginTop: 2 }}>
                  不支持
                </Txt>
              ) : missing.length > 0 ? (
                <Txt variant="small" c={color.warning[600]} style={{ marginTop: 2 }}>
                  待授权
                </Txt>
              ) : null}

              {badge !== undefined && badge > 0 ? (
                <View style={styles.badge}>
                  <Txt variant="small" c={color.text.inverse}>
                    {badge > 99 ? '99+' : badge}
                  </Txt>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: TILE_W,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: color.background.primary,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'transparent',
    ...shadow.sm,
  },
  tileActive: {
    borderColor: color.primary[500],
    backgroundColor: color.primary[50],
  },
  glyphBox: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 6,
    right: 6,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: color.error[500],
    alignItems: 'center',
    justifyContent: 'center',
  },
});
