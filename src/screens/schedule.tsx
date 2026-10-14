/**
 * 由 app/schedule.tsx 迁移而来（tools/migrate-screens.cjs）。
 * 已移除 expo-router 依赖 —— 见 src/nav/router.tsx 的说明。
 */
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  Badge,
  Card,
  Col,
  Divider,
  EmptyState,
  Row,
  ScreenScroll,
  Section,
  Txt,
} from '../components';
import { color, radius, spacing } from '../theme/tokens';
import { useCheckin } from '../state/checkinStore';

const WEEK_LABEL = ['一', '二', '三', '四', '五', '六', '日'];

export function ScheduleScreen() {
  const { courses } = useCheckin();
  const [selected, setSelected] = useState(() => new Date());

  // 本周（周一起）
  const week = useMemo(() => {
    const base = new Date(selected);
    const dow = base.getDay() === 0 ? 7 : base.getDay();
    const monday = new Date(base);
    monday.setDate(base.getDate() - (dow - 1));
    return Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
  }, [selected]);

  const selectedDow = selected.getDay() === 0 ? 7 : selected.getDay();
  const items = useMemo(
    () =>
      courses
        .flatMap((c) =>
          c.schedule
            .filter((s) => s.dayOfWeek === selectedDow)
            .map((s) => ({
              id: `${c.id}-${s.startTime}`,
              title: c.name,
              teacher: c.teacher,
              location: s.location ?? '',
              start: s.startTime,
              end: s.endTime,
              auto: c.autoCheckin,
            })),
        )
        .sort((a, b) => a.start.localeCompare(b.start)),
    [courses, selectedDow],
  );

  const now = new Date();
  const isToday = selected.toDateString() === now.toDateString();

  return (
    <ScreenScroll>
      {/* 周视图 */}
      <Section style={{ marginTop: spacing.md }}>
        <Card style={{ paddingVertical: spacing.base }}>
          <Row justify="space-between" style={{ paddingHorizontal: spacing.xs }}>
            <Txt variant="body" weight="semibold">
              {selected.getFullYear()}年{selected.getMonth() + 1}月
            </Txt>
            <Txt variant="caption" c={color.text.tertiary}>
              点击切换日期
            </Txt>
          </Row>
          <View style={{ height: spacing.md }} />
          <Row justify="space-between">
            {week.map((d) => {
              const active = d.toDateString() === selected.toDateString();
              const today = d.toDateString() === now.toDateString();
              const dow = d.getDay() === 0 ? 7 : d.getDay();
              const count = courses.reduce(
                (acc, c) => acc + c.schedule.filter((s) => s.dayOfWeek === dow).length,
                0,
              );
              return (
                <Pressable key={d.toISOString()} onPress={() => setSelected(d)} style={{ flex: 1, alignItems: 'center' }}>
                  <Txt variant="caption" c={color.text.tertiary}>
                    {WEEK_LABEL[dow - 1]}
                  </Txt>
                  <View
                    style={{
                      marginTop: 6,
                      width: 36,
                      height: 36,
                      borderRadius: radius.full,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: active ? color.primary[500] : 'transparent',
                    }}
                  >
                    <Txt variant="body2" weight={active ? 'semibold' : 'regular'} c={active ? color.text.inverse : today ? color.primary[500] : color.text.primary}>
                      {d.getDate()}
                    </Txt>
                  </View>
                  <View
                    style={{
                      marginTop: 4,
                      width: 4,
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: count > 0 ? color.primary[400] : 'transparent',
                    }}
                  />
                </Pressable>
              );
            })}
          </Row>
        </Card>
      </Section>

      <Section title={`${selected.getMonth() + 1}月${selected.getDate()}日 · 共 ${items.length} 项`}>
        {items.length === 0 ? (
          <Card>
            <EmptyState title="当天没有课程" hint="切换到有其他日期，或先绑定优学院同步课表" />
          </Card>
        ) : (
          <Col gap={spacing.md}>
            {items.map((it) => (
              <Card key={it.id}>
                <Row gap={spacing.md} align="flex-start">
                  <Col align="center" style={{ width: 56 }}>
                    <Txt variant="body" weight="semibold">{it.start}</Txt>
                    <Txt variant="caption" c={color.text.tertiary}>{it.end}</Txt>
                  </Col>
                  <View style={{ width: 3, borderRadius: 2, backgroundColor: color.primary[400], alignSelf: 'stretch' }} />
                  <Col flex={1} gap={4}>
                    <Row justify="space-between">
                      <Txt variant="body" weight="medium">{it.title}</Txt>
                      {/*
                        ⚠️ 这里原先显示「自动签到 / 未开启」——
                           本 App 已经没有自动签到了（用户明确不要），
                           那个标记会让人以为"没开启所以不会自动签"，
                           而实际上**根本没有自动这回事**。
                           现在只标"这节课是否在签到支持的范围内"。
                      */}
                      {it.auto ? (
                        <Badge text="可签到" fg={color.success[500]} bg={color.success[50]} />
                      ) : null}
                    </Row>
                    <Txt variant="caption" c={color.text.secondary}>
                      {it.teacher}
                      {it.location ? ` · ${it.location}` : ''}
                    </Txt>
                    {isToday ? (
                      <Txt variant="caption" c={color.primary[500]}>
                        上课时段自动进入高频检测
                      </Txt>
                    ) : null}
                  </Col>
                </Row>
              </Card>
            ))}
          </Col>
        )}
      </Section>

      <Section title="说明">
        <Card>
          <Txt variant="caption" c={color.text.tertiary}>
            课表来自优学院课程接口。签到轮询的"热档"只在课表时段（含前后 10 分钟缓冲）内启用，
            其余时间自动降频或休眠，这是为了省电并降低账号风控风险。
          </Txt>
        </Card>
      </Section>
    </ScreenScroll>
  );
}
