/**
 * 地点签到。
 *
 * 和「扫码签到」同构：查询所有**位置方式**的签到记录，列出来让用户改状态。
 * 筛选条件是 method === 'location'（服务端 type=0）。
 *
 * ══════════════ ★ 2026-10：接入"课程签到位置"（地围栏）══════════════
 *
 * 用户需求（原话）：
 *   「给我把位置签到完善一下，要做到要在发起签到的设备围一个圈选位置」
 *   「要不就自己引用个地图，手指滑动，让标点对准位置」
 *
 * 改动：提交坐标时**优先用课程已设的圈**（`Course.location`）——
 * 在圈内随机取一个点，而不是用手机真实 GPS。
 *
 * ⚠️ 为什么这是关键改进：
 *    原来只能用真实 GPS → 人不在教室就签不了。
 *    现在提前给每门课圈一个范围 → 随时随地都能提交一个"合法坐标"。
 *    圈内的取点带随机性（`pickInsideWithJitter` 留 25% 边距），
 *    而且 `courseLocation()` 还会再叠 ±11m 扰动 —— 避免"每次都是同一个点"
 *    这种一眼假的机器特征。
 *
 * ⚠️ 没设圈的课程：**回退到真实定位**（保持老行为），而不是直接拒绝 ——
 *    新用户还没设圈时，这个页面得能用。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { Banner, Button, Card, Section, Spacer, Txt } from '../components';
import { color, spacing } from '../theme/tokens';
import { useSign } from '../state/signStore';
import { useCheckin } from '../state/checkinStore';
import { useRouter } from '../nav/router';
import { SignRecordList } from './SignRecordList';
import { isReallyOngoing, isSignedState } from '../domain/checkin';
import { defaultCircleFor, pickInsideWithJitter, formatDistance, distanceMeters } from '../utils/geo';
import {
  describeGeoFailure,
  probeLocation,
  tryGetCurrentPosition,
  tryGetLastKnownPosition,
} from '../utils/geoRuntime';

export function SignLocationScreen() {
  const sign = useSign();
  const router = useRouter();
  /** ⚠️ 课程位置存在 checkinStore（课程是它的数据），不是 signStore */
  const { courses } = useCheckin();
  const autoRan = useRef(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  /** 手机真实位置（用来告诉用户"你在圈内还是圈外"） */
  const [myPos, setMyPos] = useState<{ latitude: number; longitude: number } | null>(null);

  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    if (!sign.overview) void sign.actions.query();
  }, [sign.overview, sign.actions]);

  /** 第一个「位置签到 + 真的在进行中 + 我还没签」的记录 */
  const target = (sign.overview?.allRecords ?? []).find(
    (r) => r.method === 'location' && isReallyOngoing(r) && !isSignedState(r.state),
  );

  /**
   * 这条记录对应的课程有没有设过位置。
   *
   * ⚠️ 匹配用 `courseName` 而不是 id：签到记录里的 `ocId` 不总是有值
   *    （它靠"课程→课堂→活动"遍历补全，有些记录补不上），
   *    而 `courseName` 是服务端直接给的。名称匹配可能撞名，
   *    但位置签到场景下同名课程极少，且**撞了也只是圈选错**，
   *    比"匹配不上导致只能用真实 GPS"要好。
   */
  const targetCourse = useMemo(() => {
    if (!target) return null;
    const byId = target.ocId ? courses.find((c) => c.id === String(target.ocId)) : undefined;
    if (byId) return byId;
    const name = target.courseName?.trim();
    if (!name) return null;
    return courses.find((c) => c.name.trim() === name) ?? null;
  }, [target, courses]);

  const savedCircle = defaultCircleFor(targetCourse?.location);

  /** 读一次真实位置（只是给用户看参考，不用于提交） */
  useEffect(() => {
    let alive = true;
    void (async () => {
      /**
       * ⚠️ 用容错封装（utils/geoRuntime）——
       *    没装 Google 服务的手机（国产机基本都是）直接调 `Location.*`
       *    **会抛原生异常**，而这里只是读个"参考位置"，
       *    失败就该安静地少显示一行，不该影响页面。真机实测踩过。
       */
      const pos = await tryGetLastKnownPosition();
      if (alive && pos) setMyPos(pos);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const submit = useCallback(async () => {
    if (!target) return;
    setBusy(true);
    setResult(null);
    try {
      let loc: string;
      let desc: string;

      if (savedCircle) {
        /**
         * ★ 有圈 → 在圈内随机取点。
         *   ⚠️ 这里**不需要定位权限** —— 这正是这个功能的价值：
         *      人不在现场也能提交一个合法坐标。
         */
        const p = pickInsideWithJitter(savedCircle);
        loc = `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`;
        desc = `已签到（用「${targetCourse?.name}」预设范围，坐标 ${loc}）`;
      } else {
        /**
         * 没圈 → 回退到真实定位（老行为）。
         *
         * ⚠️ 必须用容错封装：没装 Google 服务的手机上
         *    `Location.requestForegroundPermissionsAsync()` **直接抛原生异常**，
         *    用户会看到一整段英文报错。这里改成说人话的提示。
         */
        const state = await probeLocation();
        if (state !== 'ok') {
          setResult(
            `${describeGeoFailure(state)}\n\n` +
              `更好的做法：先给「${
                targetCourse?.name ?? target.courseName ?? '这门课'
              }」圈一个签到范围 —— 那样不需要定位权限也能签。`,
          );
          return;
        }
        const pos = await tryGetCurrentPosition(Location.Accuracy.High);
        if (!pos) {
          setResult(`${describeGeoFailure('failed')}\n\n或者先给这门课圈一个签到范围。`);
          return;
        }
        loc = `${pos.longitude.toFixed(6)},${pos.latitude.toFixed(6)}`;
        desc = `已签到（用手机真实定位 ${loc}）`;
      }

      const res = await sign.actions.signByLocation({
        attendanceID: target.attendanceID,
        classID: target.classes[0]?.classID,
        location: loc,
      });
      setResult(res.ok ? desc : `失败：${res.message ?? '未知原因'}`);
      if (res.ok) void sign.actions.query();
    } catch (e) {
      setResult(`提交失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [target, targetCourse, savedCircle, sign.actions]);

  /** 圈心到我当前位置的距离（判断圈得对不对） */
  const distToCircle =
    savedCircle && myPos ? distanceMeters(myPos, savedCircle) : null;

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

          {/*
            ⚠️ 这一段是本次新增的核心反馈：
               告诉用户"这次会用什么坐标提交"，以及"圈得对不对"。
               以前这里什么都不说，签不上只能猜。
          */}
          {target ? (
            <>
              <Spacer h={spacing.sm} />
              {savedCircle ? (
                <Txt variant="caption" c={color.success[600]} style={{ lineHeight: 17 }}>
                  {`✅ 会用「${targetCourse?.name ?? '这门课'}」预设的范围提交` +
                    `（半径 ${savedCircle.radius}m）`}
                  {distToCircle !== null
                    ? `\n你当前位置离圈心约 ${formatDistance(distToCircle)}` +
                      `${distToCircle <= savedCircle.radius ? '（在圈内）' : '（在圈外，不影响提交）'}`
                    : ''}
                </Txt>
              ) : (
                <Txt variant="caption" c={color.warning[600]} style={{ lineHeight: 17 }}>
                  {`⚠️「${targetCourse?.name ?? target.courseName ?? '这门课'}」还没设签到范围，` +
                    '这次会用手机真实定位提交。\n建议先设一个范围 —— 那样子不在现场也能签。'}
                </Txt>
              )}
            </>
          ) : null}

          <Spacer h={spacing.md} />
          <Button
            label={busy ? '提交中…' : savedCircle ? '用预设范围签到' : '取当前定位并签到'}
            onPress={() => void submit()}
            disabled={!target || busy}
          />

          <Spacer h={spacing.sm} />
          <Button
            label={savedCircle ? '修改这门课的签到范围' : '给这门课设一个签到范围'}
            variant="secondary"
            onPress={() => router.push('/course-location')}
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
        /** ★ 这一页本身就是位置签到，所以列表里也直接给入口 */
        onSetLocation={() => router.push('/course-location')}
      />
    </>
  );
}
