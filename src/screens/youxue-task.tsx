/**
 * 任务查询 —— 查"我还有什么没做完"。
 *
 * 两个来源：
 *   未完成作业  /courseapi/homeworks/student   （submitState === 'unsubmitted'）
 *   未看完课件  /courseapi/course/content      （studyProgress < 100）
 *
 * 排序：作业按紧急度（进行中 → 未开始 → 已结束），课件按进度低的在前。
 *
 * ══════════════ ★ 两层筛选（需求）══════════════
 *   第一层「最近 / 全部」：近三个月 / 全部（**只作用于未完成任务**）
 *   第二层「全部 / 作业 / 课件 / 已提交」：按类型
 *
 * ⚠️ 「最近」只筛未完成的 —— 需求原话：
 *    「只需要给未完成任务加」
 *    已提交那份保持原样（历史记录不该被时间窗切掉）。
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Badge, Banner, Button, Card, Col, Divider, EmptyState, Row, ScreenScroll, Section, Txt } from '../components';
import { color, radius, spacing } from '../theme/tokens';
import { useTask, type TaskCourseware, type TaskHomework } from '../state/taskStore';
import { HOMEWORK_TYPE_LABEL } from '../domain/youxue';
import {
  RECENT_WINDOW_LABEL,
  homeworkTime,
  isRecentTask,
} from '../domain/taskTime';

type Filter = 'all' | 'homework' | 'courseware' | 'done';
/** 时间范围：近三个月 / 全部（只作用于未完成） */
type Range = 'recent' | 'all';

