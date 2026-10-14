/**
 * 由 app/(tabs)\food.tsx 迁移而来（tools/migrate-screens.cjs）。
 * 已移除 expo-router 依赖 —— 见 src/nav/router.tsx 的说明。
 */
/**
 * 点餐页 —— 顶层页面之一。
 *
 * 内容：最近的点餐记录 + 店铺统计 + 快捷记一笔。
 * 复用 DeliveryModule（通知自动抓取 + 手动记录 + 店铺排行）。
 */
import React from 'react';
import { Card, Col, Row, ScreenScroll, Section, Txt } from '../components';
import { DeliveryModule } from '../modules/DeliveryModule';
import { useDelivery } from '../state/deliveryStore';
import { color, spacing } from '../theme/tokens';
import type { TabScreenProps } from '../nav/tabs';

export function FoodScreen({ router }: TabScreenProps) {

  const delivery = useDelivery();

  const stores = delivery.stats.storeCount;
  const total = delivery.stats.total;
  const month = delivery.stats.monthCount;

  return (
    <ScreenScroll>
      {/* 概览 */}
      <Section>
        <Card variant="gradient" style={{ padding: spacing.lg }}>
          <Row justify="space-between" align="flex-start">
            <Col>
              <Txt variant="body2" c={color.text.inverse} style={{ opacity: 0.85 }}>
                点餐记录
              </Txt>
              <Txt variant="h2" weight="bold" c={color.text.inverse} style={{ marginTop: spacing.sm }}>
                {total} 笔 · {stores} 家店
              </Txt>
            </Col>
            <Txt variant="h2" c={color.text.inverse} style={{ opacity: 0.9 }}>
              🍜
            </Txt>
          </Row>
          <Row justify="space-between" style={{ marginTop: spacing.base }}>
            <Txt variant="caption" c={color.text.inverse} style={{ opacity: 0.85 }}>
              本月 {month} 笔
            </Txt>
            {delivery.uncertain.length > 0 ? (
              <Txt variant="caption" c={color.text.inverse} style={{ opacity: 0.85 }}>
                待确认 {delivery.uncertain.length} 条
              </Txt>
            ) : null}
          </Row>
        </Card>
      </Section>

      {/* 主内容 */}
      <DeliveryModule />

      {/* 说明入口 */}
      <Section>
        <Card>
          <Txt variant="body2" c={color.text.secondary}>
            通知自动抓取只支持 Android。iOS 系统不允许第三方 App 读取其他 App 的通知，
            所以只能用「+ 记一笔」手动记录。
          </Txt>
        </Card>
      </Section>
    </ScreenScroll>
  );
}
