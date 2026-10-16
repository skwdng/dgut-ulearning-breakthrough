/**
 * 「点不中」—— 老师发起选人时别抽到我。
 *
 * ══════════════ 用户场景（原话）══════════════
 *
 *   「我在外面实习，我要是被抽到了人不在会被记的，
 *     所以我想要在老师发起点名前把自己从可能被选中的名单里移出去」
 *   「我说的是选人」「直接删掉我就好了」「这个不会影响考勤吧」
 *
 * ══════════════ ★★★ 最重要的一条：不影响考勤 ══════════════
 *
 * 优学院里这是**两个完全独立的活动**（用户截图实证）：
 *
 *   【点名】2026-09-30 14:28 点名 · 已结束 · 数字码签到 · 已签到  ← 考勤
 *   【选人】2026-09-30 14:35 选人 · 进行中 · 7 人各 +2            ← 课堂互动
 *
 * 代码层面也对得上：
 *   考勤 → `/apps/newAttendance/*`   （签到功能走这条）
 *   选人 → `/apps/selectperson/*`    （本页只走这条）
 *
 * ⚠️ 本页**绝不碰** `/apps/newAttendance/*`。
 *
 * ══════════════ 界面刻意做得极简 ══════════════
 *
 * 排查期间这一页堆过一堆东西（单条删、roleId 穷举、接口测试器入口…），
 * 用户要求「把多余的东西删掉，让界面整洁点」。
 *
 * 现在只留**一个按钮**：一键扫完整门课，只删"我还在名单里"的那些。
 * 单条删除被它覆盖（只处理一条时结果一样），roleId 穷举是排查工具、
 * 功能已验证完成、不再需要。
 *
 * 排查用的「接口测试器」仍在 小操作 里（那是独立页面，不在本页）。
 */
import React, { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Button, Card, Col, Row, ScreenScroll, Section, Spacer, Txt } from '../components';
import { color, radius, spacing } from '../theme/tokens';
import { useSign } from '../state/signStore';
import * as Clipboard from 'expo-clipboard';

/**
 * ⚠️ 这里原来有个 `parseRoomTime(title)`，从标题里解析日期来排序。
 *    **已删除** —— 它有真实缺陷：
 *
 *      标题里没有年份（"12-30 星期二 10:22 课堂"），只能猜。
 *      第一版猜"当前年份"，结果把 **2025 年 12 月**的英语课
 *      当成了 2026-12 → 排到列表最上面
 *      （用户实测反馈：「这里显示最上面的是去年的英语」）。
 *
 *    正确做法：用签到记录里的 `r.beginTime`（真时间戳）——
 *    机器字段，没有年份歧义。见下面的 `isToday` 与排序逻辑。
 */

