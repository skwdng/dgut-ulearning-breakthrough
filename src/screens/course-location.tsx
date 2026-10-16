/**
 * 课程签到位置设置页（地图选点 + 围一个圈）。
 *
 * ══════════════ 用户需求（原话）══════════════
 *
 *   「给我把位置签到完善一下，要做到要在发起签到的设备围一个圈选位置」
 *   「要不就自己引用个地图，手指滑动，让标点对准位置」
 *
 * ══════════════ 这个页面解决什么问题 ══════════════
 *
 * **位置签到一直只能用手机真实 GPS** —— 人不在教室就签不了。
 *
 * 但 `Course.location`（`{latitude, longitude, radius, address?}`）
 * 和 `utils/geo.ts` 的圈内取点算法**早就写好了**，`courseLocation()` 也一直在读它 ——
 * **只是从来没有界面去写这个字段**。所以这个页面补上那一环：
 * 给每门课在地图上圈一个范围，之后这门课的定位签到就用**圈内随机点**提交。
 *
 * ⚠️ 服务端仍然会校验坐标 —— 所以这个"圈"必须圈在**老师允许的范围内**。
 *    老师设的圈服务端不下发（签到详情接口的 `location` 返回空串，实测），
 *    所以只能靠你自己知道教室在哪。
 *
 * ══════════════ 半径怎么定 ══════════════
 *
 * 默认 120m。太小容易因为 GPS 漂移被拒，太大会飘出老师设的范围。
 * 界面上给 50 / 120 / 200 / 300 四档 —— 够用且不用打字。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Location from 'expo-location';
import { Banner, Button, Card, Col, Row, ScreenScroll, Section, Spacer, Txt } from '../components';
import { MapPicker } from '../components/MapPicker';
import { color, radius as radii, spacing } from '../theme/tokens';
import { useCheckin } from '../state/checkinStore';
import { useRouter } from '../nav/router';
import { defaultCircleFor, distanceMeters, formatDistance, type Circle } from '../utils/geo';
import {
  describeGeoFailure,
  probeLocation,
  tryGetCurrentPosition,
  tryGetLastKnownPosition,
} from '../utils/geoRuntime';
import { Pressable } from 'react-native';

/** 半径档位（米） */
const RADIUS_PRESETS = [50, 120, 200, 300];

/** 东莞理工学院（松山湖）—— 没有任何已知位置时的地图初始中心 */
const FALLBACK_CENTER = { latitude: 23.0207, longitude: 113.8266 };

