/**
 * 通用 UI 原语 —— 全部按 ui-spec.md 第 1.5 / 4 节实现。
 * 页面只组合这些原语，不自己写样式常量。
 */
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { color, font, radius, shadow, spacing, statusTheme, type CheckinStateKey } from '../theme/tokens';

// ---------------- Text ----------------

type TextVariant = keyof typeof font.size;

export function Txt({
  children,
  variant = 'body',
  weight = 'regular',
  c = color.text.primary,
  style,
  numberOfLines,
  align,
}: {
  children?: React.ReactNode;
  variant?: TextVariant;
  weight?: keyof typeof font.weight;
  c?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  align?: 'left' | 'center' | 'right';
}) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          fontSize: font.size[variant],
          color: c,
          fontWeight: font.weight[weight] as TextStyle['fontWeight'],
        },
        align ? { textAlign: align } : null,
        style,
      ]}
    >
      {children}
    </Text>
  );
}

// ---------------- Layout ----------------

export function Row({
  children,
  style,
  justify = 'flex-start',
  align = 'center',
  gap,
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  justify?: ViewStyle['justifyContent'];
  align?: ViewStyle['alignItems'];
  gap?: number;
}) {
  return (
    <View style={[{ flexDirection: 'row', justifyContent: justify, alignItems: align, gap }, style]}>
      {children}
    </View>
  );
}

export function Col({
  children,
  style,
  gap,
  align,
  flex,
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  gap?: number;
  align?: ViewStyle['alignItems'];
  flex?: number;
}) {
  return <View style={[{ flexDirection: 'column', gap, alignItems: align, flex }, style]}>{children}</View>;
}

export function Section({
  title,
  actionLabel,
  onAction,
  children,
  style,
}: {
  title?: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.section, style]}>
      {title || actionLabel ? (
        <Row justify="space-between" style={{ marginBottom: spacing.md }}>
          <Txt variant="title" weight="semibold">
            {title ?? ''}
          </Txt>
          {actionLabel ? (
            <Pressable onPress={onAction} hitSlop={8}>
              <Txt variant="body2" c={color.primary[500]}>
                {actionLabel}
              </Txt>
            </Pressable>
          ) : null}
        </Row>
      ) : null}
      {children}
    </View>
  );
}

