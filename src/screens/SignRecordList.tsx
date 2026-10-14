/**
 * 签到记录列表 —— 任务查询 / 扫码签到 / 地点签到 三个页面共用。
 *
 * 共用原因：三者本质是同一份数据（优学院发起过的点名），
 * 只是筛选条件不同：
 *   任务查询   → 全部方式
 *   扫码签到   → 只看 type=1（二维码）
 *   地点签到   → 只看 type=0（位置）
 *
 * 排序统一：**未签到的在最上面**，同组内按点名发起时间升序（越早越往上）。
 *
 * 关于"改状态"：
 *   学生端只能把状态改成「已签到」（调 signByStu）。
 *   改成缺勤/迟到/请假是教师接口，学生账号无权限 —— 界面上会说明。
 *   点名活动已结束（activityState !== '1'）也无法再改。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View } from 'react-native';
import { Badge, Banner, Button, Card, Col, Divider, EmptyState, Row, Section, Spacer, Txt } from '../components';
import { color, radius, spacing } from '../theme/tokens';
import { SIGN_STATUS_GROUPS, SIGN_STATUS_OPTIONS } from '../services/checkin/signApi';
import { useSign } from '../state/signStore';
import { useCheckin } from '../state/checkinStore';
import { useUnlock } from '../state/unlockStore';
import {
  SIGN_METHOD_META,
  SIGN_STATE_META,
  isReallyOngoing,
  isSignedState,
  relativeTime,
  signBadge,
  type SignDetail,
  type SignMethod,
} from '../domain/checkin';
import { useRouter } from '../nav/router';

export type RecordFilter = 'unsigned' | 'signed';

/**
 * 学号打码：保留前 4 位 + 后 4 位 —— 完整学号不出现在界面上。
 *
 * ⚠️ 为什么是"后 4 位"而不是"后 2 位"：
 *    踩过的坑 —— 用户截图里显示 `2025****24`，
 *    而他朋友的学号是 `…0114`、另一个候选是 `…0124`，
 *    **后 2 位根本分不清是谁**，导致排查时无法确认"当前到底登的谁"。
 *    留 4 位既能区分，又不至于把完整学号暴露出来。
 */
function maskStudentIdLocal(sid: string): string {
  if (!sid) return '（未知）';
  if (sid.length <= 8) return sid;
  return `${sid.slice(0, 4)}****${sid.slice(-4)}`;
}

/**
 * ⚠️ `isReallyOngoing` 与 `ONGOING_MAX_AGE_MS` 已移到 `src/domain/checkin.ts`。
 *    store 统计"进行中的点名有几个"时也要用它 ——
 *    留在页面组件里会导致 store 反向 import 页面（循环依赖）。
 */

interface Props {
  /** 只看某种签到方式；不传表示全部 */
  onlyMethod?: SignMethod;
  /** 头部说明 */
  intro?: string;
  /** 是否显示"改状态"操作 */
  allowChange?: boolean;
  /** 是否显示「一键签到」—— 已废弃（批量不可控），保留字段只为兼容旧调用 */
  showOneshot?: boolean;
  /** 数据为空时的引导文案 */
  emptyHint?: string;
}

