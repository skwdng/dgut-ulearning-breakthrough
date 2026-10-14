/**
 * 优学院页 —— 两个**同级**入口：任务查询 / 小操作。
 *
 * ══════════════ ★ 2026-10 层级（用户明确要求）══════════════
 * 「小操作类与任务查询同级，都归于优学院类，
 *   然后使用授权码才能使用小操作功能，
 *   小操作功能里面包含上面说的三个功能」
 *
 *   ┌─ 优学院（底部页）──────────────┐
 *   │  📋 任务查询                    │  ← 不需要授权
 *   │  🎛 小操作      [需授权]        │  ← ★ 门槛在这一层
 *   └──────────────────────────────┘
 *                    ↓ 点「小操作」
 *   ┌─ 小操作 ──────────────────────┐
 *   │  ✓ 签到  /  ± 加减分  /  ⊘ 点不中 │
 *   └──────────────────────────────┘
 *
 * ⚠️ 这里**只挂入口**，授权门槛在 `screens/xiaocao.tsx` 内部
 *    （套了一层 `<LicensedScreen>`）。理由见那个文件的注释：
 *    模块级的 `requiresLicense` 会连「任务查询」一起拦住，不行。
 *
 * ⚠️ 「签到」不再直接挂在这一页 —— 它是"小操作"里的东西。
 */
import React from 'react';
import { Pressable, View } from 'react-native';
import { Badge, Button, Card, Col, EmptyState, Row, ScreenScroll, Section, Spacer, Txt } from '../components';
import { color, radius, spacing } from '../theme/tokens';
import { useCheckin } from '../state/checkinStore';
import { useUnlock } from '../state/unlockStore';
import type { TabScreenProps } from '../nav/tabs';

export function YouxueTabScreen({ router }: TabScreenProps) {
  const { account } = useCheckin();
  const { entitled } = useUnlock();

  return (
    <ScreenScroll>
      {!account ? (
        <Section>
          <Card>
            <EmptyState title="还没有绑定优学院账号" hint="绑定后才能查询数据" />
            <Spacer h={spacing.md} />
            <Button label="去绑定" onPress={() => router.push('/youxue-bind')} />
          </Card>
        </Section>
      ) : (
        <>
          {/* 当前账号（只显示姓名，不显示学号） */}
          <Section style={{ marginTop: spacing.sm }}>
            <Card style={{ paddingVertical: spacing.md }}>
              <Row justify="space-between" align="center">
                <Col gap={2}>
                  <Txt variant="body2" weight="medium">
                    {account.studentName?.trim() || displayId(account.studentId)}
                  </Txt>
                  <Txt variant="small" c={color.text.tertiary}>
                    {account.school ?? '优学院'}
                  </Txt>
                </Col>
                <Pressable onPress={() => router.push('/youxue-bind')} hitSlop={8}>
                  <Txt variant="small" c={color.primary[500]}>
                    换账号
                  </Txt>
                </Pressable>
              </Row>
            </Card>
          </Section>

          {/* 入口块：任务查询 与 小操作 **同级** */}
          <Section title="功能">
            <Col gap={spacing.md}>
              {/*
                ⚠️ 这个介绍原先写的是"查询优学院发起过的签到，未签到在最上面"——
                   那是**签到页**的功能，写错到任务页上了，用户一眼看不出这页是干嘛的。
                   任务页实际做的是：遍历所有课程，列出**没做完的作业**与**没看完的课件**。
              */}
              <EntryBlock
                glyph="📋"
                label="任务"
                hint="列出没做完的作业与没看完的课件，按紧急度排序"
                onPress={() => router.push('/youxue-task')}
              />

              {/*
                ★ 小操作 —— 与任务查询同级。
                未授权时**仍然显示**（并标「需授权」）：
                让人知道有这个东西、以及去哪开通；
                点进去会看到 LicenseGate 的开通指引。
              */}
              <EntryBlock
                glyph="🎛"
                label="小操作"
                hint="签到、加减分、点不中 —— 课堂上的几个小工具"
                badge={entitled ? undefined : { text: '需授权', fg: color.warning[600], bg: color.warning[50] }}
                onPress={() => router.push('/xiaocao')}
              />
            </Col>
          </Section>
        </>
      )}
    </ScreenScroll>
  );
}

/** 学号打码：只留前 4 位和后 2 位 */
function displayId(sid: string): string {
  if (!sid) return '已绑定';
  if (sid.length <= 6) return sid;
  return `${sid.slice(0, 4)}****${sid.slice(-2)}`;
}

/** 一个方形入口块 */
function EntryBlock({
  glyph,
  label,
  hint,
  badge,
  onPress,
}: {
  glyph: string;
  label: string;
  hint: string;
  /** 右上角徽标（比如「需授权」） */
  badge?: { text: string; fg: string; bg: string };
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress}>
      <Card style={{ padding: spacing.lg }}>
        <Row gap={spacing.md} align="center">
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: radius.md,
              backgroundColor: color.primary[50],
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Txt variant="h2">{glyph}</Txt>
          </View>
          <Col flex={1} gap={3}>
            <Row gap={spacing.sm} align="center">
              <Txt variant="title" weight="semibold">
                {label}
              </Txt>
              {badge ? <Badge text={badge.text} fg={badge.fg} bg={badge.bg} /> : null}
            </Row>
            <Txt variant="small" c={color.text.tertiary} numberOfLines={2}>
              {hint}
            </Txt>
          </Col>
          <Txt variant="h2" c={color.neutral[400]}>
            ›
          </Txt>
        </Row>
      </Card>
    </Pressable>
  );
}
