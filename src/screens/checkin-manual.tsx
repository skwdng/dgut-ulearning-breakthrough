/**
 * 由 app/checkin-manual.tsx 迁移而来（tools/migrate-screens.cjs）。
 * 已移除 expo-router 依赖 —— 见 src/nav/router.tsx 的说明。
 */
/**
 * 手动签到页 —— 自动化的兜底出口。
 *
 * 何时用：二维码/手势/拍照签到，或数字码没拿到、定位被拒。
 * 设计原则：任何一次"需要人工"的提示，都必须能一键落到这里，并且
 * 尽量预填已知信息（课程、签到方式、剩余时间），让用户 3 秒内点完。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  Badge,
  Banner,
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
  StatusBadge,
  Txt,
} from '../components';
import { QrScanner } from '../components/QrScanner';
import { LocationPicker } from '../components/LocationPicker';
import { color, radius, spacing } from '../theme/tokens';
import { useCheckin } from '../state/checkinStore';
import { SIGN_TYPE_LABEL } from '../domain/types';
import { ERROR_META } from '../services/checkin/errors';
import { defaultCircleFor, type Circle, type LatLng } from '../utils/geo';
import { useRouter, useLocalSearchParams } from '../nav/router';

export function CheckinManualScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ taskId?: string; mode?: string }>();
  const { tasks, courses, manualTask, actions } = useCheckin();

  const [signCode, setSignCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [remaining, setRemaining] = useState<number | undefined>(undefined);

  const task = useMemo(() => {
    const id = params.taskId;
    return tasks.find((t) => t.id === id) ?? manualTask ?? tasks.filter((t) => t.state === 'need_manual').slice(-1)[0] ?? null;
  }, [params.taskId, tasks, manualTask]);

  const scanOnly = params.mode === 'scan';
  const course = courses.find((c) => c.id === task?.courseId);

  // 签到窗口倒计时（每秒刷新）
  useEffect(() => {
    if (!task?.windowEnd) {
      setRemaining(undefined);
      return;
    }
    const tick = () => setRemaining(Math.max(0, Math.round((task.windowEnd! - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [task?.windowEnd]);

  const submit = async (mode: 'code' | 'qr' | 'plain' | 'location', extra?: { qr?: string; point?: LatLng }) => {
    if (!task) return;
    setBusy(true);
    try {
      const res =
        mode === 'qr'
          ? await actions.submitQrScan(extra?.qr ?? '')
          : await actions.submitManual({
              task,
              signCode: mode === 'code' ? signCode : undefined,
              location: mode === 'location' ? extra?.point : undefined,
            });
      setResult(
        res.ok
          ? { ok: true, text: '签到成功' }
          : {
              ok: false,
              text: res.error
                ? `${ERROR_META[res.error.code].title}：${ERROR_META[res.error.code].suggestion}`
                : '签到失败',
            },
      );
      if (res.ok) setTimeout(() => router.back(), 900);
    } finally {
      setBusy(false);
    }
  };

  if (!task) {
    // 独立扫码模式：还没有检测到任务也能先扫，扫到后自动匹配最近的任务提交
    if (scanOnly) {
      return (
        <ScreenScroll>
          {result ? (
            <Banner tone={result.ok ? 'info' : 'error'} title={result.text} actionLabel="关闭" onAction={() => setResult(null)} />
          ) : null}
          <Section style={{ marginTop: spacing.md }} title="扫描教师投屏的二维码">
            <Card style={{ padding: spacing.sm }}>
              <QrScanner
                submitting={busy}
                onScanned={(payload) => {
                  void submit('qr', { qr: payload });
                }}
              />
            </Card>
            <Spacer h={spacing.md} />
            <Txt variant="caption" c={color.text.tertiary}>
              {'扫码后会匹配当前最近的签到任务并自动提交。\n'}
              {'⚠️ 本 App 已**不含自动检测** —— 没有已知任务时，请到'}
              {'「小操作 → 签到记录」里先点一次「查询」，把签到记录拉出来。'}
            </Txt>
          </Section>
          <Section>
            <Button
              label="手动选择一个课程提交"
              variant="secondary"
              onPress={() => {
                const latest = tasks.slice(-1)[0];
                if (!latest) {
                  setResult({
                    ok: false,
                    text: '还没有已知任务 —— 先到「小操作 → 签到记录」点一次「查询」',
                  });
                  return;
                }
                router.replace({ pathname: '/checkin-manual', params: { taskId: latest.id } });
              }}
            />
          </Section>
        </ScreenScroll>
      );
    }
    return (
      <ScreenScroll>
        <Card style={{ margin: spacing.base }}>
          <EmptyState
            title="没有待处理的手动签到"
            hint="先去「小操作 → 签到记录」点一次查询，这里才会出现待处理项"
          />
          <Button label="返回" variant="secondary" onPress={() => router.back()} />
        </Card>
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll>
      {result ? (
        <Banner tone={result.ok ? 'info' : 'error'} title={result.text} actionLabel="关闭" onAction={() => setResult(null)} />
      ) : null}

      <Section style={{ marginTop: spacing.md }}>
        <Card variant="elevated">
          <Row justify="space-between">
            <Col flex={1}>
              <Txt variant="title" weight="semibold">{task.courseName}</Txt>
              <Txt variant="body2" c={color.text.secondary} style={{ marginTop: 4 }}>
                {SIGN_TYPE_LABEL[task.signType]}
                {course?.teacher ? ` · ${course.teacher}` : ''}
                {task.location ? ` · ${task.location}` : ''}
              </Txt>
            </Col>
            <Col align="flex-end" gap={spacing.sm}>
              <StatusBadge state={task.state} />
              {remaining !== undefined ? (
                <Badge
                  text={remaining > 0 ? `剩余 ${remaining}s` : '窗口可能已关闭'}
                  fg={remaining > 60 ? color.success[500] : color.error[500]}
                  bg={remaining > 60 ? color.success[50] : color.error[50]}
                />
              ) : null}
            </Col>
          </Row>
        </Card>
      </Section>

      {/* 按签到方式给出最合适的操作 */}
      {task.signType === 'number' ? (
        <Section title="输入教师给出的数字码">
          <Field
            label="数字签到码"
            value={signCode}
            onChangeText={setSignCode}
            keyboardType="number-pad"
            placeholder="例如 4821"
            hint="教师口播或投屏的数字，通常 4~6 位"
          />
          <Button label="提交签到" onPress={() => void submit('code')} loading={busy} />
        </Section>
      ) : null}

      {task.signType === 'qrcode' ? (
        <Section title="扫描教师投屏的二维码">
          <Card style={{ padding: spacing.sm }}>
            <QrScanner
              submitting={busy}
              remainingSec={remaining}
              onScanned={(payload) => {
                void submit('qr', { qr: payload });
              }}
            />
          </Card>
          <Spacer h={spacing.md} />
          <Txt variant="caption" c={color.text.tertiary}>
            扫到后会自动提交，无需再点按钮。教师投屏的二维码通常 30~60 秒刷新一次，请在窗口内完成。
            如果扫码后提示失败，请点上方"重新扫描"再试一次。
          </Txt>
        </Section>
      ) : null}

      {task.signType === 'gesture' ? (
        <Section title="手势签到">
          <Card>
            <Txt variant="body2" c={color.text.secondary}>
              手势签到需要在优学院官方 App 内按教师设定的轨迹完成，第三方无法代填。
              请立即打开优学院 App 手动完成，完成后回到本页确认状态。
            </Txt>
            <Spacer h={spacing.md} />
            <Button label="我已手动完成" variant="secondary" onPress={() => void submit('plain')} loading={busy} />
          </Card>
        </Section>
      ) : null}

      {task.signType === 'location' ? (
        <Section title="选择签到位置">
          {(() => {
            const circle: Circle | null = defaultCircleFor(course?.location);
            if (!circle) {
              return (
                <Card>
                  <Txt variant="body2" c={color.text.secondary}>
                    该课程还没有签到范围数据。请先到"优学院设置 → 自定义定位"设置课程位置，
                    或在签到详情接口返回范围后自动带出。
                  </Txt>
                  <Spacer h={spacing.md} />
                  <Button label="去设置位置" variant="secondary" onPress={() => router.push('/youxue-bind')} />
                </Card>
              );
            }
            return (
              <>
                <Card>
                  <LocationPicker
                    circle={circle}
                    submitting={busy}
                    remainingSec={remaining}
                    onSubmit={(point) => void submit('location', { point })}
                  />
                </Card>
                <Spacer h={spacing.md} />
                <Txt variant="caption" c={color.text.tertiary}>
                  说明：上方圆是教师发起签到时设定的可签到范围。你可以用真实位置，也可以在范围内自己选一个点
                  （例如人在教室后排信号漂移时）。提交的坐标会做小幅随机扰动，避免每次都完全相同。
                  {task.windowEnd ? '' : ' 当前任务未带窗口结束时间，倒计时不可用。'}
                </Txt>
              </>
            );
          })()}
        </Section>
      ) : null}

      {task.signType === 'normal' || task.signType === 'unknown' ? (
        <Section title="直接签到">
          <Button label="立即提交签到" onPress={() => void submit('plain')} loading={busy} />
        </Section>
      ) : null}

      {/* 无论什么类型都给一个"直接试一次"的出口 */}
      {task.signType !== 'normal' && task.signType !== 'unknown' ? (
        <Section title="其他">
          <Button label="不填参数，直接提交一次" variant="secondary" onPress={() => void submit('plain')} loading={busy} />
        </Section>
      ) : null}

      <Section title="诊断信息">
        <Card style={{ padding: 0 }}>
          <InfoRow label="任务 ID" value={task.id} />
          <Divider />
          <InfoRow label="rollcallId" value={task.rollcallId ?? '—'} />
          <Divider />
          <InfoRow label="签到方式" value={`${task.signType}（${SIGN_TYPE_LABEL[task.signType]}）`} />
          <Divider />
          <InfoRow label="尝试次数" value={String(task.attempts)} />
          <Divider />
          <InfoRow
            label="窗口"
            value={
              task.windowStart && task.windowEnd
                ? `${new Date(task.windowStart).toLocaleTimeString('zh-CN')} ~ ${new Date(task.windowEnd).toLocaleTimeString('zh-CN')}`
                : '未知'
            }
          />
          {task.lastError ? (
            <>
              <Divider />
              <InfoRow label="上次失败" value={`${task.lastError.code} · ${task.lastError.message}`} />
            </>
          ) : null}
        </Card>
        <Spacer h={spacing.md} />
        <Button
          label="查看原始日志"
          variant="secondary"
          onPress={() => router.push('/checkin-log')}
        />
      </Section>
    </ScreenScroll>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Row justify="space-between" style={{ paddingHorizontal: spacing.base, paddingVertical: spacing.md, gap: spacing.md }}>
      <Txt variant="body2" c={color.text.secondary}>
        {label}
      </Txt>
      <Txt variant="body2" numberOfLines={2} style={{ flex: 1, textAlign: 'right' }}>
        {value}
      </Txt>
    </Row>
  );
}
