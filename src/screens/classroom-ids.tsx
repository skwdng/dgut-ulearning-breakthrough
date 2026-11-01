/**
 * 「课堂 id」查询页（2026-10）。
 *
 * ══════════════ 用户需求 ══════════════
 *
 *   「我怎么知道课堂 id 啊，单独加一个查看课程 id 功能，
 *     选中课程，列出这个课程以往所有的课程 id」
 *
 * 背景：投票/答题接口是**按课堂（classroomId）**组织的 ——
 * 读活动列表必须传 classroomId，而优学院界面从不直接显示这个数字，
 * 用户只能从签到记录里"课堂 id 446387"那种地方偶然看到。
 *
 * ══════════════ 数据从哪来（不是新接口）══════════════
 *
 * 就用已经查到的签到数据：`sign.overview.courses[].records[]`，
 * 每条记录里带 `classroomId` / `className` / `beginTime`。
 * 所以这页**不额外发任何请求**，纯粹是对已有数据做分组：
 *
 *   课程「数字逻辑」
 *     ├ 课堂 446387   用过 12 次   最近 2026-10-28
 *     └ 课堂 441002   用过 3 次    最近 2026-09-30
 *
 * 这样用户选课程 → 看到历史用过的全部课堂 id → 一键复制或直接去查投票。
 */
import React, { useCallback, useMemo, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { Badge, Button, Card, Col, Row, ScreenScroll, Section, Spacer, Txt } from '../components';
import { color, spacing } from '../theme/tokens';
import { useSign } from '../state/signStore';
import { useRouter } from '../nav/router';

interface ClassroomUsage {
  classroomId: number;
  className?: string;
  count: number;
  lastAt?: number;
}

interface CourseGroup {
  key: string;
  courseName: string;
  teacher?: string;
  classrooms: ClassroomUsage[];
}

function fmtDate(t?: number): string {
  if (!t || !Number.isFinite(t)) return '时间未知';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function ClassroomIdsScreen() {
  const sign = useSign();
  const router = useRouter();
  const [copied, setCopied] = useState<number | null>(null);

  /** 按课程分组，收集这门课用过的所有课堂 id */
  const groups = useMemo<CourseGroup[]>(() => {
    const map = new Map<string, CourseGroup>();

    const add = (courseName: string, teacher: string | undefined, classroomId: number, className?: string, at?: number) => {
      if (!classroomId) return;
      const key = courseName || '(未命名课程)';
      const g = map.get(key) ?? { key, courseName: key, teacher, classrooms: [] };
      if (!g.teacher && teacher) g.teacher = teacher;
      const hit = g.classrooms.find((c) => c.classroomId === classroomId);
      if (hit) {
        hit.count += 1;
        if (at && (!hit.lastAt || at > hit.lastAt)) hit.lastAt = at;
        if (!hit.className && className) hit.className = className;
      } else {
        g.classrooms.push({ classroomId, className, count: 1, lastAt: at });
      }
      map.set(key, g);
    };

    /** 主数据源：签到总览里的课程（每门课带 records） */
    for (const c of sign.overview?.courses ?? []) {
      for (const r of c.records ?? []) {
        add(c.name, c.teacher, r.classroomId ?? 0, r.className, r.beginTime ?? r.createDate);
      }
      /** 有些课程在 overview.courses 里没有 records（只有汇总），也从 allRecords 补 */
    }
    /** 兜底：allRecords 里可能有课程列表没覆盖到的记录 */
    for (const r of sign.overview?.allRecords ?? []) {
      add(r.courseName ?? '(未命名课程)', r.teacherName, r.classroomId ?? 0, r.className, r.beginTime ?? r.createDate);
    }

    for (const g of map.values()) {
      g.classrooms.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
    }
    return [...map.values()]
      .filter((g) => g.classrooms.length > 0)
      .sort((a, b) => (b.classrooms[0]?.lastAt ?? 0) - (a.classrooms[0]?.lastAt ?? 0));
  }, [sign.overview]);

  const copy = useCallback(async (id: number) => {
    try {
      await Clipboard.setStringAsync(String(id));
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* 复制失败不提示：id 就在屏幕上，能手抄 */
    }
  }, []);

  return (
    <ScreenScroll>
      <Section style={{ marginTop: spacing.md }}>
        <Card>
          <Row justify="space-between" align="center">
            <Txt variant="body" weight="semibold">
              课堂 id
            </Txt>
            <Badge text="来自签到记录" fg={color.primary[600]} bg={color.primary[50]} />
          </Row>
          <Spacer h={spacing.sm} />
          <Txt variant="caption" c={color.text.secondary} style={{ lineHeight: 18 }}>
            {'优学院不会直接显示「课堂 id」，但投票/答题是按课堂组织的。\n'}
            {'这页把你看过的签到按课程分组，列出每门课用过的全部课堂 id。\n'}
            {'点「查投票 / 答题」可以直接带着这个 id 去查。'}
          </Txt>
        </Card>
      </Section>

      {!sign.overview ? (
        <Section>
          <Card>
            <Txt variant="body2" c={color.text.secondary}>
              还没有签到数据。先到「小操作 → 签到记录」查询一次，这里就有课堂 id 了。
            </Txt>
            <Spacer h={spacing.md} />
            <Button label="去签到记录" onPress={() => router.push('/sign-qr')} />
          </Card>
        </Section>
      ) : null}

      {sign.overview && groups.length === 0 ? (
        <Section>
          <Card>
            <Txt variant="body2" c={color.text.secondary}>
              签到记录里没有任何课堂 id（可能是记录还没加载完，或这些签到都没有课堂信息）。
            </Txt>
          </Card>
        </Section>
      ) : null}

      {groups.map((g) => (
        <Section key={g.key} title={g.courseName}>
          <Card>
            {g.teacher ? (
              <>
                <Txt variant="caption" c={color.text.tertiary}>
                  {`教师：${g.teacher}`}
                </Txt>
                <Spacer h={spacing.sm} />
              </>
            ) : null}
            {g.classrooms.map((c, i) => (
              <Col key={c.classroomId} gap={spacing.sm}>
                {i > 0 ? (
                  <Row>
                    <Spacer h={0} />
                  </Row>
                ) : null}
                <Row justify="space-between" align="center" gap={spacing.sm}>
                  <Col flex={1} gap={2}>
                    <Txt variant="body2" weight="medium">
                      {`课堂 ${c.classroomId}`}
                    </Txt>
                    <Txt variant="caption" c={color.text.tertiary}>
                      {`用过 ${c.count} 次` +
                        (c.lastAt ? ` · 最近 ${fmtDate(c.lastAt)}` : '') +
                        (c.className ? ` · ${c.className}` : '')}
                    </Txt>
                  </Col>
                  <Button
                    label={copied === c.classroomId ? '已复制' : '复制'}
                    variant="secondary"
                    onPress={() => void copy(c.classroomId)}
                  />
                  <Button
                    label="查投票 / 答题"
                    onPress={() => router.push('/vote-list', { classroomId: String(c.classroomId) })}
                  />
                </Row>
              </Col>
            ))}
          </Card>
        </Section>
      ))}
    </ScreenScroll>
  );
}