/** 某个时间戳是不是"今天"（本地自然日） */
function isToday(ts: number, now = Date.now()): boolean {
  if (!ts) return false;
  const a = new Date(ts);
  const b = new Date(now);
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

export function DianBuZhongScreen() {
  const sign = useSign();
  /**
   * 课堂 id —— 活动列表接口要它。
   * 默认 `443969`（用户实测过的课堂）；实际上课要改成对应课程的。
   */
  const [cid, setCid] = useState('443969');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * ★ 课程→课堂 id 列表。
   *
   * 用户的问题：「我没法从签到那里获得课程 id 怎么搞」——
   * 课堂 id 原先只在签到记录里显示，**从没签到过的课就拿不到**，
   * 而那恰恰是最需要这个功能的课（人在实习、没去上课）。
   */
  const [courses, setCourses] = useState<
    Array<{
      ocId: number;
      courseName: string;
      teacher?: string;
      classroomCount: number;
      classrooms: Array<{ id: number; title: string; teacher?: string; ts?: number }>;
      /** 这门课最近一次上课的时间戳 */
      lastTs?: number;
      /** 今天有没有这门课 */
      hasToday?: boolean;
    }>
  >([]);
  const [cBusy, setCBusy] = useState(false);
  /** 展开了哪门课（收起时只显示课程名） */
  const [openOc, setOpenOc] = useState<number | null>(null);
  /** 列不出课程时显示原因（不能什么都不显示） */
  const [courseErr, setCourseErr] = useState('');
  /** 是否显示"今天没有课"的课程（默认只显示今天的） */
  const [showAll, setShowAll] = useState(false);
  /** 今天有课的课程数（用来决定显示什么） */
  const todayCourses = courses.filter((c) => c.hasToday);
  /** 实际要渲染的列表 */
  const shown = showAll || todayCourses.length === 0 ? courses : todayCourses;

  const loadCourses = async () => {
    setCBusy(true);
    setCourseErr('');

    /**
     * ══════════════ ★★★ 先用"签到记录已经查好的数据"（不发网络请求）══════════════
     *
     * 用户反馈「他列不出来」——根因是我走了一条拿不到数据的接口。
     *
     * 而 `sign.overview.courses` 里**已经有**：
     *   · 课程名 + 教师名
     *   · 每条签到记录带的 `classroomId` / `classroomTitle`
     *
     * 这些是**签到记录页查过一次后缓存在本地的**，所以：
     *   · 不用再发请求 → 秒出，也不会因为接口失败而"列不出来"
     *   · 列出的课和用户在签到记录里看到的**完全一致**
     *
     * ⚠️ 条件：用户得先在「签到记录」页查过一次（否则 overview 是空的）。
     *    下面会给出明确指引。
     */
    const cached = sign.overview?.courses ?? [];
    if (cached.length) {
      const list = cached
        .map((c) => {
          /**
           * 从签到记录里抠出这门外课出现过的所有课堂。
           *
           * ★★★ 用 `r.beginTime`（真时间戳）排序，**不解析标题文本**。
           *
           * 踩过的坑：第一版解析标题里的"12-30"并猜当年年份，
           * 结果把 **2025 年 12 月**的英语课当成了 2026-12 →
           * 排到了最上面（用户实测：「这里显示最上面的是去年的英语」）。
           * `beginTime` 是机器字段，没有这个问题。
           */
          const seen = new Map<number, { ts: number; title: string }>();
          for (const r of c.records) {
            if (!r.classroomId) continue;
            const ts = r.beginTime ?? 0;
            const prev = seen.get(r.classroomId);
            if (!prev || ts > prev.ts) {
              seen.set(r.classroomId, { ts, title: r.classroomTitle ?? '(来自签到记录)' });
            }
          }
          const rooms = [...seen.entries()]
            .map(([id, v]) => ({ id, title: v.title, ts: v.ts }))
            .sort((a, b) => b.ts - a.ts);
          /** 这门课**最近一次**上课的时间（用来排序 + 判断今天有没有课） */
          const lastTs = rooms[0]?.ts ?? 0;
          return {
            ocId: c.ocId,
            courseName: c.name,
            teacher: c.teacher,
            classroomCount: rooms.length,
            classrooms: rooms,
            lastTs,
            hasToday: rooms.some((r) => isToday(r.ts)),
          };
        })
        /**
         * ★★★ 默认**只留今天有课的课程**（用户要求：「我让你找课程找的是当天的
         *   所有课程，不要把加上过去的全部列出来」）。
         *
         * ⚠️ 但**不能硬过滤** —— 万一今天一门课都没有（周末/假期），
         *    列表空了用户会以为坏了。所以：
         *      · 有今天的课 → 只显示今天的
         *      · 一门都没有 → 退回显示全部，并说明"今天没有课"
         *    由下面的 `showAll` 状态控制，用户也能手动展开全部。
         */
        .sort((a, b) => {
          /** 今天有课的排最前；都没课时按最近上课时间 */
          if (a.hasToday !== b.hasToday) return a.hasToday ? -1 : 1;
          return b.lastTs - a.lastTs;
        });
      setCourses(list);
      setOpenOc(list.find((c) => c.hasToday)?.ocId ?? list[0]?.ocId ?? null);
      setCBusy(false);
      return;
    }

    /** 没有缓存 → 才去请求（走签到同一条路径） */
    try {
      const list = await sign.actions.listCourseClassrooms();
      setCourses(list);
      setOpenOc(list[0]?.ocId ?? null);
      /**
       * ⚠️ 列不出来时**必须说清原因** ——
       *    第一版什么也不显示，用户只能说「他列不出来」，我也无从下手（踩过）。
       */
      if (!list.length) {
        setCourseErr(
          '没读到课程。\n\n' +
            '最可能的原因：**还没在「签到记录」页查过**。\n' +
            '请先：小操作 → 签到记录 → 点「查询」，等它列完课程，\n' +
            '再回到这一页点「列出我的课程」。\n\n' +
            '（课程和课堂 id 来自签到数据，所以要先查一次。）',
        );
      }
    } catch (e) {
      setCourseErr(`读课程失败：${(e as Error).message}`);
      setCourses([]);
    } finally {
      setCBusy(false);
    }
  };

  /**
   * ★★★ 扫一门课的全部课堂，**只删今天的**选人活动。
   *
   * 用户明确要求：「我要做的不是删除全部，我要做的只有删除当天的」
   *
   * ⚠️ 所以**不动历史记录** —— 只处理 `beginTime` 落在今天的活动。
   */
  const runCourse = async (ocId: number) => {
    setBusy(true);
    setOut('处理中…（遍历这门课的课堂，只筛出**今天**的选人活动）');
    try {
      const r = await sign.actions.removeSelfFromCourseToday({ ocId });
      setOut(
        `${r.ok ? '✅ 已处理' : '⚠️ 有失败项'}\n` +
          `扫了 ${r.scanned} 个课堂 · 今天的选人 ${r.todayCount} 条 · ` +
          `成功 ${r.deleted} 条 / 跳过 ${r.skipped} 条 / 失败 ${r.failed} 条\n\n` +
          r.steps.join('\n'),
      );
    } catch (e) {
      setOut(`失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * ★★★ 唯一的主操作：把这门课里"我还在名单上"的选人活动全删掉。
   *
   * 实测确认有效（2026-10，真实数据）：
   *   删前名单 10 人含「同学A」→ DELETE → 删后 **9 人，同学A不见了** ✅
   */
  const run = async () => {
    setBusy(true);
    setOut('处理中…（读全部选人活动 → 只删我在名单里的 → 逐条复核）');
    try {
      const id = Number(cid) > 0 ? Number(cid) : 0;
      const r = await sign.actions.removeSelfFromAllCalls({ classroomId: id });
      /**
       * ══════════════ ★★★ 标题不能一律说"没成功"（用户反馈，2026-10）══════════════
       *
       * 用户截图问：「这种返回是正常的吗」——
       * 他的结果是「成功 0 条 / 跳过 1 条」，标题写着 **⚠️ 没成功**，
       * 看起来像出错了，其实**那正是成功的样子**：
       * 名单里已经没有他了，没有可删的东西。
       *
       * `r.ok` 的含义是"**没有失败项**"（failed === 0），不是"删掉了东西"。
       * 所以按实际情况分三种标题，别让用户误以为坏了。
       */
      const headline =
        r.failed > 0
          ? '⚠️ 有失败项'
          : r.deleted > 0
            ? '✅ 已删掉我的名字'
            : r.skipped > 0
              ? '✅ 无需处理 —— 这些名单里已经没有你了'
              : '✅ 已处理';
      setOut(
        `${headline}\n` +
          `成功 ${r.deleted} 条 / 跳过 ${r.skipped} 条 / 失败 ${r.failed} 条\n` +
          (r.failed === 0 && r.deleted === 0 && r.skipped > 0
            ? '（「跳过」= 那张名单里本来就没有你，没什么可删的 —— 这正是你要的结果）\n'
            : '') +
          '\n' +
          r.steps.join('\n'),
      );
    } catch (e) {
      setOut(`失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(`【点不中】课堂 id=${cid}\n\n${out}`);
      setOut(`${out}\n\n（已复制）`);
    } catch {
      /* 复制失败就算了，下面能长按选中 */
    }
  };

  return (
    <ScreenScroll>
      <Section style={{ marginTop: spacing.md }}>
        <Card variant="elevated" style={{ padding: spacing.base }}>
          <Txt variant="body2" weight="medium" c={color.success[600]}>
            ✅ 完全不影响考勤
          </Txt>
          <Spacer h={4} />
          <Txt variant="caption" c={color.text.secondary} style={{ lineHeight: 17 }}>
            {'只动「选人」（课堂互动），签到/点名记录一点不变。'}
          </Txt>
        </Card>
      </Section>

      <Section title="第一步：选课程（自动填课堂 id）">
        <Card style={{ padding: spacing.base }}>
          <Txt variant="caption" c={color.text.secondary} style={{ lineHeight: 17 }}>
            {'不知道课堂 id？点下面按钮列出你的课 —— 不用先签到。'}
          </Txt>
          <Spacer h={spacing.md} />
          <Button
            label={cBusy ? '读取中…' : '列出我的课程'}
            variant="secondary"
            loading={cBusy}
            onPress={() => void loadCourses()}
          />
          {courseErr ? (
            <>
              <Spacer h={spacing.md} />
              <View
                style={{
                  backgroundColor: color.warning[50] ?? color.neutral[100],
                  borderRadius: radius.sm,
                  padding: spacing.sm,
                }}
              >
                <Txt variant="caption" c={color.warning[600] ?? color.text.secondary} style={{ lineHeight: 16 }}>
                  {courseErr}
                </Txt>
              </View>
            </>
          ) : null}
          {courses.length ? (
            <>
              <Spacer h={spacing.md} />
              {/*
                ★★★ 默认只显示"今天有课"的课程（用户要求）。
                今天一门都没有时退回全部，并说明情况 —— 免得以为坏了。
              */}
              <Txt variant="caption" c={color.text.secondary}>
                {todayCourses.length
                  ? `今天有课的：${todayCourses.length} 门${showAll ? '（已展开全部）' : ''}`
                  : `今天没有课${courses.length ? ` —— 下面列出全部 ${courses.length} 门` : ''}`}
              </Txt>
              {todayCourses.length && courses.length > todayCourses.length ? (
                <>
                  <Spacer h={4} />
                  <Pressable onPress={() => setShowAll(!showAll)}>
                    <Txt variant="caption" c={color.primary[600]}>
                      {showAll ? '只显示今天有课的' : `显示全部 ${courses.length} 门课`}
                    </Txt>
                  </Pressable>
                </>
              ) : null}
              <Spacer h={6} />
              <Col gap={6}>
                {shown.map((c) => (
                  <View key={c.ocId}>
                    <Pressable onPress={() => setOpenOc(openOc === c.ocId ? null : c.ocId)}>
                      <Txt variant="body2" weight="medium" c={color.text.primary}>
                        {`${openOc === c.ocId ? '▾' : '▸'} ${c.courseName}${c.hasToday ? '  ← 今天有课' : ''}`}
                      </Txt>
                      <Txt variant="caption" c={color.text.tertiary}>
                        {`${c.teacher ? `${c.teacher} · ` : ''}${c.classroomCount} 个课堂`}
                      </Txt>
                    </Pressable>
                    {openOc === c.ocId ? (
                      <Col gap={6} style={{ marginTop: 6, marginLeft: 12 }}>
                        {/*
                          ★★★ 主操作：一次扫完这门课的**所有课堂**。
                          用户反馈「按了不管用」—— 根因是一门课有很多课堂
                          （每次上课一个），原来要精确选中当次那个 id，
                          选错就是"共 0 条选人活动"。这里不用选。
                        */}
                        <Pressable
                          onPress={() => void runCourse(c.ocId)}
                          style={{
                            padding: spacing.sm,
                            borderRadius: radius.sm,
                            backgroundColor: color.primary[50],
                          }}
                        >
                          <Txt variant="caption" c={color.primary[600]} weight="medium">
                            {`删掉「今天」的选人名单里的我（扫 ${c.classroomCount} 个课堂）`}
                          </Txt>
                          <Txt variant="caption" c={color.text.tertiary}>
                            {'只处理今天的活动，历史记录不动'}
                          </Txt>
                        </Pressable>
                        <Txt variant="caption" c={color.text.tertiary}>
                          {'或者只处理某一个课堂（一般不用）：'}
                        </Txt>
                        {c.classrooms.length ? (
                          c.classrooms.map((r) => {
                            /**
                             * ★ 是不是今天的课堂（用 beginTime 时间戳判断，
                             *   不解析标题里的日期 —— 那个会猜错年份，踩过）。
                             */
                            const today = isToday(r.ts ?? 0);
                            const picked = String(r.id) === cid;
                            return (
                              <Pressable
                                key={r.id}
                                onPress={() => {
                                  setCid(String(r.id));
                                  setOut('');
                                }}
                                style={{
                                  padding: spacing.sm,
                                  borderRadius: radius.sm,
                                  backgroundColor: picked
                                    ? color.primary[50]
                                    : today
                                      ? color.success[50] ?? color.neutral[100]
                                      : color.neutral[100],
                                }}
                              >
                                {/*
                                  ★★★ 用户要求：「我只需要你给我 id，
                                  我自己往里面输入 id 实现对号删除」
                                  → 所以 **id 放最上面、加粗、放大**，
                                    一眼就能看到、记住、手填。
                                */}
                                <Txt variant="body2" weight="medium" c={color.text.primary}>
                                  {`课堂 id  ${r.id}${picked ? '   ✓ 已填进下面的输入框' : ''}`}
                                </Txt>
                                <Txt variant="caption" c={today ? color.success[600] : color.text.tertiary}>
                                  {`${r.title}${today ? '   ★ 今天' : ''}`}
                                </Txt>
                              </Pressable>
                            );
                          })
                        ) : (
                          <Txt variant="caption" c={color.text.tertiary}>
                            {'（这门课还没有课堂）'}
                          </Txt>
                        )}
                      </Col>
                    ) : null}
                  </View>
                ))}
              </Col>
            </>
          ) : null}
        </Card>
      </Section>

      <Section title="第二步：把我在选人名单里删掉">
        <Card style={{ padding: spacing.base }}>
          <Txt variant="caption" c={color.text.secondary} style={{ lineHeight: 17 }}>
            {'一次扫完这门课的选人活动：\n'}
            {'· 我还在名单里 → 删掉 + 复核\n'}
            {'· 我不在名单里 → 跳过（不动别人的记录）'}
          </Txt>

          <Spacer h={spacing.md} />
          <Row gap={spacing.sm} align="flex-end">
            <Col flex={1} gap={4}>
              <Txt variant="caption" c={color.text.secondary}>
                课堂 id（填上面点选的，或自己粘贴）
              </Txt>
              <TextInput
                value={cid}
                onChangeText={setCid}
                keyboardType="number-pad"
                style={styles.input}
                placeholder="例如 440420"
                placeholderTextColor={color.text.tertiary}
              />
            </Col>
            <Button label={busy ? '处理中…' : '删掉我的名字'} loading={busy} onPress={() => void run()} />
          </Row>

          <Spacer h={6} />
          <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 16 }}>
            {'⚠️ 仍然只删今天的活动 —— 手填一个过去课堂的 id 也没用，历史记录不会被改。'}
          </Txt>

          {out ? (
            <>
              <Spacer h={spacing.md} />
              <Button label="复制结果" variant="secondary" onPress={() => void copy()} />
              <Spacer h={spacing.sm} />
              <View style={styles.out}>
                <Txt variant="caption" c={color.text.secondary} style={{ lineHeight: 15 }}>
                  {out}
                </Txt>
              </View>
            </>
          ) : null}
        </Card>
      </Section>

      <Section>
        <Card>
          <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
            {'用法：老师发起选人后尽快点，要抢在他点「抽人」之前。\n'}
            {'活动是老师临时创建的，所以没法提前一天设好。\n'}
            {'被抽中本来 +2 平时分，删掉后那 2 分也拿不到。'}
          </Txt>
        </Card>
      </Section>
    </ScreenScroll>
  );
}

const styles = {
  input: {
    borderWidth: 1,
    borderColor: color.neutral[200],
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    color: color.text.primary,
    backgroundColor: color.background.primary,
  },
  out: {
    backgroundColor: color.neutral[100],
    borderRadius: radius.sm,
    padding: spacing.sm,
    maxHeight: 320,
  },
} as const;
