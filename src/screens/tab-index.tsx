/**
 * 首页 —— 顶层页面，位于底部滑动栏最左。
 *
 * 结构：
 *   ┌──────────────────────────┐
 *   │  可替换的照片（占屏幕 1/2）│
 *   │  早上好                   │
 *   │  2026年10月9日 星期五      │
 *   │  ☀️ 东莞 · 晴 · 26° 22~29°│
 *   └──────────────────────────┘
 *   设置……
 *
 * ⚠️ 天气**不依赖 GPS**：鸿蒙没有 GMS，`LocationServices.API is not available`。
 *    所以主路径是「手动选城市」，定位只作为可选的补充。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ImageBackground,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Banner, Button, Card, Col, Divider, Row, ScreenScroll, Section, Spacer, Txt } from '../components';
import { useCheckin } from '../state/checkinStore';
import { useModules } from '../state/moduleStore';
import { useUpdate } from '../state/updateStore';
import { fmtSize } from '../services/updater';
import {
  fetchWeatherEx,
  formatFullDate,
  getSavedCity,
  greeting,
  setSavedCity,
  type WeatherNow,
} from '../services/weather';
import { PROVINCES } from '../data/chinaCities';
import { store, STORE_KEYS } from '../services/storage';
import { currentAdapterKind } from '../services/checkin';
import { color, radius, spacing } from '../theme/tokens';
import type { TabScreenProps } from '../nav/tabs';

/** 照片卡片占屏幕高度的比例（需求：向下延伸到屏幕一半） */
const PHOTO_RATIO = 0.5;

