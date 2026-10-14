/**
 * 由 app/profile.tsx 迁移而来（tools/migrate-screens.cjs）。
 * 已移除 expo-router 依赖 —— 见 src/nav/router.tsx 的说明。
 */
import React from 'react';
import { Pressable, View } from 'react-native';
import {
  Badge,
  Card,
  Col,
  Divider,
  Row,
  ScreenScroll,
  Section,
  SettingRow,
  Spacer,
  StatusBadge,
  Txt,
} from '../components';
import { color, radius, spacing } from '../theme/tokens';
import { useCheckin } from '../state/checkinStore';
import { useModules } from '../state/moduleStore';
import { currentAdapterKind } from '../services/checkin';
import { useRouter } from '../nav/router';

export function ProfileScreen() {
  const router = useRouter();
  const { account, stats, sessionState, courses, actions, log } = useCheckin();
  const { visible } = useModules();

  return (
    <ScreenScroll>
      {/* 用户卡 */}
      <Section style={{ marginTop: spacing.md }}>
        <Card variant="gradient" style={{ padding: spacing.lg }}>
          <Row gap={spacing.base}>
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: radius.full,
                backgroundColor: color.background.primary,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Txt variant="h3" weight="bold" c={color.primary[500]}>
                L
              </Txt>
            </View>
            <Col flex={1}>
              <Txt variant="title" weight="semibold" c={color.text.inverse}>
                LifeKit 用户
              </Txt>
              <Txt variant="caption" c={color.text.inverse} style={{ opacity: 0.75, marginTop: 2 }}>
                {account ? `优学院 ${account.studentName?.trim() || '已连接'}` : '未绑定优学院'}
              </Txt>
            </Col>
          </Row>
        </Card>
      </Section>

      {/* 统计 */}
      <Section>
        <Card>
          <Row justify="space-between">
            <StatItem label="签到天数" value={`${stats.streakDays}天`} c={color.success[500]} />
            <StatItem label="已完成" value={`${stats.todayDone}`} c={color.primary[500]} />
            <StatItem label="课程数" value={`${courses.length}`} c={color.warning[500]} />
          </Row>
        </Card>
      </Section>

      {/* 功能服务 */}
      <Section title="功能服务">
        <Card style={{ padding: 0 }}>
          <SettingRow
            icon="✓"
            iconBg={color.success[100]}
            iconColor={color.success[600]}
            label="优学院签到"
            subLabel={
              !account
                ? '未绑定'
                : sessionState === 'expired'
                  ? '会话失效，需要重新绑定'
                  : '已绑定，可到「小操作 → 签到记录」改状态'
            }
            right={<StatusBadge state={!account ? 'unbound' : sessionState === 'expired' ? 'expired' : 'idle'} />}
            onPress={() => router.push({ pathname: '/youxue-bind' })}
            divider
          />
          <SettingRow
            icon="A"
            iconBg={color.primary[100]}
            iconColor={color.primary[500]}
            label="优学院账号与设置"
            subLabel="会话、定位、轮询策略、能力自检"
            onPress={() => router.push('/youxue-bind')}
            divider
          />
          <SettingRow
            icon="⚙"
            iconBg={color.neutral[200]}
            iconColor={color.neutral[600]}
            label="功能模块"
            subLabel="按需开关各模块；不支持的平台会自动隐藏"
            value={`${visible.length} 个已启用`}
            onPress={() => router.push('/modules')}
            divider
          />
          <SettingRow
            icon="▤"
            iconBg={color.primary[100]}
            iconColor={color.primary[500]}
            label="课表"
            onPress={() => router.push('/schedule')}
            divider
          />
          <SettingRow
            icon="📜"
            iconBg={color.warning[100]}
            iconColor={color.warning[600]}
            label="签到日志"
            value={`${log.length} 条`}
            onPress={() => router.push('/checkin-log')}
          />
        </Card>
      </Section>

      {/* 其他 */}
      <Section title="其他">
        <Card style={{ padding: 0 }}>
          <SettingRow icon="🔔" label="通知设置" subLabel="签到检测、失败、会话失效提醒" right={<Badge text="待接入" fg={color.neutral[500]} bg={color.neutral[100]} />} divider />
          <SettingRow icon="🌙" label="深色模式" right={<Badge text="未实现" fg={color.neutral[500]} bg={color.neutral[100]} />} divider />
          <SettingRow icon="ℹ" label="关于" value="v0.1.0" divider />
          <SettingRow
            icon="⚙"
            label="当前适配器"
            value={currentAdapterKind()}
            onPress={() => router.push('/youxue-bind')}
          />
        </Card>
      </Section>

      {/* 合规声明 */}
      <Section title="使用说明与风险提示">
        <Card>
          <Txt variant="body2" c={color.text.secondary}>
            本功能用于课堂考勤辅助，请在符合学校规定与课程要求的前提下使用。
          </Txt>
          <Spacer h={spacing.md} />
          <Bullet text="本 App 不提供代刷课、代答题、代考试等任何学业作弊功能。" />
          <Bullet text="签到轮询会做抖动、随机延迟、夜间静默与熔断，但仍无法保证 100% 成功。" />
          <Bullet text="iOS 后台无法长时间运行，纯客户端方案在 iOS 上可靠性有限。" />
          <Bullet text="解绑会立即删除本地保存的会话凭据。" />
        </Card>
      </Section>

      {account ? (
        <Section>
          <Pressable
            onPress={() => {
              void actions.unbind();
            }}
          >
            <Card style={{ alignItems: 'center' }}>
              <Txt variant="body2" c={color.error[500]}>
                解除绑定并删除凭据
              </Txt>
            </Card>
          </Pressable>
        </Section>
      ) : null}
    </ScreenScroll>
  );
}

function StatItem({ label, value, c }: { label: string; value: string; c: string }) {
  return (
    <Col align="center" gap={4}>
      <Txt variant="h3" weight="bold" c={c}>
        {value}
      </Txt>
      <Txt variant="caption" c={color.text.secondary}>
        {label}
      </Txt>
    </Col>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <Row gap={spacing.sm} align="flex-start" style={{ marginTop: spacing.sm }}>
      <Txt variant="caption" c={color.text.tertiary}>•</Txt>
      <Txt variant="caption" c={color.text.tertiary} style={{ flex: 1 }}>
        {text}
      </Txt>
    </Row>
  );
}