export function SignRecordList({
  onlyMethod,
  intro,
  allowChange = false,
  emptyHint,
}: Props) {
  const sign = useSign();
  const { account } = useCheckin();
  const { entitled, serverAuth, serverAuthMessage, scope, result: codeResult } = useUnlock();
  /**
   * 授权码「不属于当前学号」。
   *
   * 这是"登录别人的账号"最典型的表现：码是自己那份，但当前登录的是别人，
   * 于是码里的学号哈希对不上 → `checkCodeForStudent` 返回 mismatch。
   */
  const unmatched = codeResult?.status === 'mismatch';
  const router = useRouter();
  const [filter, setFilter] = useState<RecordFilter>('unsigned');
  /** 方式筛选；默认「全部方式」—— 只看扫码会漏掉位置/数字码的记录 */
  const [methodFilter, setMethodFilter] = useState<'all' | SignMethod>('all');
  /** 哪条记录正在保存（行内按钮转圈用） */
  const [busyId, setBusyId] = useState<number | null>(null);
  /**
   * ★ 弹窗内"刚改成功的那个状态"。
   *
   * ══════════════ 需求（用户 2026-10）══════════════
   * 「每个状态后面加个修改按钮，被修改的状态后面按钮从修改变成已修改」
   *
   * 所以状态**不再点一下就自动提交**（列表行本身）——
   * 而是每行右边有个「修改」按钮，点了才提交；
   * 提交成功的那个状态，按钮变成「已修改」（并禁用，避免重复提交）。
   *
   * ⚠️ 存的是 status 值而不是布尔 —— 要能区分"哪一行"改成功了。
   */
  const [modifiedStatus, setModifiedStatus] = useState<number | null>(null);
  /** 弹窗内正在提交哪个状态（避免连点） */
  const [applyingStatus, setApplyingStatus] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  /**
   * ★ 探测的**原始结果**（不再存格式化文本）。
   *
   * ⚠️ 与 `result` 分开存：`result` 是给用户看的一句话提示，
   *    而这里是**给我看的原始数据**。混在一起会让 Banner 被撑爆。
   *    存原始结果是为了能切"精简 / 详细"两种复制格式。
   */
  /** 下面展示的那段文本用不用详细模式（默认精简，避免一屏几千字） */
  /** 正在改状态的那条记录（弹状态选择面板） */
  const [statusTarget, setStatusTarget] = useState<SignDetail | null>(null);
  /** 「其他」是否展开 */
  const [subOpen, setSubOpen] = useState(false);

  const all = sign.overview?.allRecords ?? [];
  const progress = sign.progress;
  const busy = sign.loading || progress !== null;

  /**
   * 方式过滤。
   *
   * `onlyMethod`（外部传入）优先 —— 扫码签到页只看扫码；
   * 否则用界面上的「全部方式 / 扫码 / 位置 / 数字码 / 一键」筛选，
   * 这样在同一个页面里就能看到并修改**所有课程**的记录。
   */
  const records = useMemo(() => {
    if (onlyMethod) return all.filter((r) => r.method === onlyMethod);
    if (methodFilter === 'all') return all;
    return all.filter((r) => r.method === methodFilter);
  }, [all, onlyMethod, methodFilter]);

  /**
   * 排序 —— ★ 进行中的**必须置顶**。
   *
   * ══════════ 踩过的坑 ══════════
   * 原先「未签到」是按发起时间**升序**（越早越靠上），理由是"先处理拖得久的"。
   * 但那会导致一个很糟的体验：
   *   老师**刚发起**的点名，会因为时间最新而排在**最底下**，
   *   上面压着一堆早就过期、根本签不了的历史记录 ——
   *   而点名是有时限的，用户恰恰最需要看到刚发的那个。
   *
   * 现在：
   *   ① 进行中且未签到 → 最前，且组内**从新到旧**（刚发起的最靠上）
   *   ② 其余未签到     → 按时间**从新到旧**（近期的更可能还有救）
   */
  const sorted = useMemo(() => {
    const t = (r: SignDetail) => r.beginTime ?? r.createDate ?? 0;
    const list = records.filter((r) => !isSignedState(r.state));
    const ongoingList = list.filter((r) => isReallyOngoing(r)).sort((a, b) => t(b) - t(a));
    const otherList = list.filter((r) => !isReallyOngoing(r)).sort((a, b) => t(b) - t(a));
    const signedList = records.filter((r) => isSignedState(r.state)).sort((a, b) => t(b) - t(a));
    return [...ongoingList, ...otherList, ...signedList];
  }, [records]);

  /** 进行中且未签到的（用于顶部提醒） */
  const ongoing = useMemo(
    () => records.filter((r) => !isSignedState(r.state) && isReallyOngoing(r)),
    [records],
  );

  const unsigned = useMemo(() => sorted.filter((r) => !isSignedState(r.state)), [sorted]);
  const signed = useMemo(() => sorted.filter((r) => isSignedState(r.state)), [sorted]);
  const list = filter === 'unsigned' ? unsigned : signed;

  const query = useCallback(async () => {
    await sign.actions.query();
  }, [sign.actions]);

  /** 把某条记录改成已签到 */
  const changeToSigned = async (r: SignDetail) => {
    setBusyId(r.attendanceID);
    setResult(null);
    try {
      const res = await sign.actions.signByMethod({
        attendanceID: r.attendanceID,
        classID: r.classes[0]?.classID,
        method: r.method,
      });
      setResult(res.ok ? '已改为「已签到」' : `改失败：${res.message ?? '未知原因'}`);
      if (res.ok) void query();
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 「改签到状态」—— 打开状态选择面板。
   *
   * 思路（来自用户提示："教师端可以随意操作"）：
   *   学生端 `signByStu` 只能设成「已签到」；
   *   缺勤/迟到/早退/请假 属于教师权限。
   *   但学生端源码里**打包了教师端接口**（signByTea 等），
   *   能不能调通要看服务端角色校验 —— 所以真去试，并把返回原样给人看。
   */
  const changeStatus = (r: SignDetail) => {
    /** 打开新一条时把上一次的"已修改/结果"清掉 —— 否则会串到这条记录上 */
    setModifiedStatus(null);
    setResult(null);
    setSubOpen(false);
    setStatusTarget(r);
  };

  /**
   * 关掉「改状态」弹窗时清掉临时状态。
   *
   * ⚠️ 必须清 —— 否则下次打开会看到上次那条记录的「已修改」标记，
   *    用户会以为新记录已经改过了。
   */
  const closeStatusModal = () => {
    setStatusTarget(null);
    setModifiedStatus(null);
    setApplyingStatus(null);
    setSubOpen(false);
    setResult(null);
  };



  /**
   * 用户选定目标状态后，用**已验证可用**的教师接口改。
   *
   * 实测（参数矩阵跑出来的结论）：
   *   `POST /apps/newAttendance/signByTea { attendanceID, users:[{userID,status}] }`
   *   → HTTP 200 · {"msg":"签到成功","status":"success"}
   *
   * 它对学生账号**没被权限拦住**，而且**不做时间校验** ——
   * 在一条 2022 年"已结束"的记录上也改成功了（学生接口对同样记录返回 202）。
   *
   * ══════════════ ★ 需求变更（用户 2026-10）══════════════
   * 「每个状态后面加个修改按钮，被修改的状态后面按钮从修改变成已修改」
   *
   * 所以现在：
   *   · 状态行**点一下不再自动提交** —— 每行右边有个「修改」按钮
   *   · 点「修改」才提交
   *   · 提交成功的那个状态 → 按钮变「已修改」并禁用（防重复提交）
   *   · **弹窗不再自动关闭** —— 用户可能想连续改几个状态看结果
   */
  const applyStatus = async (status: number) => {
    const r = statusTarget;
    if (!r) return;
    /**
     * ⚠️ 这里**不再** setStatusTarget(null) / setSubOpen(false) ——
     *    原先是"点一下就提交并关窗"，现在要留在弹窗里
     *    让用户看到"已修改"的反馈。
     */
    setApplyingStatus(status);
    setBusyId(r.attendanceID);
    setResult(null);
    try {
      const res = await sign.actions.setStatus({
        attendanceID: r.attendanceID,
        classID: r.classes[0]?.classID,
        status,
        // 这条记录属于谁 —— 个人码权限下只能等于自己，否则被拒。
        // 本 App 只能看到自己的记录，所以恒等于当前登录者；
        // 显式传进去是为了让"范围检查"真的生效（而不是靠调用方自觉）。
        targetUserId: account?.userId,
      });
      const label = SIGN_STATUS_OPTIONS.find((o) => o.status === status)?.label ?? String(status);
      if (res.ok) {
        /** ★ 成功 → 标记这一行，按钮会变成「已修改」 */
        setModifiedStatus(status);
        setResult(`已改成「${label}」\n${res.message}`);
        void query();
      } else {
        /**
         * ⚠️ 失败**不标记**成"已修改" —— 否则用户以为改成功了。
         *    只是把失败原因显示出来。
         */
        setResult(`改成「${label}」没有成功\n${res.message}`);
      }
    } catch (e) {
      setResult(`改状态失败：${(e as Error).message}`);
    } finally {
      setApplyingStatus(null);
      setBusyId(null);
    }
  };

  /**
   * 一键签到**已移除**。
   *
   * 原因：批量改状态不可控（用户明确要求关闭），而且学生端只能改成「已签到」，
   * 批量提交会刷出一堆无意义的失败。现在只能逐条操作。
   */

  return (
    <>
      {/* 没绑账号时直接给引导，不让人对着一个必然失败的「查询」按钮点 */}
      {!account ? (
        <Section style={{ marginTop: spacing.sm }}>
          <Card>
            <EmptyState title="还没有绑定优学院账号" hint="签到数据来自优学院，需要先登录一次" />
            <Spacer h={spacing.md} />
            <Button label="去绑定" onPress={() => router.push('/youxue-bind')} />
          </Card>
        </Section>
      ) : null}

      {intro ? (
        <Section style={{ marginTop: spacing.sm }}>
          <Card style={{ padding: spacing.md }}>
            <Txt variant="small" c={color.text.secondary} style={{ lineHeight: 19 }}>
              {intro}
            </Txt>
          </Card>
        </Section>
      ) : null}

      {/*
        ── 授权状态提示 ──
        ⚠️ 只在**已经能看到本页**（也就是已经填过码）时才显示。
        没填码的人根本进不来，所以这里不算"暴露签到功能"。
      */}
      {account && (!entitled || serverAuth === 'denied' || unmatched) ? (
        <Section style={{ marginTop: spacing.sm }}>
          <Banner
            tone="error"
            title={unmatched ? '授权码不属于当前登录的学号' : '签到未授权'}
            message={
              unmatched
                ? `这个授权码是发给**另一个学号**的。\n\n` +
                  `当前登录：${maskStudentIdLocal(account.studentId)}\n\n` +
                  `授权码与学号绑定 —— 换账号登录就会失效。` +
                  `如果这不是你的账号，请在「优学院 → 换账号」里登回自己的。`
                : serverAuth === 'denied'
                  ? `${serverAuthMessage}\n\n请联系管理员在管理页重新开启授权。`
                  : '当前账号没有可用的授权。'
            }
          />
        </Section>
      ) : null}

      {/*
        权限范围提示 —— 让人清楚自己现在能改谁的。
        万能码 → 可改任何人；个人码 / 万能码失效后降级 → 只能改自己。
      */}
      {account && entitled ? (
        <Section style={{ marginTop: spacing.sm }}>
          <Card style={{ padding: spacing.md }}>
            <Row justify="space-between" align="center" gap={spacing.md}>
              <Col flex={1} gap={2}>
                <Txt variant="body2" weight="medium">
                  {scope === 'all' ? '万能码权限 · 可改任何人的状态' : '个人授权码权限 · 只能改自己的'}
                </Txt>
                {/*
                  ── 把"当前用哪个账号在查"直接显示出来 ──
                  踩过的坑：换账号后查到的一直是上一个人的数据，
                  而界面上完全看不出当前身份，只能靠猜。
                  这里把学号（打码）+ userId 摆在明面上，
                  一眼就能判断"账号到底换没换成功"。
                */}
                <Txt variant="caption" c={color.text.tertiary}>
                  {`当前查询账号：${maskStudentIdLocal(account.studentId)}（userId ${account.userId ?? '缺失'}）`}
                </Txt>
                <Txt variant="caption" c={color.text.tertiary} numberOfLines={2}>
                  {scope === 'all'
                    ? '管理员换了万能码后，会自动降级为你的个人授权码（只能改自己）'
                    : '要改别人的状态需要管理员给你万能码'}
                </Txt>
              </Col>
              <Badge
                text={scope === 'all' ? '全部' : '仅自己'}
                fg={scope === 'all' ? color.warning[600] : color.primary[600]}
                bg={scope === 'all' ? color.warning[50] : color.primary[50]}
              />
            </Row>
          </Card>
        </Section>
      ) : null}

      {/*
        授权正常但服务器没确认（没配服务器 / 服务器里还没登记）时，
        给一行**弱提示**，不要拦住用户 —— 服务器挂了不该把人锁死。
      */}
      {account && entitled && serverAuth === 'unknown' && serverAuthMessage ? (
        <Section style={{ marginTop: spacing.sm }}>
          <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 16 }}>
            {serverAuthMessage}
          </Txt>
        </Section>
      ) : null}

      {/* 查询栏 */}
      {account ? (
        <Section style={{ marginTop: intro ? 0 : spacing.sm }}>
          <Card style={{ padding: spacing.md }}>
            <Row justify="space-between" align="center" gap={spacing.md}>
              <Col flex={1} gap={2}>
                <Txt variant="body2" weight="medium">
                  {sign.overview ? `共 ${records.length} 个签到环节` : '点查询，找出优学院发起过的签到'}
                </Txt>
                <Txt variant="caption" c={color.text.tertiary}>
                  {progress
                    ? `正在读取 ${progress.done}/${progress.total}…`
                    : sign.lastQueryAt
                      ? `上次查询 ${formatDate(sign.lastQueryAt)}`
                      : '按点名发起时间排序，未签到在最上面'}
                </Txt>
              </Col>
              <Button label={busy ? '查询中…' : '查询'} onPress={() => void query()} disabled={busy} />
            </Row>
          </Card>
        </Section>
      ) : null}

      {/*
        一键签到**已关闭**（需求：批量太不可控，只能逐条签）。
      {/* 一键签到**已彻底移除**（需求：批量太不可控，只能逐条签） */}

      {/*
        ══════════ ★ 正在进行的点名（最显眼的位置）══════════
        老师刚发起点名时，这是**最紧急**的信息 —— 点名有时限。
        所以放在最上面、用醒目样式，并直接告诉用户"几分钟前发起的"
        （判断"还能不能签"时，时间新鲜度是最重要的线索）。
      */}
      {ongoing.length > 0 ? (
        <Section style={{ marginTop: spacing.sm }}>
          <View
            style={{
              backgroundColor: color.warning[50],
              borderWidth: 1,
              borderColor: color.warning[600],
              borderRadius: radius.md,
              padding: spacing.md,
            }}
          >
            <Row gap={spacing.sm} align="center">
              <Txt variant="body">🔔</Txt>
              <Txt variant="body2" weight="semibold" c={color.warning[600]} style={{ flex: 1 }}>
                有 {ongoing.length} 个点名正在进行，可以签到
              </Txt>
            </Row>
            {ongoing.slice(0, 3).map((r) => (
              <Row key={r.attendanceID} gap={spacing.sm} align="center" style={{ marginTop: 6 }}>
                <Txt variant="caption" c={color.warning[600]} numberOfLines={1} style={{ flex: 1 }}>
                  · {r.courseName ?? '未知课程'}
                  {r.classroomTitle ? `（${r.classroomTitle}）` : ''}
                </Txt>
                <Txt variant="caption" c={color.warning[600]}>
                  {relativeTime(r.beginTime ?? r.createDate)}
                </Txt>
              </Row>
            ))}
            <Txt variant="caption" c={color.warning[600]} style={{ marginTop: 8, lineHeight: 16 }}>
              它们在下面列表的**最前面**。点名通常只开几分钟，尽快处理。
            </Txt>
          </View>
        </Section>
      ) : null}

      {sign.error ? (
        <Section>
          {/*
            ★★★ token 失效时，光有「重试」没用 —— 重试一百次还是 401。
            用户实测过这种情况：「明明登着账号，查不了」
              → 因为**在别处登录了优学院**，把这里的 token 顶掉了。
            所以这种情况直接给「重新登录」按钮，别让人白试。
          */}
          {/token 失效|登录状态已被优学院作废/.test(sign.error) ? (
            <>
              <Banner
                tone="warning"
                title="需要重新登录"
                message={sign.error}
                actionLabel="重新登录"
                onAction={() => router.push('/youxue-bind')}
              />
              <Spacer h={spacing.sm} />
              <Button label="重试一次" variant="secondary" onPress={() => void query()} />
            </>
          ) : (
            <Banner tone="warning" title="查询有问题" message={sign.error} actionLabel="重试" onAction={() => void query()} />
          )}
        </Section>
      ) : null}

      {/*
        刻意**不放**"一键签到"按钮。
        按需求：查询之后应该在每条记录上给出「签到 / 取消签到」按钮，
        让人逐条自己决定；批量操作放在独立的「一键签到」入口里（优学院 → 功能）。
      */}


      {result ? (
        <Section>
          <Banner
            tone={result.startsWith('已改为') ? 'info' : 'warning'}
            title={result}
            actionLabel="知道了"
            onAction={() => setResult(null)}
          />
        </Section>
      ) : null}

      {/*
        筛选：先按**方式**（全部/扫码/位置/数字码/一键），再按**状态**（未签/已签）。
        加"全部方式"是为了满足"所有课程都可以改状态" ——
        默认只看扫码方式会漏掉位置签到等记录。
      */}
      {records.length > 0 ? (
        <Section>
          <Row style={{ backgroundColor: color.neutral[100], borderRadius: radius.md, padding: 4 }} gap={4}>
            {([
              ['all', '全部方式'],
              ['qrcode', '扫码'],
              ['location', '位置'],
              ['numcode', '数字码'],
              ['oneclick', '一键'],
            ] as const).map(([k, label]) => {
              const on = methodFilter === k;
              return (
                <Pressable
                  key={k}
                  onPress={() => setMethodFilter(k)}
                  style={{
                    flex: 1,
                    paddingVertical: 8,
                    borderRadius: radius.sm,
                    alignItems: 'center',
                    backgroundColor: on ? color.background.primary : 'transparent',
                  }}
                >
                  <Txt
                    variant="caption"
                    weight={on ? 'semibold' : 'regular'}
                    c={on ? color.primary[500] : color.text.secondary}
                  >
                    {label}
                  </Txt>
                </Pressable>
              );
            })}
          </Row>
          <Spacer h={6} />
          <Row style={{ backgroundColor: color.neutral[100], borderRadius: radius.md, padding: 4 }} gap={4}>
            {([
              ['unsigned', `未签到 ${unsigned.length}`],
              ['signed', `已签到 ${signed.length}`],
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

      {/*
        ══════════ ★ 两段式查询的提示 ══════════
        紧急情况不必等 140 条历史拉完 —— 但要说清"现在显示的是哪一批"。

        ⚠️ 这里踩过一个坑：原先文案写「先显示正在进行的 ${hotCount} 条」，
           而那时列表里其实是**没筛过的全部 140 条** ——
           名不副实，等于在骗用户（他以为这些都是进行中的）。
           用户直接指出：「先显示的应该是正在进行签到的，
           而不是说先显示 140 条」。

        现在分开说：
          · 有进行中的 → 说进行中几条（用 hotOngoing，不是列表长度）
          · 没有进行中 → 就说"先把没签到的摆出来"
      */}
      {busy && records.length > 0 ? (
        <Section style={{ marginTop: spacing.sm }}>
          <Banner
            tone="info"
            title={
              sign.hotOngoing > 0
                ? `先显示正在进行的 ${sign.hotOngoing} 条`
                : `先把没签到的 ${sign.hotCount || records.length} 条显示出来`
            }
            message={
              sign.hotOngoing > 0
                ? '这些现在就能操作。后面的未签到记录与历史还在查询中，完成后会自动补上。'
                : '这些还没签到，先摆出来方便你处理。完整历史还在查询中，完成后会自动补上。'
            }
          />
        </Section>
      ) : null}

      {/* 列表 */}
      <Section>
        {busy && records.length === 0 ? (
          <Card>
            <Row justify="center" gap={spacing.sm} style={{ paddingVertical: spacing.lg }}>
              <ActivityIndicator color={color.primary[500]} />
              <Txt variant="body2" c={color.text.secondary}>
                正在查询…
              </Txt>
            </Row>
          </Card>
        ) : list.length === 0 ? (
          <Card>
            <EmptyState
              title={
                records.length === 0
                  ? onlyMethod
                    ? `没有${SIGN_METHOD_META[onlyMethod].label}的记录`
                    : '还没有查询'
                  : filter === 'unsigned'
                    ? '没有未签到的'
                    : '没有已签到的'
              }
              hint={records.length === 0 ? (emptyHint ?? '点上面「查询」开始') : '换个筛选看看'}
            />
          </Card>
        ) : (
          <Card style={{ padding: 0 }}>
            {list.map((r, i) => (
              <View key={r.attendanceID}>
                <RecordRow
                  r={r}
                  allowChange={allowChange}
                  busy={busyId === r.attendanceID}
                  onChange={() => void changeToSigned(r)}
                  onCancel={() => void changeStatus(r)}
                />
                {i < list.length - 1 ? <Divider /> : null}
              </View>
            ))}
          </Card>
        )}
      </Section>

      <Section>
        <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 18 }}>
          只列出优学院确实发起过点名的课程。
        </Txt>
      </Section>

      {/* 状态选择浮层：点「改状态」后选目标状态 */}
      <Modal
        visible={Boolean(statusTarget)}
        transparent
        animationType="slide"
        onRequestClose={() => closeStatusModal()}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => closeStatusModal()}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <Row justify="space-between" align="center">
              <Txt variant="h3" weight="bold">
                改签到状态
              </Txt>
              <Pressable onPress={() => closeStatusModal()} hitSlop={10}>
                <Txt variant="body2" c={color.text.tertiary}>
                  关闭
                </Txt>
              </Pressable>
            </Row>
            <Spacer h={4} />
            <Txt variant="caption" c={color.text.tertiary}>
              {statusTarget?.courseName ?? ''} · {statusTarget?.classroomTitle ?? statusTarget?.title ?? ''}
            </Txt>
            <Spacer h={spacing.sm} />

            {SIGN_STATUS_GROUPS.map((g) => (
              <View key={g.label}>
                <Row
                  justify="space-between"
                  align="center"
                  style={{
                    paddingVertical: spacing.md,
                    borderTopWidth: 1,
                    borderTopColor: color.neutral[100],
                  }}
                >
                  {/*
                    ⚠️ 左边（标签 + 展开箭头）只负责展开「其他」；
                       真正提交靠右边的「修改」按钮 —— 需求要求这样。
                  */}
                  <Pressable
                    onPress={() => (g.subs ? setSubOpen((v) => !v) : undefined)}
                    hitSlop={8}
                    style={{ flex: 1 }}
                  >
                    <Txt variant="body2" weight="medium">
                      {g.label}
                      {g.subs ? (subOpen ? '  ▾' : '  ▸') : ''}
                    </Txt>
                  </Pressable>

                  {/* 「其他」没有自己的 status（-1），只展开不给按钮 */}
                  {g.subs ? null : (
                    <StatusAction
                      modified={modifiedStatus === g.status}
                      applying={applyingStatus === g.status}
                      onPress={() => void applyStatus(g.status)}
                    />
                  )}
                </Row>

                {/* 「其他」展开后是迟到/早退/病假/事假 */}
                {g.subs && subOpen
                  ? g.subs.map((s) => (
                      <Row
                        key={s.status}
                        justify="space-between"
                        align="center"
                        style={{
                          paddingVertical: spacing.md,
                          paddingLeft: spacing.lg,
                          borderTopWidth: 1,
                          borderTopColor: color.neutral[100],
                        }}
                      >
                        <Txt variant="body2" c={color.text.secondary} style={{ flex: 1 }}>
                          {s.label}
                        </Txt>
                        <StatusAction
                          modified={modifiedStatus === s.status}
                          applying={applyingStatus === s.status}
                          onPress={() => void applyStatus(s.status)}
                        />
                      </Row>
                    ))
                  : null}
              </View>
            ))}

            {/*
              ★ 结果就地显示在弹窗里（原来只在页面顶部 Banner 显示）。
              因为弹窗现在**不自动关闭**了，用户需要在这里看到反馈。
            */}
            {result ? (
              <>
                <Spacer h={spacing.md} />
                <View
                  style={{
                    backgroundColor: color.neutral[100],
                    borderRadius: radius.sm,
                    padding: spacing.md,
                  }}
                >
                  <Txt variant="caption" c={color.text.secondary} style={{ lineHeight: 17 }}>
                    {result}
                  </Txt>
                </View>
              </>
            ) : null}

            {/*
              ⚠️ 这里原来有个按钮：「诊断：找出能改状态的接口」。
                 用户要求删掉（「签到功能里的接口测试」），已移除。
                 详见文件顶部那段说明。
            */}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/**
 * 「改状态」弹窗里每一行右侧的按钮。
 *
 * ══════════════ 需求（用户 2026-10）══════════════
 * 「每个状态后面加个修改按钮，被修改的状态后面按钮从修改变成已修改」
 *
 * 三种形态：
 *   未改          → 「修改」（可点）
 *   正在提交      → 「修改中…」（转圈，禁用）
 *   **已改成功**  → 「已修改」（打勾，禁用）  ← 需求要的那个变化
 *
 * ⚠️ 「已修改」必须**禁用** —— 否则重复点会给服务端重复写同一条，
 *    既没必要，也可能刷出异常记录。
 */
function StatusAction({
  modified,
  applying,
  onPress,
}: {
  modified: boolean;
  applying: boolean;
  onPress: () => void;
}) {
  if (modified) {
    return (
      <Row align="center" gap={4}>
        {/* ⚠️ 用行内 fontWeight 而不是 Txt 的 weight 属性 —— 少一处对组件 API 的依赖 */}
        <Txt variant="caption" c={color.success[600]} style={{ fontWeight: '600' }}>
          ✓ 已修改
        </Txt>
      </Row>
    );
  }
  return (
    <Pressable
      onPress={applying ? undefined : onPress}
      style={{
        paddingHorizontal: spacing.md,
        paddingVertical: 5,
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: applying ? color.neutral[200] : color.primary[500],
        minWidth: 62,
        alignItems: 'center',
      }}
    >
      <Txt
        variant="caption"
        c={applying ? color.text.tertiary : color.primary[500]}
        style={{ fontWeight: '600' }}
      >
        {applying ? '修改中…' : '修改'}
      </Txt>
    </Pressable>
  );
}

function RecordRow({
  r,
  allowChange,
  busy,
  onChange,
  onCancel,
}: {
  r: SignDetail;
  allowChange: boolean;
  busy: boolean;
  onChange: () => void;
  onCancel: () => void;
}) {
  const stateMeta = SIGN_STATE_META[r.state];
  const methodMeta = SIGN_METHOD_META[r.method];
  const signed = isSignedState(r.state);
  const ongoing = isReallyOngoing(r);
  const when = r.beginTime ?? r.createDate;

  /**
   * 徽标文案与配色 —— 规则见 domain 里的 `signBadge`（那里有详细注释）。
   * 要点：**进行中 + 未签到显示「待签到」而不是「缺勤」**。
   */
  const badge = signBadge(r);
  const badgeFg =
    badge.tone === 'pending'
      ? color.primary[600]
      : badge.tone === 'signed'
        ? stateMeta.fg
        : color.text.tertiary;
  const badgeBg =
    badge.tone === 'pending'
      ? color.primary[50]
      : badge.tone === 'signed'
        ? stateMeta.bg
        : color.neutral[100];

  return (
    <Col style={{ padding: spacing.base }} gap={6}>
      <Row justify="space-between" gap={spacing.sm} align="center">
        <Txt variant="body2" weight="medium" numberOfLines={1} style={{ flex: 1 }}>
          {r.courseName ?? '未知课程'}
        </Txt>
        <Badge text={badge.text} fg={badgeFg} bg={badgeBg} />
      </Row>

      <Txt variant="small" c={color.text.tertiary} numberOfLines={1}>
        {r.classroomTitle ?? r.title}
      </Txt>
      {/*
        ★ 显示课堂 id —— 因为「点不中」页要填它才能读活动列表。
        没有这个数字，用户就得到处找（实测用户就卡在这：框是空的 → classroomId=0 → 404）。
      */}
      {r.classroomId ? (
        <Txt variant="small" c={color.text.tertiary} numberOfLines={1}>
          {`课堂 id ${r.classroomId}`}
        </Txt>
      ) : null}

      <Row justify="space-between" gap={spacing.sm} align="center">
        <Row gap={spacing.sm} align="center">
          <Txt variant="small" c={color.text.tertiary}>
            {methodMeta.label}
          </Txt>
          <Txt variant="small" c={color.text.tertiary}>
            ·
          </Txt>
          <Txt variant="small" c={color.text.tertiary}>
            {/*
              进行中的记录显示**相对时间**（"3 分钟前"）——
              判断"还来不来得及签"时，这个比绝对时间直观得多。
              其他记录仍显示绝对时间（回溯历史时更清楚是哪天）。
            */}
            {when ? (ongoing ? relativeTime(when) : formatDateTime(when)) : '时间未知'}
          </Txt>
          {/*
            只有"活动还在进行、但我已经签过了"时才标「进行中」——
            未签到的情况下上面已经写了「待签到」，再挂一个「进行中」就重复了。
          */}
          {ongoing && signed ? (
            <Badge text="进行中" fg={color.warning[600]} bg={color.warning[50]} />
          ) : null}
        </Row>

        {/*
          操作按钮。
          ⚠️ 每条记录都要有「改状态」—— 不能只在已签到的记录上给。
          踩过的坑：起先把「改状态」只挂在已签到那一侧，结果把记录改成「缺勤」后，
          它进了「未签到」列表，而那边只有「签到」按钮（老记录甚至只显示"已结束"），
          **就没法改回去了**。
          既然教师接口能设任意状态，按钮就不应该按状态区分。
        */}
        {allowChange ? (
          <Row gap={spacing.sm} align="center">
            {!signed ? (
              <Button
                label={busy ? '提交中…' : '签到'}
                onPress={onChange}
                disabled={busy}
                style={{ paddingHorizontal: spacing.base, paddingVertical: 6 }}
              />
            ) : null}
            <Button
              label={busy ? '…' : '改状态'}
              variant="secondary"
              onPress={onCancel}
              disabled={busy}
              style={{ paddingHorizontal: spacing.base, paddingVertical: 6 }}
            />
          </Row>
        ) : null}
      </Row>
    </Col>
  );
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const styles = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: color.background.primary,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
});
