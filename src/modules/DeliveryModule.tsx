/**
 * 外卖记录模块。
 *
 * 核心需求：**记录在哪个外卖软件点过哪家店、点过几次**
 * 页面结构：概览 → 店铺排行 → 记录列表 → 待确认 → 记录方式
 */
import React, { useMemo, useState } from 'react';
import { Alert, Platform, Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
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
  Section,
  Spacer,
  Txt,
} from '../components';
import { color, radius, spacing } from '../theme/tokens';
import { useDelivery } from '../state/deliveryStore';
import {
  PLATFORM_META,
  STAGE_LABEL,
  type DeliveryPlatform,
  type DeliveryOrder,
  type DeliveryStage,
} from '../domain/delivery';
import { DeliveryBridge } from '../services/delivery/bridge';
import { parseClipboardOrder } from '../services/delivery/parser';

export function DeliveryModule() {
  const { orders, stats, uncertain, actions, listening } = useDelivery();
  const [showAdd, setShowAdd] = useState(false);
  const [platform, setPlatform] = useState<DeliveryPlatform>('meituan');
  const [storeName, setStoreName] = useState('');
  const [amount, setAmount] = useState('');

  /**
   * ── 粘贴识别 ──
   *
   * ══════════ 为什么要有这条路 ══════════
   * ① iOS 上**永远做不到**读通知（苹果不允许第三方 App 读别的 App 的通知），
   *    所以 iOS 只能靠"复制订单文本 → 粘贴识别"。
   * ② Android 上也有用：通知没抓到、或事后想补记一笔时，
   *    手动填店名和金额很烦，粘贴一下自动带出来。
   *
   * 识别结果会**填进下面的输入框让用户确认**，而不是直接入库 ——
   * 毕竟文本格式千奇百怪，猜错一次就污染统计。
   */
  const [pastePreview, setPastePreview] = useState<string | null>(null);

  const pasteAndParse = async () => {
    try {
      const text = (await Clipboard.getStringAsync()) ?? '';
      if (!text.trim()) {
        Alert.alert('剪贴板是空的', '请先在外卖 App 里复制订单信息（长按订单 → 复制，或复制订单详情）。');
        return;
      }
      const r = parseClipboardOrder(text);
      setShowAdd(true);
      setPlatform(r.platform);
      if (r.storeName) setStoreName(r.storeName);
      if (r.amount !== undefined) setAmount(String(r.amount));

      const bits: string[] = [];
      bits.push(`平台：${PLATFORM_META[r.platform]?.label ?? r.platform}${r.platform === 'other' ? '（没认出来，可手动改）' : ''}`);
      bits.push(`店铺：${r.storeName || '没认出来，请手动填'}`);
      bits.push(`金额：${r.amount !== undefined ? `¥${r.amount}` : '没认出来'}`);
      setPastePreview(bits.join('\n') + '\n\n请核对后点「记一笔」。');
    } catch (e) {
      Alert.alert('读取剪贴板失败', (e as Error).message);
    }
  };

  // 店名自动补全候选（来自历史记录，按出现次数排序）
  const suggestions = useMemo(
    () => stats.topStores.map((s) => s.storeName).slice(0, 8),
    [stats.topStores],
  );

  const recent = useMemo(() => [...orders].sort((a, b) => b.at - a.at).slice(0, 30), [orders]);

  const handleEnable = async () => {
    const available = await DeliveryBridge.isAvailable();
    if (!available) {
      Alert.alert(
        '当前平台不支持自动记录',
        Platform.OS === 'ios'
          ? 'iOS 系统不允许第三方 App 读取其他 App 的通知，所以无法自动记录。可以用下方「手动记一笔」或从外卖 App 复制订单信息后粘贴识别。'
          : '这个功能需要 Android 通知使用权。如果你在 Expo Go 里运行，需要先 prebuild 并使用自定义构建。',
      );
      return;
    }
    const ok = await DeliveryBridge.openNotificationSettings();
    if (ok) actions.setListening(true);
  };

  const submitManual = () => {
    if (!storeName.trim()) return;
    const amt = Number(amount);
    actions.addManual({
      platform,
      storeName: storeName.trim(),
      amount: Number.isFinite(amt) && amt > 0 ? amt : undefined,
    });
    setStoreName('');
    setAmount('');
    setShowAdd(false);
  };

  return (
    <Col gap={0}>
      {!listening ? (
        <Banner
          tone="info"
          title="开启自动记录"
          message="授权通知使用权后，美团/饿了么/京东下单会自动记一笔"
          actionLabel="去授权"
          onAction={() => void handleEnable()}
        />
      ) : null}

      {uncertain.length > 0 ? (
        <Banner
          tone="warning"
          title={`有 ${uncertain.length} 条通知没识别出店名`}
          message="可能是新店或通知改版，确认一下就能计入统计"
          actionLabel="去确认"
          onAction={() => {}}
        />
      ) : null}

      {/* ---------- 概览 ---------- */}
      <Section style={{ marginTop: spacing.md }}>
        <Card variant="elevated" style={{ padding: spacing.lg }}>
          <Row justify="space-between">
            <StatCell label="总记录" value={`${stats.total}`} />
            <StatCell label="去过的店" value={`${stats.storeCount}`} c={color.primary[500]} />
            <StatCell label="本月" value={`${stats.monthCount}`} c={color.warning[500]} />
          </Row>
          <Divider style={{ marginVertical: spacing.base }} />
          <Row justify="space-between">
            <Col flex={1}>
              <Txt variant="caption" c={color.text.secondary}>点得最多的店</Txt>
              <Txt variant="title" weight="semibold" style={{ marginTop: 2 }} numberOfLines={1}>
                {stats.topStores[0] ? `${stats.topStores[0].storeName}` : '还没有记录'}
              </Txt>
            </Col>
            {stats.topStores[0] ? (
              <Badge
                text={`${stats.topStores[0].count} 次`}
                fg={color.primary[600]}
                bg={color.primary[50]}
              />
            ) : null}
          </Row>
          {stats.lastOrderAt ? (
            <Txt variant="caption" c={color.text.tertiary} style={{ marginTop: spacing.sm }}>
              最近一次：{formatRelative(stats.lastOrderAt)}
            </Txt>
          ) : null}
        </Card>
      </Section>

      {/* ---------- 店铺排行（核心） ---------- */}
      <Section title="店铺排行" actionLabel={showAdd ? '取消' : '+ 记一笔'} onAction={() => setShowAdd((v) => !v)}>
        {showAdd ? (
          <Card style={{ marginBottom: spacing.md }}>
            {/*
              ── 粘贴识别（最快的一条路）──
              从外卖 App 复制订单文本 → 这里自动抽平台/店铺/金额 →
              填进下面的输入框让你核对。比手打快得多，iOS 上更是唯一可行的方式。
            */}
            <Button label="📋 从剪贴板粘贴识别" variant="secondary" onPress={() => void pasteAndParse()} />
            <Spacer h={spacing.sm} />
            <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
              {'先在外卖 App 里复制订单信息，再点上面这个按钮。\n'}
              {'识别结果会填到下面，核对无误再点「记一笔」。'}
            </Txt>

            {pastePreview ? (
              <>
                <Spacer h={spacing.md} />
                <View
                  style={{
                    backgroundColor: color.primary[50],
                    borderRadius: radius.sm,
                    padding: spacing.md,
                  }}
                >
                  <Txt variant="caption" c={color.primary[600]} style={{ lineHeight: 18 }}>
                    {pastePreview}
                  </Txt>
                  <Pressable onPress={() => setPastePreview(null)} hitSlop={8} style={{ marginTop: 6 }}>
                    <Txt variant="caption" c={color.text.tertiary}>
                      收起
                    </Txt>
                  </Pressable>
                </View>
              </>
            ) : null}

            <Spacer h={spacing.md} />
            <Divider />
            <Spacer h={spacing.md} />

            <Txt variant="body2" c={color.text.secondary} style={{ marginBottom: spacing.md }}>
              也可以手动填
            </Txt>
            <Row gap={spacing.sm} style={{ flexWrap: 'wrap', marginBottom: spacing.md }}>
              {(Object.keys(PLATFORM_META) as DeliveryPlatform[]).map((p) => (
                <Pressable
                  key={p}
                  onPress={() => setPlatform(p)}
                  style={{
                    paddingHorizontal: spacing.md,
                    paddingVertical: 6,
                    borderRadius: radius.full,
                    borderWidth: 1,
                    borderColor: platform === p ? PLATFORM_META[p].color : color.neutral[200],
                    backgroundColor: platform === p ? PLATFORM_META[p].color : color.background.primary,
                  }}
                >
                  <Txt variant="caption" c={platform === p ? color.text.inverse : color.text.secondary}>
                    {PLATFORM_META[p].label}
                  </Txt>
                </Pressable>
              ))}
            </Row>
            <Field label="店铺名" value={storeName} onChangeText={setStoreName} placeholder="例如 麦当劳(松山湖店)" />
            {suggestions.length > 0 ? (
              <Row gap={spacing.sm} style={{ flexWrap: 'wrap', marginBottom: spacing.md }}>
                {suggestions.map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => setStoreName(s)}
                    style={{
                      paddingHorizontal: spacing.md,
                      paddingVertical: 5,
                      borderRadius: radius.full,
                      backgroundColor: color.neutral[100],
                    }}
                  >
                    <Txt variant="caption" c={color.text.secondary}>{s}</Txt>
                  </Pressable>
                ))}
              </Row>
            ) : null}
            <Field label="金额（可选）" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="例如 32.5" />
            <Button label="保存这一笔" onPress={submitManual} disabled={!storeName.trim()} />
          </Card>
        ) : null}

        {stats.topStores.length === 0 ? (
          <Card>
            <EmptyState
              title="还没有外卖记录"
              hint="开启自动记录后，点外卖会自动记下来；也可以手动记一笔"
            />
          </Card>
        ) : (
          <Card style={{ padding: 0 }}>
            {stats.topStores.slice(0, 15).map((s, i) => {
              const max = stats.topStores[0].count || 1;
              const ratio = s.count / max;
              return (
                <View key={s.storeName}>
                  <Row justify="space-between" style={{ paddingHorizontal: spacing.base, paddingVertical: spacing.md }} gap={spacing.md}>
                    <Row style={{ flex: 1 }} gap={spacing.md}>
                      <View style={{
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: i < 3 ? color.primary[500] : color.neutral[200],
                      }}>
                        <Txt variant="small" c={i < 3 ? color.text.inverse : color.text.secondary}>{i + 1}</Txt>
                      </View>
                      <Col flex={1} gap={4}>
                        <Txt variant="body" weight="medium" numberOfLines={1}>{s.storeName}</Txt>
                        <View style={{ height: 4, borderRadius: 2, backgroundColor: color.neutral[100], overflow: 'hidden' }}>
                          <View style={{ height: 4, borderRadius: 2, backgroundColor: color.primary[400], width: `${Math.max(6, ratio * 100)}%` }} />
                        </View>
                        <Txt variant="caption" c={color.text.tertiary}>
                          {s.platforms.map((p) => PLATFORM_META[p].label).join(' / ')} · 最近 {formatDate(s.lastAt)}
                          {s.totalAmount > 0 ? ` · 共 ¥${s.totalAmount.toFixed(1)}` : ''}
                        </Txt>
                      </Col>
                    </Row>
                    <Col align="flex-end" gap={2}>
                      <Txt variant="h3" weight="bold" c={color.primary[500]}>{s.count}</Txt>
                      <Txt variant="small" c={color.text.tertiary}>次</Txt>
                    </Col>
                  </Row>
                  {i < Math.min(stats.topStores.length, 15) - 1 ? <Divider /> : null}
                </View>
              );
            })}
          </Card>
        )}
      </Section>

      {/* ---------- 记录列表 ---------- */}
      <Section title={`最近记录（${orders.length}）`}>
        {recent.length === 0 ? (
          <Card><EmptyState title="暂无记录" /></Card>
        ) : (
          <Card style={{ padding: 0 }}>
            {recent.map((o, i) => (
              <View key={o.id}>
                <OrderRow order={o} onDelete={() => actions.deleteOrder(o.id)} />
                {i < recent.length - 1 ? <Divider /> : null}
              </View>
            ))}
          </Card>
        )}
      </Section>

      {/* ---------- 待确认 ---------- */}
      {uncertain.length > 0 ? (
        <Section title={`待确认（${uncertain.length}）`}>
          <Card style={{ padding: 0 }}>
            {uncertain.slice(0, 10).map((u, i) => (
              <View key={`${u.at}-${i}`}>
                <Col style={{ padding: spacing.base }} gap={spacing.sm}>
                  <Txt variant="caption" c={color.text.tertiary}>
                    {PLATFORM_META[platformOfPkg(u.pkg)]?.label ?? '其他'} · {formatDate(u.at)}
                  </Txt>
                  <Txt variant="body2">{u.title}</Txt>
                  <Txt variant="caption" c={color.text.secondary}>{u.text}</Txt>
                  <Row gap={spacing.sm}>
                    <Button
                      label="按原标题记为店铺"
                      variant="secondary"
                      onPress={() => actions.confirmUncertain(i, u.title || u.text.slice(0, 20))}
                      style={{ height: 34 }}
                    />
                    <Button label="忽略" variant="text" onPress={() => actions.dismissUncertain(i)} style={{ height: 34 }} />
                  </Row>
                </Col>
                {i < Math.min(uncertain.length, 10) - 1 ? <Divider /> : null}
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      {/* ---------- 记录方式说明 ---------- */}
      <Section title="记录方式">
        <Card>
          <Txt variant="body2" c={color.text.secondary}>
            自动记录靠读取外卖 App 的**订单通知**，只提取「店铺名 / 金额 / 订单阶段」，
            不读取你的账号、地址或聊天内容。
          </Txt>
          <Spacer h={spacing.md} />
          <Row justify="space-between">
            <Txt variant="body2" c={color.text.secondary}>通知监听</Txt>
            <Badge
              text={listening ? '已开启' : '未开启'}
              fg={listening ? color.success[500] : color.neutral[500]}
              bg={listening ? color.success[50] : color.neutral[100]}
            />
          </Row>
          <Spacer h={spacing.md} />
          <Txt variant="caption" c={color.text.tertiary}>
            提醒：各外卖 App 的通知文案会改版，解析可能偶尔出错。
            发现记错了可以在记录里删除，或用手动补录纠正。
          </Txt>
          <Spacer h={spacing.md} />
          <Row gap={spacing.sm}>
            <Button
              label={listening ? '关闭并清空授权提示' : '开启自动记录'}
              variant="secondary"
              onPress={() => (listening ? actions.setListening(false) : void handleEnable())}
              style={{ flex: 1 }}
            />
          </Row>
        </Card>
      </Section>
    </Col>
  );
}

// ---------------- 子组件 ----------------

function StatCell({ label, value, c }: { label: string; value: string; c?: string }) {
  return (
    <Col align="center" gap={4}>
      <Txt variant="h2" weight="bold" c={c ?? color.text.primary}>{value}</Txt>
      <Txt variant="caption" c={color.text.secondary}>{label}</Txt>
    </Col>
  );
}

function OrderRow({ order, onDelete }: { order: DeliveryOrder; onDelete: () => void }) {
  const meta = PLATFORM_META[order.platform];
  return (
    <Pressable
      onLongPress={() =>
        Alert.alert('删除这条记录', `${order.storeName}`, [
          { text: '取消', style: 'cancel' },
          { text: '删除', style: 'destructive', onPress: onDelete },
        ])
      }
    >
      <Row justify="space-between" style={{ paddingHorizontal: spacing.base, paddingVertical: spacing.md }} gap={spacing.md}>
        <Row style={{ flex: 1 }} gap={spacing.md}>
          <View style={{ width: 4, height: 34, borderRadius: 2, backgroundColor: meta.color }} />
          <Col flex={1} gap={2}>
            <Txt variant="body" weight="medium" numberOfLines={1}>{order.storeName}</Txt>
            <Row gap={spacing.sm}>
              <Txt variant="caption" c={color.text.tertiary}>{meta.label}</Txt>
              <Txt variant="caption" c={color.text.tertiary}>·</Txt>
              <Txt variant="caption" c={color.text.tertiary}>{formatDate(order.at)}</Txt>
              {order.source === 'manual' ? (
                <Txt variant="caption" c={color.warning[600]}>· 手动</Txt>
              ) : null}
            </Row>
          </Col>
        </Row>
        <Col align="flex-end" gap={2}>
          <Badge
            text={STAGE_LABEL[order.stage]}
            fg={stageColor(order.stage)}
            bg={`${stageColor(order.stage)}1A`}
          />
          {order.amount !== undefined ? (
            <Txt variant="caption" c={color.text.secondary}>¥{order.amount}</Txt>
          ) : null}
        </Col>
      </Row>
    </Pressable>
  );
}

function stageColor(stage: DeliveryStage): string {
  switch (stage) {
    case 'cancelled': return color.error[500];
    case 'done': return color.success[500];
    case 'delivering': return color.primary[500];
    case 'paid': return color.warning[600];
    default: return color.neutral[500];
  }
}

function platformOfPkg(pkg: string): DeliveryPlatform {
  for (const [key, meta] of Object.entries(PLATFORM_META) as Array<[DeliveryPlatform, typeof PLATFORM_META[DeliveryPlatform]]>) {
    if (meta.pkg.some((p) => pkg.startsWith(p))) return key;
  }
  return 'other';
}

function formatDate(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

function formatRelative(at: number): string {
  const diff = Date.now() - at;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return formatDate(at);
}
