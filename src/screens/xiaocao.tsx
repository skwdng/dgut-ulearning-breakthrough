/**
 * 「小操作」页 —— 优学院下面的二级入口。
 *
 * ══════════════ ★ 层级（用户 2026-10 明确要求）══════════════
 *
 *   「小操作类与任务查询同级，都归于优学院类，
 *     然后使用授权码才能使用小操作功能，
 *     小操作功能里面包含上面说的三个功能」
 *
 *   ┌─ 优学院（底部页）──────────────┐
 *   │  ┌────────────────────────┐  │
 *   │  │ 📋 任务查询             │  │  ← 不需要授权
 *   │  └────────────────────────┘  │
 *   │  ┌────────────────────────┐  │
 *   │  │ 🎛 小操作    [需授权]    │  │  ← ★ 授权码门槛在这一层
 *   │  └────────────────────────┘  │
 *   └──────────────────────────────┘
 *                    ↓ 点进来
 *   ┌─ 小操作 ──────────────────────┐
 *   │  ✓ 签到                       │
 *   │  ± 加减分        （开发中）    │
 *   │  ⊘ 点不中        （开发中）    │
 *   └──────────────────────────────┘
 *
 * ══════════════ ★★ 授权门槛放在哪 —— 这是个关键决定 ══════════════
 *
 * 「用授权码才能用小操作」有两种实现方式，我选了**页面级**：
 *
 *   ① 模块级（`youxue.requiresLicense = true`）—— ❌ 不行
 *      因为 `requiresLicense` 是**整模块**生效的
 *      （见 domain/modules.ts 的 computeModuleRuntime），
 *      挂上去会把「任务查询」也一起拦住。
 *      而任务查询本来就该能用 —— 用户会话过期时正是靠它去重新登录。
 *
 *   ② **页面级**（本文件套 `<LicensedScreen>`）—— ✅ 采用
 *      `LicensedScreen` 读的是 `useUnlock().entitled`（授权码机制）。
 *
 *      ⚠️ 早先它读的是 `useLicense().licensed` —— 那是**另一套**（远程名单），
 *         而本项目没有名单接口、也没配名单地址，所以那个值**永远是 false**，
 *         表现就是「暂时无法校验 / 不可用」，**有授权码也用不了**。
 *         已改成授权码那套。详见 components/LicensedScreen.tsx 的注释。
 *
 * ══════════════ 两个功能的状态（2026-10 更新）══════════════
 *
 * **「点不中」已实装** ✅
 *   接口路径实测确认，且**效果验证过**：删掉自己后，选人名单从 10 人变 9 人。
 *   页面在 `/dianbuzhong`，只走 `/apps/selectperson/*`，**不碰考勤**。
 *
 * **「加减分」还是开发中** ⚠️
 *   需要「给分」接口的请求体字段（前端调用点所在的懒加载 chunk 没抓到）。
 *   卡片保留但标「开发中」且不可点 —— 比"等做好再放出来"更好：
 *   用户能看到规划，也知道还没好，不会以为是自己没找到入口。
 */
import React from 'react';
import { Pressable, View } from 'react-native';
import { Badge, Card, Col, Row, ScreenScroll, Section, Txt } from '../components';
import { LicensedScreen } from '../components/LicensedScreen';
import { color, radius, spacing } from '../theme/tokens';
import { useRouter } from '../nav/router';
import { useUnlock } from '../state/unlockStore';

export function XiaoCaoScreen() {
  return (
    <LicensedScreen>
      <XiaoCaoInner />
    </LicensedScreen>
  );
}

