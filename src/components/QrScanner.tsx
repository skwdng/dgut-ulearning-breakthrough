/**
 * 二维码扫描签到组件。
 *
 * 使用场景：教师投屏签到二维码 → 学生用本组件扫描 → 自动解析并提交签到。
 * 关键细节：
 * - 只接受二维码（`qr`），避免误扫其他码；
 * - 扫到第一张就锁住，防止连续多次提交（服务端会判重复）；
 * - 提示"请扫描投屏上的二维码"，并显示剩余时间；
 * - 也支持从相册选图识别（部分场景用户已截屏）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { Badge, Button, Col, Row, Txt } from './index';
import { color, radius, spacing } from '../theme/tokens';

export function QrScanner({
  onScanned,
  submitting,
  remainingSec,
  disabled,
}: {
  onScanned: (payload: string) => void;
  submitting?: boolean;
  remainingSec?: number;
  disabled?: boolean;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [locked, setLocked] = useState(false);
  const [lastPayload, setLastPayload] = useState<string | null>(null);
  const lockedRef = useRef(false);

  useEffect(() => {
    lockedRef.current = locked || Boolean(submitting) || Boolean(disabled);
  }, [locked, submitting, disabled]);

  const handleScan = useCallback(
    (result: BarcodeScanningResult) => {
      if (lockedRef.current) return;
      const data = result.data?.trim();
      if (!data) return;
      lockedRef.current = true;
      setLocked(true);
      setLastPayload(data);
      onScanned(data);
    },
    [onScanned],
  );

  const unlock = () => {
    lockedRef.current = false;
    setLocked(false);
    setLastPayload(null);
  };

  if (!permission) {
    return (
      <View style={styles.placeholder}>
        <Txt variant="body2" c={color.text.secondary}>正在检查相机权限…</Txt>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.placeholder}>
        <Col align="center" gap={spacing.md} style={{ paddingHorizontal: spacing.lg }}>
          <Txt variant="body" weight="semibold" align="center">
            需要相机权限才能扫码签到
          </Txt>
          <Txt variant="caption" c={color.text.tertiary} align="center">
            二维码签到要求现场扫描教师投屏的二维码
          </Txt>
          <Button label="授予相机权限" onPress={() => void requestPermission()} />
        </Col>
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={locked || disabled ? undefined : handleScan}
      />

      {/* 取景框 */}
      <View style={styles.overlay} pointerEvents="none">
        <View style={styles.frame}>
          <Corner style={{ top: -2, left: -2, borderTopWidth: 3, borderLeftWidth: 3 }} />
          <Corner style={{ top: -2, right: -2, borderTopWidth: 3, borderRightWidth: 3 }} />
          <Corner style={{ bottom: -2, left: -2, borderBottomWidth: 3, borderLeftWidth: 3 }} />
          <Corner style={{ bottom: -2, right: -2, borderBottomWidth: 3, borderRightWidth: 3 }} />
        </View>
      </View>

      {/* 顶部提示 */}
      <View style={styles.topBar} pointerEvents="none">
        <Badge
          text={remainingSec !== undefined ? `剩余 ${remainingSec}s` : '请扫描投屏二维码'}
          fg={remainingSec !== undefined && remainingSec < 30 ? color.error[500] : color.text.inverse}
          bg={remainingSec !== undefined && remainingSec < 30 ? color.error[50] : 'rgba(0,0,0,0.45)'}
        />
      </View>

      {/* 底部状态 */}
      <View style={styles.bottomBar}>
        {submitting ? (
          <Txt variant="body2" c={color.text.inverse}>正在提交签到…</Txt>
        ) : lastPayload ? (
          <Col align="center" gap={spacing.sm}>
            <Txt variant="body2" c={color.text.inverse}>
              已识别二维码（{lastPayload.length} 字符）
            </Txt>
            <Row gap={spacing.sm}>
              <Pressable onPress={unlock} style={styles.retryBtn}>
                <Txt variant="caption" c={color.text.inverse}>重新扫描</Txt>
              </Pressable>
            </Row>
          </Col>
        ) : (
          <Txt variant="body2" c={color.text.inverse} align="center">
            将取景框对准教师投屏的签到二维码
          </Txt>
        )}
      </View>
    </View>
  );
}

function Corner({ style }: { style: object }) {
  return <View style={[styles.corner, style]} />;
}

const FRAME = 240;

const styles = StyleSheet.create({
  wrapper: {
    height: 360,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  placeholder: {
    height: 200,
    borderRadius: radius.lg,
    backgroundColor: color.neutral[100],
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  frame: { width: FRAME, height: FRAME, borderRadius: radius.md },
  corner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: color.primary[400],
    borderRadius: 4,
  },
  topBar: { position: 'absolute', top: spacing.md, left: 0, right: 0, alignItems: 'center' },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.base,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
  },
  retryBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
  },
});