export function HomeScreen({ router }: TabScreenProps) {
  const { height } = useWindowDimensions();
  const { account } = useCheckin();
  const modules = useModules();
  /** 更新状态 —— 有新版本时在首页最上面提示 */
  const upd = useUpdate();
  const isMock = currentAdapterKind() === 'mock';

  const [photo, setPhoto] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherNow | null>(null);
  const [weatherErr, setWeatherErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  const [city, setCity] = useState<string | null>(null);
  const [cityOpen, setCityOpen] = useState(false);

  const now = new Date();
  const youxueOn = modules.visible.some((r) => r.def.key === 'youxue');

  useEffect(() => {
    (async () => {
      const saved = await store.get<string | null>(STORE_KEYS.homePhoto, null);
      if (saved) setPhoto(saved);
      setCity(await getSavedCity());
    })();
  }, []);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const r = await fetchWeatherEx({ force });
      if (r.data) {
        setWeather(r.data);
        setWeatherErr(null);
      } else {
        setWeatherErr(r.failure?.message ?? '天气未获取');
      }
    } catch (e) {
      setWeatherErr(`取天气失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  /** 选城市（鸿蒙上的主路径 —— 不依赖 GPS） */
  const chooseCity = useCallback(
    async (name: string) => {
      setCity(name);
      setCityOpen(false);
      await setSavedCity(name);
      await load(true);
    },
    [load],
  );

  /** 换背景照片 */
  const pickPhoto = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') {
        setPhotoMsg('没有相册权限，无法选择照片。请到系统「设置 → 应用 → LifeKit → 权限」里允许读取照片。');
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.85,
        allowsEditing: true,
        aspect: [3, 4],
      });
      if (res.canceled || !res.assets?.length) return;
      const uri = res.assets[0].uri;
      setPhoto(uri);
      await store.set(STORE_KEYS.homePhoto, uri);
      setPhotoMsg(null);
    } catch (e) {
      setPhotoMsg(`选择照片失败：${(e as Error).message}`);
    }
  }, []);

  const photoHeight = Math.round(height * PHOTO_RATIO);

  const weatherLine = weather
    ? [
        weather.city || null,
        weather.label,
        `${weather.temperature}°`,
        weather.high !== undefined && weather.low !== undefined ? `${weather.low}°~${weather.high}°` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <>
      <ScreenScroll
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.primary[500]} />
        }
      >
        {/*
          ══════════ ★「检查更新」板块 ══════════
          需求：「首页如果需要更新加一个检查更新板块」

          三种状态各自的样子：
            · 有新版本   → 醒目横幅 + 「去更新」按钮
            · 正在下载   → 进度
            · 其他情况   → 一行版本号 + 「检查更新」按钮（平时也能手动查）

          为什么要常驻一行而不是"有更新才显示"：
            弹窗被用户关掉之后，他得有个地方能找回来 ——
            如果这里也只在"有更新"时出现，那关掉弹窗就等于没提示了。
        */}
        <Section title="检查更新" style={{ marginTop: spacing.sm }}>
          <Card style={{ padding: spacing.md }}>
            {upd.phase === 'available' && upd.info ? (
              <>
                <Banner
                  tone="info"
                  title={`有新版本 ${upd.info.version}${
                    upd.info.sizeBytes ? `（${fmtSize(upd.info.sizeBytes)}）` : ''
                  }`}
                  message={upd.info.note || '点右边直接下载并安装，不用让别人传给你。'}
                  actionLabel="去更新"
                  onAction={() => void upd.actions.downloadAndInstall()}
                />
                <Spacer h={spacing.sm} />
                <Txt variant="caption" c={color.text.tertiary}>
                  {`当前版本 ${upd.current.version}`}
                </Txt>
              </>
            ) : upd.phase === 'downloading' ? (
              <>
                <Txt variant="body2" weight="medium">
                  {`正在下载新版本… ${Math.round(upd.progress * 100)}%`}
                </Txt>
                <Spacer h={4} />
                <Txt variant="caption" c={color.text.tertiary}>
                  下完会自动打开安装界面，中途别退出 App。
                </Txt>
              </>
            ) : upd.phase === 'installing' ? (
              <>
                <Txt variant="body2" weight="medium">
                  已下载完成，请在系统界面点「安装」
                </Txt>
                <Spacer h={4} />
                <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
                  如果没弹出安装界面，去「设置 → 应用 → LifeKit → 安装未知应用」打开开关再试。
                </Txt>
              </>
            ) : (
              <Row justify="space-between" align="center" gap={spacing.md}>
                <Col flex={1} gap={2}>
                  <Txt variant="body2" weight="medium">
                    {`当前版本 ${upd.current.version}`}
                  </Txt>
                  <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
                    {upd.phase === 'checking'
                      ? '正在检查…'
                      : upd.phase === 'uptodate'
                        ? '已是最新版本'
                        : upd.phase === 'error'
                          ? upd.error || '检查失败'
                          : '有新版本时会自动提示'}
                  </Txt>
                  {/*
                    ★ 显示"连的是哪台服务器"。
                    ⚠️ 为什么需要：有两台服务器在跑同一套代码 ——
                       宿舍局域网那台、阿里云那台。版本号当然一样，
                       所以光看版本**分不出连的是哪台**。
                       有了主机名就能一眼看出（也便于排查"更新查不到"这类问题）。
                  */}
                  {upd.serverText ? (
                    <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
                      {upd.serverText}
                    </Txt>
                  ) : null}
                </Col>
                <Button
                  label={upd.phase === 'checking' ? '检查中…' : '检查更新'}
                  variant="secondary"
                  onPress={() => void upd.actions.check(true)}
                  disabled={upd.phase === 'checking'}
                />
              </Row>
            )}

            {/*
              ⚠️ 更新失败要单独给一条醒目的提示。
              光靠在上面那行小字里塞错误信息不够 ——
              多行错误（比如"没开安装未知应用"那一大段指引）挤在小字里看不清。
            */}
            {upd.phase === 'error' && upd.error ? (
              <>
                <Spacer h={spacing.sm} />
                <Banner
                  tone="warning"
                  title="更新失败"
                  message={upd.error}
                  actionLabel="知道了"
                  onAction={() => upd.actions.dismiss()}
                />
              </>
            ) : null}
          </Card>
        </Section>

        {isMock ? (
          <Section>
            <Banner
              tone="warning"
              title="当前是 MOCK 模式（假数据）"
              message="App 没有连接优学院。绑定会成功，但签到、作业、课件全是本地假数据。"
            />
          </Section>
        ) : null}

        {/* ── 照片卡片（占屏幕一半） ── */}
        <Section style={{ marginTop: spacing.md }}>
          <Pressable onPress={() => void pickPhoto()}>
            <ImageBackground
              source={photo ? { uri: photo } : undefined}
              style={[styles.photoCard, { height: photoHeight }]}
              imageStyle={styles.photoImage}
            >
              {/*
                没照片时只铺一层纯色，不叠渐变（否则会"上浅下深"分成两块）。
                有照片时**也不加渐变遮罩** —— 需求：去掉照片下半部分的阴影。
              */}
              {!photo ? <View style={styles.photoFallback} pointerEvents="none" /> : null}

              <View style={styles.photoContent}>
                <View style={{ flex: 1 }} />

                {/*
                  去掉渐变遮罩后，白色文字在浅色照片上会看不清。
                  这里用**文字描边**（textShadow）兜底 ——
                  任何照片上都能读，又不会像遮罩那样压暗整块画面。
                */}
                <Txt variant="h1" weight="bold" c="#FFFFFF" style={styles.onPhoto}>
                  {greeting(now)}
                </Txt>
                <Txt variant="body2" c="#FFFFFF" style={[styles.onPhoto, { marginTop: 4 }]}>
                  {formatFullDate(now)}
                </Txt>

                <Row gap={spacing.sm} align="center" style={{ marginTop: spacing.sm }}>
                  <Txt variant="body" c="#FFFFFF" style={styles.onPhoto}>
                    {weather ? weather.icon : '🌡️'}
                  </Txt>
                  <Txt
                    variant="body2"
                    c="#FFFFFF"
                    numberOfLines={1}
                    style={[styles.onPhoto, { flex: 1 }]}
                  >
                    {weatherLine ?? (loading ? '正在获取天气…' : '未选择城市')}
                  </Txt>
                  <Pressable
                    onPress={() => setCityOpen(true)}
                    hitSlop={10}
                    style={{
                      paddingHorizontal: spacing.md,
                      paddingVertical: 5,
                      borderRadius: radius.full,
                      backgroundColor: 'rgba(0,0,0,0.28)',
                    }}
                  >
                    <Txt variant="caption" c="#FFFFFF" weight="medium" style={styles.onPhoto}>
                      {city ? '换城市' : '选城市'}
                    </Txt>
                  </Pressable>
                </Row>

                <Txt variant="caption" c="#FFFFFF" style={[styles.onPhoto, { marginTop: spacing.md }]}>
                  点一下更换背景照片
                </Txt>
              </View>
            </ImageBackground>
          </Pressable>

          {photoMsg ? (
            <>
              <Spacer h={spacing.sm} />
              <Banner tone="warning" title={photoMsg} actionLabel="知道了" onAction={() => setPhotoMsg(null)} />
            </>
          ) : null}

          {weatherErr ? (
            <>
              <Spacer h={spacing.sm} />
              <Banner
                tone="warning"
                title="天气拿不到"
                message={weatherErr}
                actionLabel="选城市"
                onAction={() => setCityOpen(true)}
              />
            </>
          ) : null}
        </Section>

        {/* ── 设置 ── */}
        <Section title="设置">
          <Card style={{ padding: 0 }}>
            <Pressable onPress={() => router.push('/settings')}>
              <Row justify="space-between" style={{ padding: spacing.base }} gap={spacing.md}>
                <Row gap={spacing.md} style={{ flex: 1 }}>
                  <Txt variant="body">⚙</Txt>
                  <Col flex={1} gap={2}>
                    <Txt variant="body" weight="medium">
                      设置
                    </Txt>
                    <Txt variant="small" c={color.text.tertiary} numberOfLines={1}>
                      功能模块与偏好
                    </Txt>
                  </Col>
                </Row>
                <Txt variant="body2" c={color.neutral[400]}>
                  ›
                </Txt>
              </Row>
            </Pressable>

            {/* 优学院入口只在模块已开启时出现（默认锁定） */}
            {youxueOn ? (
              <>
                <Divider />
                <Pressable onPress={() => router.push('/youxue-bind')}>
                  <Row justify="space-between" style={{ padding: spacing.base }} gap={spacing.md}>
                    <Row gap={spacing.md} style={{ flex: 1 }}>
                      <Txt variant="body">🎓</Txt>
                      <Col flex={1} gap={2}>
                        <Txt variant="body" weight="medium">
                          优学院账号
                        </Txt>
                        <Txt variant="small" c={color.text.tertiary} numberOfLines={1}>
                          {account ? '已连接' : '未绑定'}
                        </Txt>
                      </Col>
                    </Row>
                    <Txt variant="body2" c={color.neutral[400]}>
                      ›
                    </Txt>
                  </Row>
                </Pressable>
              </>
            ) : null}
          </Card>
        </Section>

      </ScreenScroll>

      {/* ── 选城市弹层 ──
          鸿蒙上没有 GMS 定位，所以城市必须能手动选。 */}
      <Modal visible={cityOpen} transparent animationType="slide" onRequestClose={() => setCityOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setCityOpen(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <Row justify="space-between" align="center">
              <Txt variant="h3" weight="bold">
                选择城市
              </Txt>
              <Pressable onPress={() => setCityOpen(false)} hitSlop={10}>
                <Txt variant="body2" c={color.text.tertiary}>
                  关闭
                </Txt>
              </Pressable>
            </Row>
            <Spacer h={6} />
            <Txt variant="caption" c={color.text.tertiary}>
              这台设备用不了系统定位，所以手动选一个城市。
            </Txt>
            <Spacer h={spacing.md} />

            <ScrollView style={{ maxHeight: 460 }}>
              {PROVINCES.map((p) => (
                <View key={p.province} style={{ marginBottom: spacing.md }}>
                  <Txt variant="small" weight="semibold" c={color.text.secondary}>
                    {p.province}
                  </Txt>
                  <Spacer h={6} />
                  <View style={styles.cityWrap}>
                    {p.cities.map((c) => {
                      const active = c.name === city;
                      return (
                        <Pressable
                          key={`${p.province}-${c.name}`}
                          onPress={() => void chooseCity(c.name)}
                          style={[styles.cityChip, active && styles.cityChipActive]}
                        >
                          <Txt
                            variant="body2"
                            weight={active ? 'semibold' : 'regular'}
                            c={active ? color.text.inverse : color.text.primary}
                          >
                            {c.name}
                          </Txt>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ))}
            </ScrollView>

            <Spacer h={spacing.md} />
            <Button label="关闭" variant="secondary" onPress={() => setCityOpen(false)} />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  photoCard: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  photoImage: { borderRadius: radius.lg },
  photoFallback: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: color.primary[500],
  },
  photoContent: {
    flex: 1,
    padding: spacing.lg,
  },
  /**
   * 照片上的文字：用**描边**保证可读性。
   *
   * 为什么不用半透明黑色遮罩：那会压暗整块照片（用户明确要求去掉）。
   * 描边只加在文字笔画周围，照片本身保持原样。
   */
  onPhoto: {
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
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
  cityWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  cityChip: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: color.neutral[200],
    backgroundColor: color.neutral[50],
  },
  cityChipActive: {
    backgroundColor: color.primary[500],
    borderColor: color.primary[500],
  },
});
