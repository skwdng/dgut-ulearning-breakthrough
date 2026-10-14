/**
 * 地点签到。
 *
 * 和「扫码签到」同构：查询所有**位置方式**的签到记录，列出来让用户改状态。
 * 筛选条件是 method === 'location'（服务端 type=0）。
 *
 * 额外提供"用当前位置签到"：取手机定位后按「经度,纬度」提交，
 * 这是位置签到唯一需要业务参数的方式（其余方式服务端只看"改没改状态"）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { Banner, Button, Card, Section, Spacer, Txt } from '../components';
import { color, spacing } from '../theme/tokens';
import { useSign } from '../state/signStore';
import { isSignedState } from '../domain/checkin';
import { SignRecordList } from './SignRecordList';
import { isReallyOngoing } from '../domain/checkin';

export function SignLocationScreen() {
  const sign = useSign();
  const autoRan = useRef(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    if (!sign.overview) void sign.actions.query();
  }, [sign.overview, sign.actions]);

  /** 第一个「位置签到 + 真的在进行中 + 我还没签」的记录 */
  const target = (sign.overview?.allRecords ?? []).find(
    (r) => r.method === 'location' && isReallyOngoing(r) && !isSignedState(r.state),
  );

  const submitWithCurrentLocation = useCallback(async () => {
    if (!target) return;
    setBusy(true);
    setResult(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        setResult('没有定位权限，无法做位置签到');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      // 服务端要「经度,纬度」，6 位小数
      const loc = `${pos.coords.longitude.toFixed(6)},${pos.coords.latitude.toFixed(6)}`;
      const res = await sign.actions.signByLocation({
        attendanceID: target.attendanceID,
        classID: target.classes[0]?.classID,
        location: loc,
      });
      setResult(res.ok ? `已签到（坐标 ${loc}）` : `失败：${res.message ?? '未知原因'}`);
      if (res.ok) void sign.actions.query();
    } catch (e) {
      setResult(`定位失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [target, sign.actions]);

  return (
    <>
      {/* 快捷操作：用当前位置直接签 */}
      <Section style={{ marginTop: spacing.sm }} title="用当前位置签到">
        <Card>
          <Txt variant="small" c={color.text.secondary} style={{ lineHeight: 19 }}>
            {target
              ? `目标：${target.courseName ?? '未知课程'} · ${target.classroomTitle ?? target.title}`
              : '当前没有「位置签到 + 进行中 + 未签到」的记录，所以没法直接提交。'}
          </Txt>
          <Spacer h={spacing.md} />
          <Button
            label={busy ? '提交中…' : '取当前定位并签到'}
            onPress={() => void submitWithCurrentLocation()}
            disabled={!target || busy}
          />
        </Card>
      </Section>

      {result ? (
        <Section>
          <Banner
            tone={result.startsWith('已签到') ? 'info' : 'warning'}
            title={result}
            actionLabel="知道了"
            onAction={() => setResult(null)}
          />
        </Section>
      ) : null}

      {/* 记录列表（组件自带分节） */}
      <SignRecordList
        onlyMethod="location"
        allowChange
        intro="列出优学院所有「位置方式」的签到。点「改为已签」即可变更状态；服务端对位置签到会校验坐标，所以改状态时若失败，请用上面的按钮带真实定位提交。"
        emptyHint="点下面「查询」，会筛出所有位置方式的签到"
      />
    </>
  );
}
