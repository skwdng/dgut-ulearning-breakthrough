/**
 * 由 app/todo.tsx 迁移而来（tools/migrate-screens.cjs）。
 * 已移除 expo-router 依赖 —— 见 src/nav/router.tsx 的说明。
 */
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  Badge,
  Button,
  Card,
  Col,
  Divider,
  EmptyState,
  Field,
  Row,
  ScreenScroll,
  Section,
  Spacer,
  Txt,
} from '../components';
import { color, radius, spacing } from '../theme/tokens';

type Priority = 'high' | 'normal' | 'low';

interface Todo {
  id: string;
  title: string;
  priority: Priority;
  dueDate: string;
  tag: string;
  completed: boolean;
}

const SEED: Todo[] = [
  { id: 't1', title: '完成数学作业第三章', priority: 'high', dueDate: '今天 18:00', tag: '学习', completed: false },
  { id: 't2', title: '准备小组讨论 PPT', priority: 'high', dueDate: '明天 12:00', tag: '学习', completed: false },
  { id: 't3', title: '取快递（菜鸟驿站）', priority: 'normal', dueDate: '今天 20:00前', tag: '生活', completed: false },
  { id: 't4', title: '还图书馆的书', priority: 'normal', dueDate: '本周五', tag: '生活', completed: false },
  { id: 't5', title: '买洗衣液', priority: 'low', dueDate: '本周内', tag: '生活', completed: true },
];

const PRIORITY_META: Record<Priority, { label: string; fg: string; bg: string }> = {
  high: { label: '高优先级', fg: color.error[500], bg: color.error[50] },
  normal: { label: '普通', fg: color.primary[500], bg: color.primary[50] },
  low: { label: '低', fg: color.neutral[500], bg: color.neutral[100] },
};

export function TodoScreen() {
  const [todos, setTodos] = useState<Todo[]>(SEED);
  const [tab, setTab] = useState<0 | 1>(0);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftPriority, setDraftPriority] = useState<Priority>('normal');

  const visible = useMemo(
    () => todos.filter((t) => (tab === 0 ? !t.completed : t.completed)),
    [todos, tab],
  );

  const groups = useMemo(() => {
    const order: Priority[] = ['high', 'normal', 'low'];
    return order
      .map((p) => ({ priority: p, items: visible.filter((t) => t.priority === p) }))
      .filter((g) => g.items.length > 0);
  }, [visible]);

  const toggle = (id: string) =>
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)));

  const add = () => {
    if (!draft.trim()) return;
    setTodos((prev) => [
      {
        id: `t${Date.now()}`,
        title: draft.trim(),
        priority: draftPriority,
        dueDate: '未设置',
        tag: '其他',
        completed: false,
      },
      ...prev,
    ]);
    setDraft('');
    setAdding(false);
  };

  return (
    <ScreenScroll>
      {/* 分段控件 */}
      <Section style={{ marginTop: spacing.md }}>
        <Row style={{ backgroundColor: color.neutral[100], borderRadius: radius.md, padding: 4 }}>
          {(['进行中', '已完成'] as const).map((label, i) => (
            <Pressable
              key={label}
              onPress={() => setTab(i as 0 | 1)}
              style={{
                flex: 1,
                paddingVertical: spacing.sm,
                borderRadius: radius.sm,
                backgroundColor: tab === i ? color.background.primary : 'transparent',
                alignItems: 'center',
              }}
            >
              <Txt variant="body2" weight={tab === i ? 'semibold' : 'regular'} c={tab === i ? color.primary[500] : color.text.secondary}>
                {label}
              </Txt>
            </Pressable>
          ))}
        </Row>
      </Section>

      {adding ? (
        <Section title="新增待办">
          <Field label="标题" value={draft} onChangeText={setDraft} placeholder="要做什么？" autoFocus />
          <Row gap={spacing.sm} style={{ marginBottom: spacing.base }}>
            {(['high', 'normal', 'low'] as Priority[]).map((p) => (
              <Pressable
                key={p}
                onPress={() => setDraftPriority(p)}
                style={{
                  paddingHorizontal: spacing.md,
                  paddingVertical: 6,
                  borderRadius: radius.full,
                  borderWidth: 1,
                  borderColor: draftPriority === p ? color.primary[500] : color.neutral[200],
                  backgroundColor: draftPriority === p ? color.primary[500] : color.background.primary,
                }}
              >
                <Txt variant="caption" c={draftPriority === p ? color.text.inverse : color.text.secondary}>
                  {PRIORITY_META[p].label}
                </Txt>
              </Pressable>
            ))}
          </Row>
          <Button label="添加" onPress={add} />
          <Spacer h={spacing.sm} />
          <Button label="取消" variant="text" onPress={() => setAdding(false)} />
        </Section>
      ) : (
        <Section>
          <Button label="+ 新增待办" variant="secondary" onPress={() => setAdding(true)} />
        </Section>
      )}

      {groups.length === 0 ? (
        <Section>
          <Card>
            <EmptyState title={tab === 0 ? '没有进行中的待办' : '还没有已完成的待办'} />
          </Card>
        </Section>
      ) : (
        groups.map((g) => (
          <Section key={g.priority} title={PRIORITY_META[g.priority].label}>
            <Card style={{ padding: 0 }}>
              {g.items.map((t, i) => (
                <View key={t.id}>
                  <Pressable onPress={() => toggle(t.id)}>
                    <Row justify="space-between" style={{ padding: spacing.base }} gap={spacing.md}>
                      <Row style={{ flex: 1 }} gap={spacing.md}>
                        <View
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: 10,
                            borderWidth: 2,
                            borderColor: t.completed ? color.success[500] : color.neutral[300],
                            backgroundColor: t.completed ? color.success[500] : 'transparent',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {t.completed ? <Txt variant="small" c={color.text.inverse}>✓</Txt> : null}
                        </View>
                        <Col flex={1}>
                          <Txt
                            variant="body"
                            c={t.completed ? color.text.tertiary : color.text.primary}
                            style={t.completed ? { textDecorationLine: 'line-through' } : undefined}
                          >
                            {t.title}
                          </Txt>
                          <Txt variant="caption" c={color.text.tertiary} style={{ marginTop: 2 }}>
                            {t.dueDate} · {t.tag}
                          </Txt>
                        </Col>
                      </Row>
                      <Badge text={PRIORITY_META[t.priority].label} fg={PRIORITY_META[t.priority].fg} bg={PRIORITY_META[t.priority].bg} />
                    </Row>
                  </Pressable>
                  {i < g.items.length - 1 ? <Divider /> : null}
                </View>
              ))}
            </Card>
          </Section>
        ))
      )}
    </ScreenScroll>
  );
}