function XiaoCaoInner() {
  const router = useRouter();
  const { entitled } = useUnlock();

  return (
    <ScreenScroll>
      <Section title="操作" style={{ marginTop: spacing.md }}>
        <Card style={{ padding: 0 }}>
          {/*
            ★ 这里指向 `/sign-qr`（签到记录列表），**不是** `/checkin`。
            ⚠️ 踩过的坑：原来指向 `/checkin`，而那是「自动签到设置页」
               （开关 / 策略 / 单日上限 / 立即检测）——
               用户点「签到」看到的是设置页，找不到改状态和接口探测，
               于是报「找不到接口检测按钮」。
               那个页面现在也按用户要求整个删掉了。
          */}
          <OpRow
            glyph="✓"
            tint="#10B981"
            label="签到记录"
            subLabel={
              entitled
                ? '列出优学院发起过的签到，逐条改状态'
                : '未开通 —— 点进去填授权码'
            }
            badge={entitled ? undefined : { text: '需授权', fg: color.warning[600], bg: color.warning[50] }}
            onPress={() => router.push('/sign-qr')}
          />
        </Card>
      </Section>

      {/* ---------- 课堂互动：加减分（开发中）/ 点不中（已实装） ---------- */}
      <Section title="课堂互动">
        <Card style={{ padding: 0 }}>
          <OpRow
            glyph="±"
            tint="#6366F1"
            label="加减分"
            subLabel="选人活动里被点到时，改自己的分数"
            badge={{ text: '开发中', fg: color.neutral[500], bg: color.neutral[100] }}
            disabled
          />
          <View style={{ height: 1, backgroundColor: color.neutral[100] }} />
          <OpRow
            glyph="⊘"
            tint="#EF4444"
            label="点不中"
            subLabel="老师发起选人时，把自己从名单里剔除"
            onPress={() => router.push('/dianbuzhong')}
          />
        </Card>
      </Section>

      {/*
        ⚠️ 这里原来挂着一块横幅：「『加减分』『点不中』为什么还没好」。
        但**点不中已经实装**（2026-10，实测确认：删掉自己后选人名单 10 → 9 人），
        横幅就过期了 —— 留着会让用户以为两个都还没做。
        现在只剩「加减分」还在开发中，而它的卡片上本来就有「开发中」标记，
        所以这块横幅**整块删掉**，界面也更整洁。
      */}

      {/*
        ══════════════ ★★★ 这里原来还有两张卡片：崩溃日志 / 接口测试器 ══════════════
        用户要求（2026-10）：
          「帮我把小操作里的接口测试器和崩溃日志还有签到功能里的接口测试删掉」

        → 两个入口**连同页面**一起删掉（见 src/nav/screens.tsx 的说明）。

        ⚠️ 注意：**底层的崩溃记录功能没有删** ——
           `src/services/crashLog.ts` 的 `logFault()` 仍被 9 个模块调用
           （启动计时、错误边界、登录、签到、任务、更新…），
           崩了照样写进磁盘。只是**不在界面上给入口**了。
           需要排查时用 /diagnostics（诊断信息）。
      */}
    </ScreenScroll>
  );
}

/** 一行操作入口（和设置页的 SettingRow 视觉一致，但支持 tint 图标与徽标） */
function OpRow({
  glyph,
  tint,
  label,
  subLabel,
  badge,
  onPress,
  disabled,
}: {
  glyph: string;
  tint: string;
  label: string;
  subLabel: string;
  badge?: { text: string; fg: string; bg: string };
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={{ padding: spacing.base, opacity: disabled ? 0.55 : 1 }}
    >
      <Row gap={spacing.md} align="center">
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: radius.md,
            backgroundColor: `${tint}1A`,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Txt variant="title" c={tint}>
            {glyph}
          </Txt>
        </View>
        <Col flex={1} gap={2}>
          <Row gap={spacing.sm} align="center">
            <Txt variant="body" weight="medium">
              {label}
            </Txt>
            {badge ? <Badge text={badge.text} fg={badge.fg} bg={badge.bg} /> : null}
          </Row>
          <Txt variant="caption" c={color.text.tertiary}>
            {subLabel}
          </Txt>
        </Col>
        {disabled ? null : (
          <Txt variant="body2" c={color.text.tertiary}>
            ›
          </Txt>
        )}
      </Row>
    </Pressable>
  );
}
