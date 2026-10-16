/**
 * 定位签到范围选择器。
 *
 * 交互（对应需求"在发起签到设备范围内自己选范围"）：
 * 1) 展示教师设定的签到范围（中心点 + 半径）——这是"合法区域"；
 * 2) 显示你当前的真实位置与到中心的距离，明确告诉你在不在范围内；
 * 3) 让你在这个范围内**自己选点**：点击圆内任意位置 / 用当前位置 / 一键取范围内的点；
 * 4) 提交前明确标出"将提交的坐标"。
 *
 * 为什么不接地图 SDK：地图瓦片需要 Key 与网络；这里用矢量画布表达
 * "范围 / 你的位置 / 选定点"三件事，功能等价且无外部依赖。接高德/腾讯后
 * 只需把这个画布换成 MapView，逻辑层不用动。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import * as Location from 'expo-location';
import Svg, { Circle as SvgCircle, Line, Text as SvgText } from 'react-native-svg';
import { Badge, Button, Card, Col, Row, Spacer, Txt } from './index';
import { color, radius, spacing } from '../theme/tokens';
import {
  distanceMeters,
  formatDistance,
  isInside,
  nearestPointInside,
  randomPointInCircle,
  type Circle,
  type LatLng,
} from '../utils/geo';
import { describeGeoFailure, probeLocation, tryGetCurrentPosition } from '../utils/geoRuntime';

const SIZE = 280;
const CENTER = SIZE / 2;
const MAX_DRAW_RADIUS = 110; // 画布上圆的最大像素半径

export function LocationPicker({
  circle,
  onSubmit,
  submitting,
  remainingSec,
}: {
  circle: Circle;
  onSubmit: (point: LatLng) => void;
  submitting?: boolean;
  remainingSec?: number;
}) {
  const [device, setDevice] = useState<LatLng | null>(null);
  const [picked, setPicked] = useState<LatLng | null>(null);
  const [locError, setLocError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scale = useMemo(() => MAX_DRAW_RADIUS / circle.radius, [circle.radius]);

  const toPixel = (p: LatLng) => {
    // 以圆心为原点，东为 x、北为 y（近似，足够小的范围误差可忽略）
    const dx = (p.longitude - circle.longitude) * 111320 * Math.cos((circle.latitude * Math.PI) / 180);
    const dy = (p.latitude - circle.latitude) * 111320;
    return { x: CENTER + dx * scale, y: CENTER - dy * scale };
  };

  const fromPixel = (x: number, y: number): LatLng => {
    const dx = (x - CENTER) / scale;
    const dy = (CENTER - y) / scale;
    return {
      latitude: circle.latitude + dy / 111320,
      longitude: circle.longitude + dx / (111320 * Math.cos((circle.latitude * Math.PI) / 180) || 1),
    };
  };

  /**
   * 读一次设备定位（只在圆里显示"你在哪"这个参考点）。
   *
   * ⚠️ 用容错封装（utils/geoRuntime）——
   *    没装 Google 服务的手机（国产机基本都是）直接调 `Location.*`
   *    会**抛原生异常**。原来 `catch` 之后把 `e.message` 原样显示，
   *    结果界面上出现一整段
   *      `Location request has been rejected: 17: API: LocationServices...`
   *    用户完全看不懂。真机实测踩过。
   *
   *    现在失败时给**说人话**的提示，并说明"手动选点照样能用"。
   */
  const readDeviceLocation = async () => {
    setBusy(true);
    setLocError(null);
    try {
      const state = await probeLocation();
      if (state !== 'ok') {
        setLocError(describeGeoFailure(state));
        return;
      }
      const pos = await tryGetCurrentPosition(Location.Accuracy.High);
      if (!pos) {
        setLocError(describeGeoFailure('failed'));
        return;
      }
      const point = { latitude: pos.latitude, longitude: pos.longitude };
      setDevice(point);
      setPicked((prev) => prev ?? point);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void readDeviceLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickedDistance = picked ? distanceMeters(picked, circle) : null;
  const deviceDistance = device ? distanceMeters(device, circle) : null;
  const pickedInside = pickedDistance !== null && pickedDistance <= circle.radius;

  const handleTap = (evt: { nativeEvent: { locationX: number; locationY: number } }) => {
    const { locationX, locationY } = evt.nativeEvent;
    const p = fromPixel(locationX, locationY);
    // 点在圆外时吸附回范围内，避免用户提交非法坐标
    setPicked(isInside(p, circle) ? p : nearestPointInside(p, circle));
  };

  const devicePixel = device ? toPixel(device) : null;
  const pickedPixel = picked ? toPixel(picked) : null;

  return (
    <Col gap={spacing.md}>
      {/* 范围信息 */}
      <Row justify="space-between">
        <Col gap={2}>
          <Txt variant="body2" weight="medium">签到范围</Txt>
          <Txt variant="caption" c={color.text.tertiary}>
            中心 {circle.latitude.toFixed(5)}, {circle.longitude.toFixed(5)} · 半径 {circle.radius}m
          </Txt>
        </Col>
        {remainingSec !== undefined ? (
          <Badge
            text={`剩余 ${remainingSec}s`}
            fg={remainingSec < 30 ? color.error[500] : color.success[500]}
            bg={remainingSec < 30 ? color.error[50] : color.success[50]}
          />
        ) : null}
      </Row>

      {/* 范围画布：点圆内任意位置选点 */}
      <Pressable onPress={handleTap}>
        <View style={{ borderRadius: radius.lg, overflow: 'hidden', backgroundColor: color.neutral[50] }}>
          <Svg width="100%" height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
            {/* 经纬网格 */}
            {[0.25, 0.5, 0.75].map((r) => (
              <SvgCircle
                key={r}
                cx={CENTER}
                cy={CENTER}
                r={MAX_DRAW_RADIUS * r}
                stroke={color.neutral[200]}
                strokeWidth={1}
                fill="none"
              />
            ))}
            <Line x1={0} y1={CENTER} x2={SIZE} y2={CENTER} stroke={color.neutral[200]} strokeWidth={1} />
            <Line x1={CENTER} y1={0} x2={CENTER} y2={SIZE} stroke={color.neutral[200]} strokeWidth={1} />

            {/* 合法范围 */}
            <SvgCircle cx={CENTER} cy={CENTER} r={MAX_DRAW_RADIUS} fill={color.primary[50]} />
            <SvgCircle
              cx={CENTER}
              cy={CENTER}
              r={MAX_DRAW_RADIUS}
              stroke={color.primary[500]}
              strokeWidth={2}
              strokeDasharray="6 4"
              fill="none"
            />
            <SvgText x={CENTER} y={CENTER - MAX_DRAW_RADIUS - 6} fontSize={10} fill={color.primary[600]} textAnchor="middle">
              可签到范围
            </SvgText>

            {/* 中心点 */}
            <SvgCircle cx={CENTER} cy={CENTER} r={4} fill={color.primary[600]} />

            {/* 设备真实位置 */}
            {devicePixel ? (
              <>
                <SvgCircle cx={devicePixel.x} cy={devicePixel.y} r={7} fill={color.neutral[400]} opacity={0.35} />
                <SvgCircle cx={devicePixel.x} cy={devicePixel.y} r={4} fill={color.neutral[600]} />
                <SvgText x={devicePixel.x + 8} y={devicePixel.y + 4} fontSize={9} fill={color.neutral[700]}>
                  我的位置
                </SvgText>
              </>
            ) : null}

            {/* 选定的提交点 */}
            {pickedPixel ? (
              <>
                <SvgCircle cx={pickedPixel.x} cy={pickedPixel.y} r={9} fill={color.success[500]} opacity={0.25} />
                <SvgCircle
                  cx={pickedPixel.x}
                  cy={pickedPixel.y}
                  r={5}
                  fill={pickedInside ? color.success[500] : color.error[500]}
                />
                <SvgText x={pickedPixel.x + 8} y={pickedPixel.y - 6} fontSize={9} fill={color.success[600]}>
                  将提交
                </SvgText>
              </>
            ) : null}
          </Svg>
        </View>
      </Pressable>

      <Txt variant="caption" c={color.text.tertiary}>
        点击圆内任意位置即可选定提交坐标；点到圆外会自动吸附到范围内。
      </Txt>

      {/* 距离状态 */}
      <Card style={{ padding: spacing.md }}>
        <Col gap={spacing.sm}>
          <Row justify="space-between">
            <Txt variant="body2" c={color.text.secondary}>我的位置到中心</Txt>
            <Txt variant="body2" weight="medium">
              {deviceDistance === null ? '—' : formatDistance(deviceDistance)}
              {deviceDistance !== null ? (deviceDistance <= circle.radius ? ' · 范围内' : ' · 范围外') : ''}
            </Txt>
          </Row>
          <Row justify="space-between">
            <Txt variant="body2" c={color.text.secondary}>选定点</Txt>
            <Txt variant="body2" weight="medium" c={pickedInside ? color.success[500] : color.error[500]}>
              {pickedDistance === null
                ? '未选择'
                : `${formatDistance(pickedDistance)} · ${pickedInside ? '范围内' : '范围外'}`}
            </Txt>
          </Row>
          {locError ? (
            <Txt variant="caption" c={color.error[500]}>定位读取失败：{locError}</Txt>
          ) : null}
        </Col>
      </Card>

      {/* 快捷操作 */}
      <Row gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
        <Button
          label={busy ? '读取中…' : '用我的当前位置'}
          variant="secondary"
          disabled={busy || !device}
          onPress={() => device && setPicked(device)}
          style={{ height: 40, paddingHorizontal: spacing.md }}
        />
        <Button
          label="范围内取一个点"
          variant="secondary"
          onPress={() => setPicked(randomPointInCircle(circle))}
          style={{ height: 40, paddingHorizontal: spacing.md }}
        />
        <Button
          label="取圆心"
          variant="secondary"
          onPress={() => setPicked({ latitude: circle.latitude, longitude: circle.longitude })}
          style={{ height: 40, paddingHorizontal: spacing.md }}
        />
        <Button
          label="刷新定位"
          variant="text"
          onPress={() => void readDeviceLocation()}
          style={{ height: 40 }}
        />
      </Row>

      {picked && !pickedInside ? (
        <Row gap={spacing.sm} align="center">
          <Badge text="选定点在范围外" fg={color.error[500]} bg={color.error[50]} />
          <Button
            label="吸附回范围内"
            variant="text"
            onPress={() => setPicked(nearestPointInside(picked, circle))}
            style={{ height: 28 }}
          />
        </Row>
      ) : null}

      <Spacer h={spacing.xs} />
      <Button
        label={picked ? `提交定位签到（${circle.radius}m 范围内）` : '请先选择坐标'}
        disabled={!picked || !pickedInside}
        loading={submitting}
        onPress={() => picked && onSubmit(picked)}
      />
    </Col>
  );
}
