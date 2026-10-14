/**
 * 由 app/modules.tsx 迁移而来（tools/migrate-screens.cjs）。
 * 已移除 expo-router 依赖 —— 见 src/nav/router.tsx 的说明。
 */
import React, { useState } from 'react';
import { Alert, Pressable, Switch, View } from 'react-native';
import {
  Badge,
  Button,
  Card,
  Divider,
  Row,
  ScreenScroll,
  Section,
  Spacer,
  Txt,
} from '../components';
import { color, radius, spacing } from '../theme/tokens';
import { PERM_LABEL, type ModuleRuntime, type PermKey } from '../domain/modules';
import { useModules } from '../state/moduleStore';

/**
 * 功能模块管理页。
 *
 * 参考「收藏 / 分类」类工具集 App 的组织方式：
 * 按类别分组 + 每项一个开关；不可用/缺权限的明确标注原因。
 */
export function ModulesScreen() {
  const { runtimes, actions, platform, granted } = useModules();
  const [busy, setBusy] = useState(false);

  // 分组：可用 / 待授权 / 不支持
  const groups: Array<{ title: string; hint: string; items: ModuleRuntime[] }> = [
    {
      title: '已启用',
      hint: '会出现在首页的模块栏',
      items: runtimes.filter((r) => r.userEnabled && r.platformSupported),
    },
    {
      title: '待授权',
      hint: '已启用但缺少系统权限，功能会受限',
      items: runtimes.filter((r) => r.userEnabled && r.platformSupported && r.missing.length > 0),
    },
    {
      title: '未启用',
      hint: '打开后会加入首页模块栏',
      items: runtimes.filter((r) => !r.userEnabled && r.platformSupported),
    },
    {
      title: `当前平台不支持（${platform}）`,
      hint: '这些模块在这台设备上无法工作，已附上原因',
      items: runtimes.filter((r) => !r.platformSupported),
    },
  ].filter((g) => g.items.length > 0);

  // "待授权" 与 "已启用" 会重叠，这里从"已启用"里剔除待授权的，避免重复展示
  const pendingKeys = new Set(groups.find((g) => g.title === '待授权')?.items.map((i) => i.def.key) ?? []);
  const firstGroup = groups.find((g) => g.title === '已启用');
  if (firstGroup) firstGroup.items = firstGroup.items.filter((i) => !pendingKeys.has(i.def.key));

  const refresh = async () => {
    setBusy(true);
    try {
      await actions.refreshPermissions();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenScroll>
      <Section style={{ marginTop: spacing.md }} title="功能模块">
        <Card>
          <Txt variant="body2" c={color.text.secondary}>
            模块可以按需开启或关闭。**不支持当前平台的模块会自动隐藏**，
            你也可以手动开启查看原因。
          </Txt>
          <Spacer h={spacing.md} />
          <Row justify="space-between">
            <Txt variant="caption" c={color.text.tertiary}>当前平台</Txt>
            <Badge text={platform} fg={color.primary[600]} bg={color.primary[50]} />
          </Row>
          <Spacer h={spacing.sm} />
          <Button
            label={busy ? '检查中…' : '从系统重新检查权限'}
            variant="secondary"
            loading={busy}
            onPress={() => void refresh()}
          />
        </Card>
      </Section>

      {groups.map((g) => (
        <Section key={g.title} title={`${g.title}（${g.items.length}）`}>
          <Txt variant="caption" c={color.text.tertiary} style={{ marginBottom: spacing.sm }}>
            {g.hint}
          </Txt>
          <Card style={{ padding: 0 }}>
            {g.items.map((r, i) => (
              <ModuleRow
                key={r.def.key}
                runtime={r}
                granted={granted}
                onToggle={(v) => (v ? actions.enable(r.def.key) : actions.disable(r.def.key))}
                onReset={() => actions.reset(r.def.key)}
                divider={i < g.items.length - 1}
              />
            ))}
          </Card>
        </Section>
      ))}

      <Section title="说明">
        <Card>
          <Txt variant="caption" c={color.text.tertiary}>
            • 「用户选择优先」：你主动开启的模块即使平台不支持也会保留显示，方便你看到原因。{'\n'}
            • 模块会声明自己需要的能力（通知/相机/定位/通知使用权），缺少时标注「待授权」而不是直接报错。{'\n'}
            • 关闭模块只是从首页隐藏，不会删除已有数据。
          </Txt>
        </Card>
      </Section>
    </ScreenScroll>
  );
}

function ModuleRow({
  runtime,
  granted,
  onToggle,
  onReset,
  divider,
}: {
  runtime: ModuleRuntime;
  granted: Partial<Record<PermKey, boolean>>;
  onToggle: (v: boolean) => void;
  onReset: () => void;
  divider: boolean;
}) {
  const { def, platformSupported, userEnabled, missing } = runtime;
  const unavailable = !platformSupported;

  return (
    <View>
      <View style={{ padding: spacing.base }}>
        {/*
          ── 模块行 ──

          ⚠️ 这里**不再用 SwitchRow**。踩过的坑：
              SwitchRow 自带 styles.settingRow（有 padding/边框），
              且内部还有一层 <Col flex={1}>。
              把它嵌进本行后，等于套了两层带样式的行 ——
              **模块的名字被挤没了**，界面上只剩一个图标和一个开关，
              用户根本不知道那一项是什么（实测如此）。

          现在直接用裸 Switch，名字与说明由本行自己排版。
        */}
        <Row justify="space-between" gap={spacing.md} align="center">
          <Row style={{ flex: 1 }} gap={spacing.md} align="center">
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: radius.md,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: unavailable ? color.neutral[100] : `${def.tint}1A`,
              }}
            >
              <Txt variant="body" c={unavailable ? color.neutral[400] : def.tint}>{def.glyph}</Txt>
            </View>

            <View style={{ flex: 1 }}>
              {/* 名字：用字号+字重体现层级，确保一眼能看懂这是哪个模块 */}
              <Txt variant="body" weight="semibold" c={unavailable ? color.text.tertiary : color.text.primary}>
                {def.label}
              </Txt>
              <Txt variant="caption" c={color.text.secondary} style={{ marginTop: 3, lineHeight: 16 }}>
                {def.summary}
              </Txt>
              {unavailable || missing.length > 0 ? (
                <View style={{ flexDirection: 'row', marginTop: 6 }}>
                  <Badge
                    text={unavailable ? '此设备不支持' : '待授权'}
                    fg={unavailable ? color.error[500] : color.warning[600]}
                    bg={unavailable ? color.error[50] : color.warning[50]}
                  />
                </View>
              ) : null}
            </View>
          </Row>

          <Switch
            value={userEnabled}
            onValueChange={onToggle}
            trackColor={{ true: color.primary[500], false: color.neutral[300] }}
            thumbColor={color.background.primary}
          />
        </Row>

        {/* 不支持的原因 */}
        {unavailable && def.fallbackHint ? (
          <View style={{ backgroundColor: color.error[50], borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.sm }}>
            <Txt variant="caption" c={color.error[600]}>{def.fallbackHint}</Txt>
          </View>
        ) : null}

        {/* 该模块需要的能力 */}
        {def.permissions.length > 0 ? (
          <Row gap={spacing.sm} style={{ flexWrap: 'wrap', marginTop: spacing.sm }}>
            {def.permissions.map((p) => {
              const ok = granted[p] === true;
              return (
                <Pressable
                  key={p}
                  onPress={() =>
                    Alert.alert(
                      PERM_LABEL[p],
                      ok ? '已授权。如需撤销，请到系统设置里关闭。' : '去 App 内对应的功能页触发授权，或在系统设置里手动开启。',
                    )
                  }
                  style={{
                    paddingHorizontal: spacing.md,
                    paddingVertical: 4,
                    borderRadius: radius.full,
                    backgroundColor: ok ? color.success[50] : color.neutral[100],
                  }}
                >
                  <Txt variant="small" c={ok ? color.success[600] : color.text.tertiary}>
                    {ok ? '✓ ' : '○ '}{PERM_LABEL[p]}
                  </Txt>
                </Pressable>
              );
            })}
          </Row>
        ) : null}

        <Row justify="space-between" style={{ marginTop: spacing.sm }}>
          <Txt variant="small" c={color.text.tertiary}>状态：{userEnabled ? '已开启' : '已关闭'}</Txt>
          <Pressable onPress={onReset} hitSlop={8}>
            <Txt variant="small" c={color.primary[500]}>恢复默认</Txt>
          </Pressable>
        </Row>
      </View>
      {divider ? <Divider /> : null}
    </View>
  );
}
