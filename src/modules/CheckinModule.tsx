/**
 * 签到模块 —— 自动搜索所有签到环节 + 查看状态 + 更改状态。
 *
 * 字段映射来自学生端源码（已确认，详见 youxue-api-verified.md）：
 *   status = 学生签到状态：0缺勤 1/2已签到 3迟到 4早退 5病假 6事假
 *   type   = 签到方式：  0位置 1二维码 2数字码 3一键签到
 *   state  = 活动是否结束："0"已结束 "1"进行中
 */
import React, { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';
import {
  Badge,
  Banner,
  Button,
  Card,
  Col,
  Divider,
  EmptyState,
  Row,
  Section,
  Set,
  Spacer,
  Txt,
} from '../components';
import { color, radius, spacing } from '../theme/tokens';
import { useSign } from '../state/signStore';
import { useCheckin } from '../state/checkinStore';
import { SIGN_METHOD_META, SIGN_STATE_META, isSignedState, type SignDetail, type SignState } from '../domain/checkin';

type Filter = 'all' | 'absent' | 'signed';

export function CheckinModule() {
  const { account } = useCheckin();
  const bound = Boolean(account);
  const { overview, courses, loading, progress, lastQueryAt, lastSubmit, error, actions } = useSign();
  const [filter, setFilter] = useState<Filter>('all');
  const [openCourse, setOpenCourse] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [credential, setCredential] = useState('');
  const [panelFor, setPanelFor] = useState<SignDetail | null>(null);

  const records = useMemo(() => {
    const all = overview?.allRecords ?? [];
    if (filter === 'absent') return all.filter((r) => r.state === 'absent');
    if (filter === 'signed') return all.filter((r) => isSignedState(r.state));
    return all;
  }, [overview, filter]);

  if (!bound) {
    return (
      <Card>
        <EmptyState title="还没有绑定优学院账号" hint="绑定后才能自动搜索签到环节" />
      </Card>
    );
  }

  const s = overview?.summary;

  /** 点"改为已签" */
  const startSign = (r: SignDetail) => {
    if (r.activityState !== '1') {
      Alert.alert('点名已结束', '这个点名的活动窗口已关闭，学生端无法再更改状态。只有点名进行中时才能操作。');
      return;
    }
    if (r.method === 'oneclick') {
      // 一键签到不需要额外凭证，直接提交
      setBusyId(r.attendanceID);
      void actions
        .signByMethod({ attendanceID: r.attendanceID, classID: r.classes[0]?.classID, method: 'oneclick' })
        .finally(() => setBusyId(null));
      return;
    }
    setPanelFor(r);
    setCredential('');
  };

  const submitPanel = async () => {
    if (!panelFor) return;
    const m = panelFor.method;
    setBusyId(panelFor.attendanceID);
    try {
      if (m === 'qrcode') {
        await actions.signByQrCode({
          attendanceID: panelFor.attendanceID,
          classID: panelFor.classes[0]?.classID,
          code: credential.trim(),
        });
      } else if (m === 'numcode') {
        await actions.signByNumCode({
          attendanceID: panelFor.attendanceID,
          classID: panelFor.classes[0]?.classID,
          code: credential.trim(),
        });
      } else {
        const loc = credential.trim();
        if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(loc)) {
          Alert.alert('坐标格式不对', '请按「经度,纬度」填写，例如 113.8182,22.9015');
          return;
        }
        await actions.signByLocation({
          attendanceID: panelFor.attendanceID,
          classID: panelFor.classes[0]?.classID,
          location: loc,
        });
      }
      setPanelFor(null);
    } finally {
      setBusyId(null);
    }
  };

  const changeOther = (r: SignDetail) => {
    Alert.alert(
      '学生端只能签到，不能改成缺勤/请假',
      '源码里学生的接口只有 signByStu（提交签到）。把状态改成"缺勤/迟到/请假"用的是教师接口 ' +
        '（教师端有 attendance.signed/absenteeism/late 等选项），学生账号没有权限。',
    );
  };

  return (
    <Col gap={0}>
      {/* ── 搜索栏 ── */}
      <Card style={{ padding: spacing.md }}>
        <Row justify="space-between" gap={spacing.md}>
          <Col flex={1} gap={2}>
            <Txt variant="body2" weight="medium">
              {overview ? `搜到 ${s?.total ?? 0} 个签到环节` : '点搜索自动查找所有签到'}
            </Txt>
            <Txt variant="caption" c={color.text.tertiary}>
              {loading && progress
                ? `正在读取详情 ${progress.done}/${progress.total}…`
                : lastQueryAt
                  ? `上次搜索 ${formatTime(lastQueryAt)} · ${courses.length} 门课程`
                  : '会遍历所有课程与课堂'}
            </Txt>
          </Col>
          <Button
            label={loading ? '搜索中…' : '搜索'}
            loading={loading}
            onPress={() => void actions.query()}
            style={{ height: 38, paddingHorizontal: spacing.lg }}
          />
        </Row>
      </Card>

      {error ? (
        <Banner tone="warning" title="提示" message={error} actionLabel="重新搜索" onAction={() => void actions.query()} />
      ) : null}
      {lastSubmit ? (
        <Banner
          tone={lastSubmit.ok ? 'info' : 'error'}
          title={lastSubmit.ok ? '状态已更新' : '未能更改状态'}
          message={lastSubmit.message ?? '状态已更新'}
          actionLabel="知道了"
          onAction={actions.clearSubmit}
        />
      ) : null}

      {/* ── 汇总 ── */}
      {s ? (
        <Section title="汇总">
          <Card>
            <Row justify="space-between">
              <Stat label="签到环节" value={`${s.total}`} />
              <Stat label="已签到" value={`${s.signed}`} c={color.success[500]} />
              <Stat label="缺勤" value={`${s.absent}`} c={color.error[500]} />
              <Stat label="签到率" value={`${(s.signedRate * 100).toFixed(0)}%`} c={color.primary[500]} />
            </Row>
          </Card>
        </Section>
      ) : null}

      {/* ── 筛选 ── */}
      {overview ? (
        <Section>
          <Row style={{ backgroundColor: color.neutral[100], borderRadius: radius.md, padding: 4 }}>
            {([
              ['all', `全部 ${s?.total ?? 0}`],
              ['absent', `缺勤 ${s?.absent ?? 0}`],
              ['signed', `已签到 ${s?.signed ?? 0}`],
            ] as const).map(([k, label]) => (
              <Pressable
                key={k}
                onPress={() => setFilter(k)}
                style={{
                  flex: 1,
                  paddingVertical: spacing.sm,
                  borderRadius: radius.sm,
                  alignItems: 'center',
                  backgroundColor: filter === k ? color.background.primary : 'transparent',
                }}
              >
                <Txt
                  variant="body2"
                  weight={filter === k ? 'semibold' : 'regular'}
                  c={filter === k ? color.primary[500] : color.text.secondary}
                >
                  {label}
                </Txt>
              </Pressable>
            ))}
          </Row>
        </Section>
      ) : null}

      {/* ── 凭证输入面板 ── */}
      {panelFor ? (
        <Section title={`更改状态：${panelFor.title || `#${panelFor.attendanceID}`}`}>
          <Card>
            <Txt variant="caption" c={color.text.tertiary}>
              attendanceID {panelFor.attendanceID}
              {panelFor.classes[0] ? ` · classID ${panelFor.classes[0].classID}` : ''}
              {` · ${SIGN_METHOD_META[panelFor.method].label}`}
            </Txt>
            <Spacer h={spacing.md} />
            <Txt variant="body2" style={{ marginBottom: spacing.sm }}>
              {SIGN_METHOD_META[panelFor.method].hint}
            </Txt>
            <TextInput
              value={credential}
              onChangeText={setCredential}
              placeholder={
                panelFor.method === 'qrcode'
                  ? '粘贴二维码内容'
                  : panelFor.method === 'numcode'
                    ? '输入 4 位数字码'
                    : '113.8182,22.9015（经度,纬度）'
              }
              placeholderTextColor={color.text.tertiary}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={panelFor.method === 'location' ? 'numbers-and-punctuation' : 'default'}
            />
            <Spacer h={spacing.md} />
            <Row gap={spacing.sm}>
              <Button
                label="提交"
                loading={busyId === panelFor.attendanceID}
                onPress={() => void submitPanel()}
                style={{ flex: 1 }}
              />
              <Button label="取消" variant="secondary" onPress={() => setPanelFor(null)} style={{ flex: 1 }} />
            </Row>
          </Card>
        </Section>
      ) : null}

      {/* ── 签到列表 ── */}
      <Section title={`签到环节（${records.length}）`}>
        {records.length === 0 ? (
          <Card>
            <EmptyState
              title={overview ? '这个筛选下没有记录' : '还没有搜索'}
              hint={overview ? '换个筛选看看' : '点上方「搜索」自动查找所有课程的签到'}
            />
          </Card>
        ) : (
          <Card style={{ padding: 0 }}>
            {records.slice(0, 100).map((r, i) => (
              <View key={`${r.attendanceID}-${i}`}>
                <Row justify="space-between" style={{ padding: spacing.base }} gap={spacing.md}>
                  <Col flex={1} gap={3}>
                    <Txt variant="body2" weight="medium" numberOfLines={1}>
                      {r.title || `#${r.attendanceID}`}
                    </Txt>
                    <Txt variant="small" c={color.text.tertiary} numberOfLines={1}>
                      {r.courseName ?? '未知课程'}
                      {r.beginTime ? ` · ${formatTime(r.beginTime)}` : ''}
                    </Txt>
                    <Row gap={spacing.sm}>
                      <Badge
                        text={SIGN_METHOD_META[r.method].label}
                        fg={color.primary[600]}
                        bg={color.primary[50]}
                      />
                      <Badge
                        text={r.activityState === '1' ? '进行中' : '已结束'}
                        fg={r.activityState === '1' ? color.success[600] : color.text.tertiary}
                        bg={r.activityState === '1' ? color.success[50] : color.neutral[100]}
                      />
                      {r.teacherName ? (
                        <Txt variant="small" c={color.text.tertiary}>{r.teacherName}</Txt>
                      ) : null}
                    </Row>
                  </Col>
                  <Col align="flex-end" gap={spacing.sm}>
                    <Badge
                      text={SIGN_STATE_META[r.state].label}
                      fg={SIGN_STATE_META[r.state].fg}
                      bg={SIGN_STATE_META[r.state].bg}
                    />
                    {isSignedState(r.state) ? (
                      <Button
                        label="改状态"
                        variant="text"
                        onPress={() => changeOther(r)}
                        style={{ height: 30 }}
                      />
                    ) : (
                      <Button
                        label="改为已签"
                        variant="secondary"
                        loading={busyId === r.attendanceID}
                        onPress={() => startSign(r)}
                        style={{ height: 30, paddingHorizontal: spacing.md }}
                      />
                    )}
                  </Col>
                </Row>
                {i < Math.min(records.length, 100) - 1 ? <Divider /> : null}
              </View>
            ))}
          </Card>
        )}
      </Section>

      {/* ── 按课程 ── */}
      {courses.length > 0 ? (
        <Section title={`按课程（${courses.length}）`}>
          <Card style={{ padding: 0 }}>
            {courses.map((c, i) => (
              <View key={c.ocId}>
                <Pressable onPress={() => setOpenCourse(openCourse === c.ocId ? null : c.ocId)}>
                  <Row justify="space-between" style={{ padding: spacing.base }} gap={spacing.md}>
                    <Col flex={1} gap={2}>
                      <Txt variant="body2" weight="medium" numberOfLines={1}>{c.name}</Txt>
                      <Txt variant="small" c={color.text.tertiary}>
                        共 {c.records.length} 次 · 已签 {c.signedCount} · 缺勤 {c.absentCount}
                        {c.teacher ? ` · ${c.teacher}` : ''}
                      </Txt>
                    </Col>
                    <Txt variant="small" c={color.neutral[400]}>
                      {openCourse === c.ocId ? '收起' : '展开'}
                    </Txt>
                  </Row>
                </Pressable>
                {openCourse === c.ocId
                  ? c.records.slice(0, 30).map((r) => (
                      <View key={r.attendanceID} style={{ backgroundColor: color.background.secondary }}>
                        <Row justify="space-between" style={{ paddingHorizontal: spacing.base, paddingVertical: spacing.sm }} gap={spacing.sm}>
                          <Txt variant="small" style={{ flex: 1 }} numberOfLines={1}>
                            {r.title || `#${r.attendanceID}`}
                          </Txt>
                          <Badge
                            text={SIGN_STATE_META[r.state].label}
                            fg={SIGN_STATE_META[r.state].fg}
                            bg={SIGN_STATE_META[r.state].bg}
                          />
                        </Row>
                      </View>
                    ))
                  : null}
                {i < courses.length - 1 ? <Divider /> : null}
              </View>
            ))}
          </Card>
        </Section>
      ) : null}
    </Col>
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderColor: color.neutral[300],
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    color: color.text.primary,
    backgroundColor: color.background.primary,
  },
});

function Stat({ label, value, c }: { label: string; value: string; c?: string }) {
  return (
    <Col align="center" gap={4}>
      <Txt variant="h3" weight="bold" c={c ?? color.text.primary}>{value}</Txt>
      <Txt variant="small" c={color.text.secondary}>{label}</Txt>
    </Col>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const t = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  if (d.toDateString() === now.toDateString()) return `今天 ${t}`;
  return sameYear ? `${d.getMonth() + 1}/${d.getDate()} ${t}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