export function CourseLocationScreen() {
  const router = useRouter();
  const { courses, actions } = useCheckin();

  const [courseId, setCourseId] = useState<string | null>(null);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [locating, setLocating] = useState(false);

  /** 有圈的课程排前面，方便看到已经设过的 */
  const sorted = useMemo(() => {
    const withLoc = courses.filter((c) => c.location);
    const without = courses.filter((c) => !c.location);
    return [...withLoc, ...without];
  }, [courses]);

  /** 选中课程 → 载入它已存的位置；没存过就用"当前定位"当起点 */
  const selectCourse = useCallback(async (id: string) => {
    setCourseId(id);
    setMsg(null);
    const c = courses.find((x) => x.id === id);
    const existing = defaultCircleFor(c?.location);
    if (existing) {
      setCircle(existing);
      return;
    }
    /**
     * ⚠️ 没存过 → 试着用**当前定位**当起点，这样用户不用在地图上瞎找。
     *
     *    ⚠️ 必须用 `probeLocation()` / `tryGetCurrentPosition()`（utils/geoRuntime），
     *       **不要直接调 `Location.*`** —— 没装 Google 服务的手机
     *       （国产机基本都是）调 `requestForegroundPermissionsAsync()`
     *       **会直接抛原生异常**，把整页搞成报错页。真机实测踩过。
     */
    setLocating(true);
    try {
      const state = await probeLocation();
      const pos = state === 'ok' ? await tryGetCurrentPosition() : null;
      if (pos) {
        setCircle({ latitude: pos.latitude, longitude: pos.longitude, radius: 120 });
      } else {
        setCircle({ ...FALLBACK_CENTER, radius: 120 });
        /**
         * ⚠️ 只有**真的拒绝了权限**才提示"去设置里开"；
         *    设备不支持时说那句是误导（开了也没用）。
         */
        setMsg({
          tone: 'info',
          text:
            state === 'ok'
              ? '暂时取不到当前位置，已把地图放在学校位置，请手动拖到教室。'
              : `${describeGeoFailure(state)}\n已把地图放在学校位置。`,
        });
      }
    } finally {
      setLocating(false);
    }
  }, [courses]);

  /** 自动选第一门课（有圈的优先），省一次点击 */
  useEffect(() => {
    if (courseId || !sorted.length) return;
    void selectCourse(sorted[0].id);
  }, [courseId, sorted, selectCourse]);

  /**
   * 把地图移到我当前所在的位置。
   *
   * ⚠️ 真机踩过：这台手机没有 Google 服务，原来直接调
   *    `Location.requestForegroundPermissionsAsync()` 抛了原生异常
   *    （`LocationServices.API is not available on this device`），
   *    向用户弹了一整段英文报错。现在走容错封装，失败就**说人话**。
   *
   * ⚠️ 精度用 `Balanced` 而不是 `High`：
   *    只是把地图挪过去当起点，不需要米级精度；
   *    High 在室内经常超时，反而失败率更高。
   */
  const gotoMyLocation = useCallback(async () => {
    if (!circle) return;
    setLocating(true);
    setMsg(null);
    try {
      const state = await probeLocation();
      if (state !== 'ok') {
        setMsg({ tone: 'error', text: describeGeoFailure(state) });
        return;
      }
      const pos = await tryGetCurrentPosition();
      if (!pos) {
        setMsg({ tone: 'error', text: describeGeoFailure('failed') });
        return;
      }
      setCircle({ ...circle, latitude: pos.latitude, longitude: pos.longitude });
      setMsg({
        tone: 'info',
        text: `已移动到当前位置（精度约 ${Math.round(pos.accuracy ?? 0)}m）`,
      });
    } finally {
      setLocating(false);
    }
  }, [circle]);

  const save = useCallback(async () => {
    if (!courseId || !circle) return;
    setBusy(true);
    setMsg(null);
    try {
      await actions.setCourseLocation(courseId, {
        latitude: circle.latitude,
        longitude: circle.longitude,
        radius: circle.radius,
      });
      setMsg({ tone: 'info', text: '已保存。这门课的位置签到会用这个圈里的点提交。' });
    } finally {
      setBusy(false);
    }
  }, [courseId, circle, actions]);

  const clearIt = useCallback(async () => {
    if (!courseId) return;
    setBusy(true);
    try {
      await actions.setCourseLocation(courseId, null);
      setCircle(null);
      setMsg({ tone: 'info', text: '已清除这门课的位置。之后位置签到用手机真实定位。' });
    } finally {
      setBusy(false);
    }
  }, [courseId, actions]);

  const current = courses.find((c) => c.id === courseId);
  /**
   * 当前位置离圈心多远（给用户一个"我圈得对不对"的直观参考）。
   *
   * ⚠️ 用容错封装：拿不到就是 `null`，界面上少显示一行而已，
   *    **绝不能让"参考信息"失败把整页搞崩**。无 GMS 手机上
   *    原来的 `Location.getForegroundPermissionsAsync()` 会抛。
   */
  const [myPos, setMyPos] = useState<{ latitude: number; longitude: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const pos = await tryGetLastKnownPosition();
      if (alive && pos) setMyPos(pos);
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <ScreenScroll>
      {/* ── 选课程 ── */}
      <Section style={{ marginTop: spacing.sm }} title={`选择课程（${courses.length} 门）`}>
        <Card style={{ padding: 0 }}>
          {sorted.length === 0 ? (
            <Col gap={spacing.sm} style={{ padding: spacing.base }}>
              <Txt variant="body2" c={color.text.secondary}>
                还没有课程。先去「优学院」页查询一次，把课程拉下来。
              </Txt>
            </Col>
          ) : (
            sorted.slice(0, 30).map((c, i) => {
              const active = c.id === courseId;
              return (
                <Pressable
                  key={c.id}
                  onPress={() => void selectCourse(c.id)}
                  style={{
                    paddingHorizontal: spacing.base,
                    paddingVertical: spacing.md,
                    borderTopWidth: i > 0 ? 1 : 0,
                    borderTopColor: color.neutral[100],
                    backgroundColor: active ? color.primary[50] : 'transparent',
                  }}
                >
                  <Row justify="space-between" align="center" gap={spacing.sm}>
                    <Col flex={1} gap={2}>
                      <Txt variant="body2" weight={active ? 'medium' : 'regular'}>
                        {c.name}
                      </Txt>
                      <Txt variant="caption" c={color.text.tertiary}>
                        {c.location
                          ? `已设位置　半径 ${c.location.radius ?? 120}m`
                          : '未设位置（位置签到会用手机真实定位）'}
                      </Txt>
                    </Col>
                    {active ? (
                      <Txt variant="caption" c={color.primary[500]} weight="medium">
                        编辑中
                      </Txt>
                    ) : null}
                  </Row>
                </Pressable>
              );
            })
          )}
        </Card>
        {sorted.length > 30 ? (
          <>
            <Spacer h={spacing.xs} />
            <Txt variant="caption" c={color.text.tertiary}>
              {`只列了前 30 门（共 ${sorted.length} 门）。已设位置的排在前面。`}
            </Txt>
          </>
        ) : null}
      </Section>

      {/* ── 地图选点 ── */}
      {circle ? (
        <Section title={current ? `围范围：${current.name}` : '围范围'}>
          <Card>
            <MapPicker initial={circle} onChange={setCircle} height={320} />

            <Spacer h={spacing.sm} />
            <Row justify="space-between" align="center">
              <Txt variant="caption" c={color.text.tertiary}>
                {`圈心 ${circle.latitude.toFixed(5)}, ${circle.longitude.toFixed(5)}`}
              </Txt>
              <Pressable onPress={() => void gotoMyLocation()} hitSlop={8} disabled={locating}>
                <Txt variant="caption" c={color.primary[500]} weight="medium">
                  {locating ? '定位中…' : '移到我的位置'}
                </Txt>
              </Pressable>
            </Row>

            {/* 半径档位 */}
            <Spacer h={spacing.md} />
            <Txt variant="caption" c={color.text.secondary}>
              范围半径
            </Txt>
            <Spacer h={spacing.sm} />
            <Row gap={spacing.sm}>
              {RADIUS_PRESETS.map((r) => {
                const on = circle.radius === r;
                return (
                  <Pressable
                    key={r}
                    onPress={() => setCircle({ ...circle, radius: r })}
                    style={{
                      flex: 1,
                      paddingVertical: spacing.sm,
                      borderRadius: radii.md,
                      borderWidth: 1,
                      borderColor: on ? color.primary[500] : color.neutral[200],
                      backgroundColor: on ? color.primary[50] : 'transparent',
                      alignItems: 'center',
                    }}
                  >
                    <Txt variant="caption" c={on ? color.primary[500] : color.text.secondary}>
                      {`${r}m`}
                    </Txt>
                  </Pressable>
                );
              })}
            </Row>

            {/* 当前位置离圈心多远 —— 用来判断圈得对不对 */}
            {myPos ? (
              <>
                <Spacer h={spacing.sm} />
                <Txt variant="caption" c={color.text.tertiary}>
                  {`你当前位置离圈心约 ${formatDistance(
                    distanceMeters(myPos, circle),
                  )}${distanceMeters(myPos, circle) <= circle.radius ? '（在圈内）' : '（在圈外）'}`}
                </Txt>
              </>
            ) : null}

            <Spacer h={spacing.base} />
            <Row gap={spacing.sm}>
              <Button
                label={busy ? '保存中…' : '保存这个位置'}
                onPress={() => void save()}
                disabled={busy}
                style={{ flex: 1 }}
              />
              <Button
                label="清除"
                variant="secondary"
                onPress={() => void clearIt()}
                disabled={busy || !current?.location}
                style={{ flex: 1 }}
              />
            </Row>
          </Card>

          <Spacer h={spacing.sm} />
          <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
            {'保存后，这门课的位置签到会用圈内随机一个点提交（不是手机真实定位）。\n'}
            {'⚠️ 圈要围在老师允许的范围内 —— 服务端仍会校验坐标，圈歪了照样签不上。'}
          </Txt>
        </Section>
      ) : null}

      {msg ? (
        <Section>
          <Banner
            tone={msg.tone === 'error' ? 'warning' : 'info'}
            title={msg.text}
            actionLabel="知道了"
            onAction={() => setMsg(null)}
          />
        </Section>
      ) : null}

      <Section>
        <Button label="去位置签到页" variant="secondary" onPress={() => router.push('/sign-location')} />
      </Section>
    </ScreenScroll>
  );
}