export function YouxueTaskScreen() {
  const task = useTask();
  const [filter, setFilter] = useState<Filter>('all');
  const [range, setRange] = useState<Range>('recent');

  /**
   * ★ 时间范围只筛「未完成**作业**」。
   *
   * ══════════════ 需求原话 ══════════════
   * 「这个近三个月的设定只应用于未完成作业这一块」
   *
   * 所以课件**不参与**时间筛选，永远全显示。
   * 道理上也说得通：作业有截止时间，是"一次性任务"，过期就没意义；
   * 课件是"随时可以看"的资料，不该因为创建久了就从待办里消失。
   *
   * ⚠️ 已提交的作业也不参与（历史记录不该被时间窗切掉）。
   */
  const pendingHw = useMemo(() => {
    if (range === 'all') return task.homeworks;
    const now = Date.now();
    return task.homeworks.filter((h) => isRecentTask(homeworkTime(h), now));
  }, [task.homeworks, range]);

  /** 课件不筛时间，只按进度排序 */
  const pendingCw = task.coursewares;

  const hwCount = pendingHw.length;
  const cwCount = pendingCw.length;
  const doneCount = task.submittedHomeworks.length;
  /** 当前「未完成」总数（作业已按时间筛过，课件没筛） */
  const total = hwCount + cwCount;

  /**
   * 用来提示"筛掉了多少"。
   * ⚠️ 只看**作业** —— 课件不参与筛选，算进去会误导。
   */
  const allHw = task.homeworks.length;
  const hiddenByRange = allHw - hwCount;

  /** 课件按进度升序（最没看的排前面） */
  const coursewares = useMemo(
    () => [...pendingCw].sort((a, b) => (a.studyProgress ?? 0) - (b.studyProgress ?? 0)),
    [pendingCw],
  );

  const showHw = filter === 'all' || filter === 'homework';
  const showCw = filter === 'all' || filter === 'courseware';
  const showDone = filter === 'done';

  const busy = task.loading;
  const progress = task.progress;

  const queried = task.lastQueryAt !== undefined;

  /**
   * 作业排序 + 分组。
   *
   * ══════════════ ⚠️ 这里踩过一个坑 ══════════════
   * 用户反馈：「切换了之后没有效果」。
   *
   * 查下来：**筛选其实是生效的**（数字从 89 变成 172、作业 60 → 143），
   * 但他**看不出来** —— 因为排序是把"还没到期"的放最前面，
   * 而"还没到期"无论在哪个时间范围里都算"最近"，
   * 所以两个范围的前几条**是同一批**。
   *
   * 教训：**筛选生效但界面看不出区别，等于没做。**
   * 所以现在把「全部」里的作业分成两组：
   *   ① 近三个月（和「最近」范围看到的一样）
   *   ② 更早的（只有「全部」才出现）
   * 这样一点「全部」，下面立刻多出一整块 —— 效果肉眼可见。
   */
  const { recentHw, olderHw } = useMemo(() => {
    const now = Date.now();
    const byUrgency = (a: TaskHomework, b: TaskHomework) => {
      const order = (h: TaskHomework) =>
        h.timeState === 'ongoing' ? 0 : h.timeState === 'notStarted' ? 1 : h.timeState === 'ended' ? 2 : 3;
      if (order(a) !== order(b)) return order(a) - order(b);
      // 同组内：截止时间近的在前；都没有就按 id 稳定排序
      const ta = homeworkTime(a) ?? Number.MAX_SAFE_INTEGER;
      const tb = homeworkTime(b) ?? Number.MAX_SAFE_INTEGER;
      return ta - tb || a.id - b.id;
    };

    const sorted = [...pendingHw].sort(byUrgency);
    if (range !== 'all') return { recentHw: sorted, olderHw: [] as TaskHomework[] };

    /**
     * 「全部」时按"是否近三个月"拆开。
     * ⚠️ 两组各自排序，不能先拆再整体排 —— 那样组内顺序会乱。
     */
    const recent: TaskHomework[] = [];
    const older: TaskHomework[] = [];
    for (const h of sorted) {
      if (isRecentTask(homeworkTime(h), now)) recent.push(h);
      else older.push(h);
    }
    return { recentHw: recent, olderHw: older };
  }, [pendingHw, range]);

  return (
    <ScreenScroll>
      {/* 查询栏 */}
      <Section style={{ marginTop: spacing.sm }}>
        <Card style={{ padding: spacing.md }}>
          <Row justify="space-between" align="center" gap={spacing.md}>
            <Col flex={1} gap={2}>
              <Txt variant="body2" weight="medium">
                {queried ? `还有 ${total} 项没完成` : '点查询，找出没做完的作业与课件'}
              </Txt>
              <Txt variant="caption" c={color.text.tertiary}>
                {progress
                  ? `正在读取${progress.phase === 'homework' ? '作业' : '课件'} ${progress.done}/${progress.total} 门课…`
                  : queried
                    ? `作业 ${hwCount} · 课件 ${cwCount}`
                    : '会遍历你的所有课程'}
              </Txt>
            </Col>
            <Button label={busy ? '查询中…' : '查询'} onPress={() => void task.actions.query()} disabled={busy} />
          </Row>
        </Card>
      </Section>

      {task.error ? (
        <Section>
          <Banner
            tone="warning"
            title="查询有问题"
            message={task.error}
            actionLabel="重试"
            onAction={() => void task.actions.query()}
          />
        </Section>
      ) : null}

      {task.warnings.length > 0 ? (
        <Section>
          <Banner tone="warning" title="部分课程读取失败" message={task.warnings.join('；')} />
        </Section>
      ) : null}

      {/*
        ★ 第一层：时间范围（近三个月 / 全部）
        ⚠️ **只作用于未完成作业** —— 需求原话：
           「这个近三个月的设定只应用于未完成作业这一块」
           课件不参与（它是"随时能看"的资料，不该因为创建久了就消失），
           已提交的也不参与（历史记录不该被时间窗切掉）。
        所以这一行只在"有未完成作业"时才出现。
      */}
      {queried && allHw > 0 ? (
        <Section title="时间范围（只作用于作业）" style={{ marginTop: spacing.md }}>
          <Row style={{ backgroundColor: color.neutral[100], borderRadius: radius.md, padding: 4 }} gap={4}>
            {([
              ['recent', RECENT_WINDOW_LABEL],
              ['all', `全部 ${allHw}`],
            ] as const).map(([k, label]) => {
              const on = range === k;
              return (
                <Pressable
                  key={k}
                  onPress={() => setRange(k)}
                  style={{
                    flex: 1,
                    paddingVertical: 9,
                    borderRadius: radius.sm,
                    alignItems: 'center',
                    backgroundColor: on ? color.background.primary : 'transparent',
                  }}
                >
                  <Txt
                    variant="body2"
                    weight={on ? 'semibold' : 'regular'}
                    c={on ? color.primary[500] : color.text.secondary}
                  >
                    {label}
                  </Txt>
                </Pressable>
              );
            })}
          </Row>
          {range === 'recent' && hiddenByRange > 0 ? (
            <Txt variant="caption" c={color.text.tertiary} style={{ marginTop: 8, lineHeight: 17 }}>
              {`作业已按「${RECENT_WINDOW_LABEL}」筛选，另有 ${hiddenByRange} 项是更早的 —— 点「全部」可以看到（它们会单独成一块）。`}
            </Txt>
          ) : null}
          {range === 'all' && olderHw.length > 0 ? (
            <Txt variant="caption" c={color.text.tertiary} style={{ marginTop: 8, lineHeight: 17 }}>
              {`已显示全部作业。其中 ${olderHw.length} 项超过${RECENT_WINDOW_LABEL}，在下面单独成一块。`}
            </Txt>
          ) : null}
        </Section>
      ) : null}

      {/* 第二层：按类型 */}
      {queried && total + doneCount > 0 ? (
        <Section>
          <Row style={{ backgroundColor: color.neutral[100], borderRadius: radius.md, padding: 4 }} gap={4}>
            {([
              ['all', `全部 ${total}`],
              ['homework', `作业 ${hwCount}`],
              ['courseware', `课件 ${cwCount}`],
              ['done', `已提交 ${doneCount}`],
            ] as const).map(([k, label]) => {
              const on = filter === k;
              return (
                <Pressable
                  key={k}
                  onPress={() => setFilter(k)}
                  style={{
                    flex: 1,
                    paddingVertical: 9,
                    borderRadius: radius.sm,
                    alignItems: 'center',
                    backgroundColor: on ? color.background.primary : 'transparent',
                  }}
                >
                  <Txt variant="body2" weight={on ? 'semibold' : 'regular'} c={on ? color.primary[500] : color.text.secondary}>
                    {label}
                  </Txt>
                </Pressable>
              );
            })}
          </Row>
        </Section>
      ) : null}

      {busy && !queried ? (
        <Section>
          <Card>
            <Row justify="center" gap={spacing.sm} style={{ paddingVertical: spacing.lg }}>
              <ActivityIndicator color={color.primary[500]} />
              <Txt variant="body2" c={color.text.secondary}>
                正在遍历所有课程的作业与课件…
              </Txt>
            </Row>
          </Card>
        </Section>
      ) : null}

      {/*
        未完成作业 —— 用**筛选后**的 homeworks，不是 task.homeworks。
        ⚠️ 列表必须用筛选后的数据，否则筛选器"看着有反应、列表没变"。
           （这个坑踩过一次：起先只改了计数、没改列表。）

        「全部」时分成两组展示 —— 让切换的效果**肉眼可见**。
      */}
      {showHw && hwCount > 0 ? (
        <Section
          title={
            range === 'all' && olderHw.length > 0
              ? `未完成作业（${hwCount}，分两组）`
              : `未完成作业（${hwCount}）`
          }
        >
          <Card style={{ padding: 0 }}>
            {recentHw.map((h, i) => (
              <View key={`hw-${h.id}`}>
                <HomeworkRow h={h} />
                {i < recentHw.length - 1 || olderHw.length > 0 ? <Divider /> : null}
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      {/*
        ★ 更早的未完成作业 —— **只有「全部」才出现**。
        单独成块是为了让"点了全部"这件事在屏幕上立刻看得出来
        （之前只是数字变，用户以为筛选没生效）。
      */}
      {showHw && olderHw.length > 0 ? (
        <Section title={`更早的未完成作业（${olderHw.length}）`}>
          <Card style={{ padding: 0 }}>
            <Banner
              tone="info"
              title={`这 ${olderHw.length} 项已超过${RECENT_WINDOW_LABEL}`}
              message="它们还挂在待办里，但时间比较久了。如果已经不需要做，可以忽略；想收起来就切回「近三个月」。"
            />
            {olderHw.map((h, i) => (
              <View key={`hw-old-${h.id}`}>
                {i === 0 ? <Divider /> : null}
                <HomeworkRow h={h} />
                {i < olderHw.length - 1 ? <Divider /> : null}
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      {/* 未看完课件 */}
      {showCw && cwCount > 0 ? (
        <Section title={`未看完课件（${cwCount}）`}>
          <Card style={{ padding: 0 }}>
            {coursewares.map((c, i) => (
              <View key={`cw-${c.ocId}-${c.id}`}>
                <CoursewareRow c={c} />
                {i < coursewares.length - 1 ? <Divider /> : null}
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      {/* 已提交（参考用：确认哪些已经交过，避免误以为没交） */}
      {showDone && doneCount > 0 ? (
        <Section title={`已提交作业（${doneCount}）`}>
          <Card style={{ padding: 0 }}>
            {task.submittedHomeworks.map((h, i) => (
              <View key={`done-${h.id}`}>
                <HomeworkRow h={h} />
                {i < task.submittedHomeworks.length - 1 ? <Divider /> : null}
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      {/* 空状态 */}
      {queried && !busy && total === 0 ? (
        <Section>
          <Card>
            <EmptyState
              title={hiddenByRange > 0 ? '最近三个月没有未完成的' : '全部完成了'}
              hint={
                hiddenByRange > 0
                  ? `还有 ${hiddenByRange} 项是更早的没完成 —— 点上面的「全部」可以看到（它们不会丢）`
                  : doneCount > 0
                    ? `没有未完成的作业，也没有没看完的课件（已提交 ${doneCount} 项，可切到「已提交」查看）`
                    : '没有未完成的作业，也没有没看完的课件'
              }
            />
          </Card>
        </Section>
      ) : null}

      {!queried && !busy ? (
        <Section>
          <Card>
            <EmptyState title="还没有查询" hint="点上面「查询」开始 —— 会遍历所有课程" />
          </Card>
        </Section>
      ) : null}

      {queried && total > 0 ? (
        <Section>
          <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 18 }}>
            {'作业只列出「未提交」的；课件只列出学习进度不到 100% 的，已完成的不在这里显示。\n'}
            {`「时间范围」只筛作业 —— 课件不筛（它是随时能看的资料，不会因为创建久了就消失）。`}
          </Txt>
        </Section>
      ) : null}
    </ScreenScroll>
  );
}

/* ══════════════════ 行 ══════════════════ */

function HomeworkRow({ h }: { h: TaskHomework }) {
  const timeMeta =
    h.timeState === 'ongoing'
      ? { text: '进行中', fg: color.warning[600], bg: color.warning[50] }
      : h.timeState === 'notStarted'
        ? { text: '未开始', fg: color.text.tertiary, bg: color.neutral[100] }
        : h.timeState === 'ended'
          ? { text: '已截止', fg: color.error[600], bg: color.error[50] }
          : null;

  const typeLabel = h.type !== undefined ? HOMEWORK_TYPE_LABEL[h.type] : undefined;

  // 按真实提交状态显示，别写死
  const submitMeta =
    h.submitState === 'graded'
      ? { text: '已批改', fg: color.success[600], bg: color.success[50] }
      : h.submitState === 'submitted'
        ? { text: '已提交', fg: color.primary[600], bg: color.primary[50] }
        : { text: '未提交', fg: color.error[600], bg: color.error[50] };

  return (
    <Col style={{ padding: spacing.base }} gap={6}>
      <Txt variant="body2" weight="medium" numberOfLines={2}>
        {h.title || `#${h.id}`}
      </Txt>
      <Txt variant="small" c={color.text.tertiary} numberOfLines={1}>
        {h.courseName}
        {h.publisher ? ` · ${h.publisher}` : ''}
      </Txt>
      <Row justify="space-between" gap={spacing.sm} align="center">
        <Row gap={spacing.sm} align="center">
          {timeMeta ? <Badge text={timeMeta.text} fg={timeMeta.fg} bg={timeMeta.bg} /> : null}
          <Badge text={submitMeta.text} fg={submitMeta.fg} bg={submitMeta.bg} />
          {typeLabel ? (
            <Txt variant="small" c={color.text.tertiary}>
              {typeLabel}
            </Txt>
          ) : null}
        </Row>
        <Row gap={spacing.sm} align="center">
          {typeof h.score === 'number' ? (
            <Txt variant="body2" weight="bold" c={color.error[500]}>
              {h.score}
            </Txt>
          ) : null}
          {h.endTime ? (
            <Txt variant="small" c={color.text.tertiary}>
              {formatDateTime(h.endTime)} 截止
            </Txt>
          ) : null}
        </Row>
      </Row>
    </Col>
  );
}

function CoursewareRow({ c }: { c: TaskCourseware }) {
  const pct = Math.max(0, Math.min(100, Math.round(c.studyProgress ?? 0)));
  const untouched = pct <= 0;

  return (
    <Col style={{ padding: spacing.base }} gap={6}>
      <Txt variant="body2" weight="medium" numberOfLines={2}>
        {c.title || `#${c.id}`}
      </Txt>
      <Txt variant="small" c={color.text.tertiary} numberOfLines={1}>
        {c.courseName}
        {c.resourceTypeName ? ` · ${c.resourceTypeName}` : ''}
      </Txt>

      {/* 进度条 */}
      <Row gap={spacing.sm} align="center">
        <View
          style={{
            flex: 1,
            height: 6,
            borderRadius: 3,
            backgroundColor: color.neutral[200],
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${pct}%`,
              height: '100%',
              borderRadius: 3,
              backgroundColor: pct >= 50 ? color.primary[400] : color.warning[500],
            }}
          />
        </View>
        <Txt variant="small" c={color.text.tertiary}>
          {pct}%
        </Txt>
      </Row>

      <Row justify="space-between" align="center">
        <Txt variant="small" c={color.text.tertiary}>
          {untouched ? '还没开始看' : '看到一半'}
          {c.viewTimes ? ` · 打开过 ${c.viewTimes} 次` : ''}
        </Txt>
        {c.duration ? (
          <Txt variant="small" c={color.text.tertiary}>
            时长 {formatDuration(c.duration)}
          </Txt>
        ) : null}
      </Row>
    </Col>
  );
}

/* ══════════════════ 工具 ══════════════════ */

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatDuration(sec: number): string {
  if (sec >= 3600) return `${(sec / 3600).toFixed(1)} 小时`;
  if (sec >= 60) return `${Math.round(sec / 60)} 分钟`;
  return `${sec} 秒`;
}
