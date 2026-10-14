/**
 * 由 app/checkin-log.tsx 迁移而来（tools/migrate-screens.cjs）。
 * 已移除 expo-router 依赖 —— 见 src/nav/router.tsx 的说明。
 */
/**
 * 签到日志 —— 开发者/反馈用。
 * 原则：只记录"发生了什么"，绝不落 Cookie / 密码 / token。
 */
import React from 'react';
import { View } from 'react-native';
import {
  Button,
  Card,
  Col,
  Divider,
  EmptyState,
  Row,
  ScreenScroll,
  Section,
  Spacer,
  Txt,
} from '../components';
import { color, spacing } from '../theme/tokens';
import { useCheckin } from '../state/checkinStore';
import { currentAdapterKind } from '../services/checkin';

export function CheckinLogScreen() {
  const { log, plan, tier, tierReason, actions, account } = useCheckin();
  const reversed = [...log].reverse();

  return (
    <ScreenScroll>
      <Section style={{ marginTop: spacing.md }} title="运行环境">
        <Card style={{ padding: 0 }}>
          <Row justify="space-between" style={{ padding: spacing.base }}>
            <Txt variant="body2" c={color.text.secondary}>适配器</Txt>
            <Txt variant="body2">{currentAdapterKind()}</Txt>
          </Row>
          <Divider />
          <Row justify="space-between" style={{ padding: spacing.base }}>
            <Txt variant="body2" c={color.text.secondary}>账号</Txt>
            <Txt variant="body2">{account ? `${account.studentId}（${account.tenant}）` : '未绑定'}</Txt>
          </Row>
          <Divider />
          <Row justify="space-between" style={{ padding: spacing.base }}>
            <Txt variant="body2" c={color.text.secondary}>当前策略</Txt>
            <Txt variant="body2">{tier} · {tierReason}</Txt>
          </Row>
          <Divider />
          <Row justify="space-between" style={{ padding: spacing.base }}>
            <Txt variant="body2" c={color.text.secondary}>轮询/延迟/上限</Txt>
            <Txt variant="body2">
              {plan.baseIntervalMs / 1000}s · {plan.submitDelayMs[0] / 1000}~{plan.submitDelayMs[1] / 1000}s · {plan.dailySubmitCap}
            </Txt>
          </Row>
        </Card>
      </Section>

      <Section title={`日志（${log.length} 条）`}>
        <Card style={{ padding: 0 }}>
          {reversed.length === 0 ? (
            <EmptyState title="暂无日志" hint="签到相关的操作记录会出现在这里" />
          ) : (
            reversed.map((entry, i) => (
              <View key={`${entry.at}-${i}`}>
                <Col style={{ padding: spacing.base }} gap={4}>
                  <Row justify="space-between">
                    <Txt
                      variant="caption"
                      c={
                        entry.level === 'error'
                          ? color.error[500]
                          : entry.level === 'warn'
                            ? color.warning[600]
                            : color.success[500]
                      }
                    >
                      {entry.level.toUpperCase()}
                    </Txt>
                    <Txt variant="caption" c={color.text.tertiary}>
                      {new Date(entry.at).toLocaleTimeString('zh-CN')}
                    </Txt>
                  </Row>
                  <Txt variant="body2">{entry.text}</Txt>
                </Col>
                {i < reversed.length - 1 ? <Divider /> : null}
              </View>
            ))
          )}
        </Card>
      </Section>

      <Section>
        <Button label="清空日志" variant="secondary" onPress={actions.clearLog} />
        <Spacer h={spacing.md} />
        <Txt variant="caption" c={color.text.tertiary}>
          反馈问题时请附上本页内容。日志已做脱敏：不包含 Cookie、密码或任何凭据字段。
        </Txt>
      </Section>
    </ScreenScroll>
  );
}