export function Card({
  children,
  style,
  variant = 'flat',
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  variant?: 'flat' | 'elevated' | 'gradient';
}) {
  return (
    <View
      style={[
        styles.card,
        variant === 'elevated' ? shadow.md : shadow.sm,
        variant === 'gradient' ? styles.gradientCard : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, style]} />;
}

export function Spacer({ h = spacing.base }: { h?: number }) {
  return <View style={{ height: h }} />;
}

/** 竖向间距的语义化写法，等价于 Spacer */
export function Set({ h = spacing.base }: { h?: number }) {
  return <View style={{ height: h }} />;
}

// ---------------- Controls ----------------

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'text';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const isPrimary = variant === 'primary';
  const isDanger = variant === 'danger';
  const bg = isPrimary ? color.primary[500] : isDanger ? color.error[500] : 'transparent';
  const fg = isPrimary || isDanger ? color.text.inverse : color.primary[500];

  return (
    <Pressable
      onPress={disabled || loading ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'secondary' || variant === 'danger'
          ? { borderWidth: 1, borderColor: isDanger ? color.error[500] : color.primary[500] }
          : null,
        variant === 'text' ? { height: 32, paddingHorizontal: 0 } : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Txt variant="body" weight="semibold" c={fg}>
          {label}
        </Txt>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType = 'default',
  hint,
  right,
  autoFocus,
}: {
  label?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: KeyboardTypeOptions;
  hint?: string;
  right?: React.ReactNode;
  autoFocus?: boolean;
}) {
  return (
    <View style={{ marginBottom: spacing.base }}>
      {label ? (
        <Txt variant="body2" c={color.text.secondary} style={{ marginBottom: spacing.sm }}>
          {label}
        </Txt>
      ) : null}
      <Row style={styles.inputWrap} justify="space-between" gap={spacing.sm}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={color.neutral[400]}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={autoFocus}
          style={styles.input}
        />
        {right}
      </Row>
      {hint ? (
        <Txt variant="caption" c={color.text.tertiary} style={{ marginTop: spacing.xs }}>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

export function SwitchRow({
  label,
  subLabel,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  subLabel?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row justify="space-between" style={styles.settingRow}>
      <Col flex={1}>
        <Txt variant="body">{label}</Txt>
        {subLabel ? (
          <Txt variant="caption" c={color.text.tertiary} style={{ marginTop: 2 }}>
            {subLabel}
          </Txt>
        ) : null}
      </Col>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ true: color.primary[500], false: color.neutral[300] }}
        thumbColor={color.background.primary}
      />
    </Row>
  );
}

export function SettingRow({
  icon,
  iconBg = color.primary[100],
  iconColor = color.primary[500],
  label,
  subLabel,
  value,
  right,
  onPress,
  divider,
}: {
  icon?: string;
  iconBg?: string;
  iconColor?: string;
  label: string;
  subLabel?: string;
  value?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  divider?: boolean;
}) {
  const content = (
    <Row style={styles.settingRowInner} justify="space-between">
      <Row style={{ flex: 1 }} gap={spacing.md}>
        {icon ? (
          <View style={[styles.iconBox, { backgroundColor: iconBg }]}>
            <Txt variant="body2" c={iconColor}>
              {icon}
            </Txt>
          </View>
        ) : null}
        <Col flex={1}>
          <Txt variant="body">{label}</Txt>
          {subLabel ? (
            <Txt variant="caption" c={color.text.tertiary} style={{ marginTop: 2 }}>
              {subLabel}
            </Txt>
          ) : null}
        </Col>
      </Row>
      <Row gap={spacing.sm}>
        {value ? (
          <Txt variant="body2" c={color.text.tertiary}>
            {value}
          </Txt>
        ) : null}
        {right ?? (onPress ? <Txt variant="body2" c={color.neutral[400]}>›</Txt> : null)}
      </Row>
    </Row>
  );

  return (
    <View>
      {onPress ? <Pressable onPress={onPress}>{content}</Pressable> : content}
      {divider ? <Divider style={{ marginLeft: spacing.base }} /> : null}
    </View>
  );
}

export function Badge({ text, fg, bg }: { text: string; fg: string; bg: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Txt variant="caption" weight="medium" c={fg}>
        {text}
      </Txt>
    </View>
  );
}

export function StatusBadge({ state }: { state: CheckinStateKey }) {
  const theme = statusTheme[state];
  return <Badge text={theme.label} fg={theme.fg} bg={theme.bg} />;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <Col align="center" style={{ paddingVertical: spacing['3xl'] }} gap={spacing.sm}>
      <Txt variant="body" c={color.text.secondary}>
        {title}
      </Txt>
      {hint ? (
        <Txt variant="caption" c={color.text.tertiary} align="center">
          {hint}
        </Txt>
      ) : null}
    </Col>
  );
}

export function Banner({
  tone = 'warning',
  title,
  message,
  actionLabel,
  onAction,
}: {
  tone?: 'warning' | 'error' | 'info';
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const map = {
    warning: { bg: color.warning[50], fg: color.warning[600] },
    error: { bg: color.error[50], fg: color.error[600] },
    info: { bg: color.primary[50], fg: color.primary[600] },
  }[tone];

  return (
    <View style={[styles.banner, { backgroundColor: map.bg }]}>
      <Col flex={1} gap={2}>
        <Txt variant="body2" weight="semibold" c={map.fg}>
          {title}
        </Txt>
        {message ? (
          <Txt variant="caption" c={map.fg}>
            {message}
          </Txt>
        ) : null}
      </Col>
      {actionLabel ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <Txt variant="body2" weight="semibold" c={map.fg}>
            {actionLabel}
          </Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ScreenScroll({
  children,
  style,
  refreshControl,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 下拉刷新控件（可选） */
  refreshControl?: React.ReactElement;
}) {
  return (
    <ScrollView
      style={[{ flex: 1, backgroundColor: color.background.secondary }, style]}
      contentContainerStyle={{ paddingBottom: 120 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={refreshControl}
    >
      {children}
    </ScrollView>
  );
}

export const styles = StyleSheet.create({
  section: { paddingHorizontal: spacing.base, marginTop: spacing.lg },
  card: {
    backgroundColor: color.background.primary,
    borderRadius: radius.lg,
    padding: spacing.base,
  },
  gradientCard: { backgroundColor: color.primary[600] },
  divider: { height: 1, backgroundColor: color.neutral[100] },
  button: {
    height: 48,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.base,
  },
  inputWrap: {
    height: 48,
    backgroundColor: color.neutral[100],
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  input: { flex: 1, fontSize: font.size.body, color: color.text.primary, padding: 0 },
  settingRow: { minHeight: 56, paddingVertical: spacing.sm },
  settingRowInner: { minHeight: 56, paddingHorizontal: spacing.base, paddingVertical: spacing.sm },
  iconBox: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
    alignSelf: 'flex-start',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    marginHorizontal: spacing.base,
    marginTop: spacing.md,
  },
});
