/**
 * 专属 AI —— 只有一个聊天框。
 *
 * 需求：不要别的，就留一个对话框给用户和 AI 聊天。
 * 所以这里刻意不堆任何"生活档案""统计""画像"之类的东西。
 *
 * 现状（如实告知）：
 *   还**没有接入真实模型**。界面先做好，输入会显示在对话里。
 *   接模型只需要把 send() 里那句回复换成一次 API 调用。
 */
import React, { useCallback, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { Txt } from '../components';
import { color, radius, spacing } from '../theme/tokens';
import type { TabScreenProps } from '../nav/tabs';

interface Msg {
  id: string;
  role: 'user' | 'ai';
  text: string;
}

const WELCOME: Msg = {
  id: 'welcome',
  role: 'ai',
  text: '你好，我是你的专属 AI。想聊什么都可以。',
};

export function AiScreen(_props: TabScreenProps) {
  const [msgs, setMsgs] = useState<Msg[]>([WELCOME]);
  const [input, setInput] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    setMsgs((prev) => [
      ...prev,
      { id: `u${Date.now()}`, role: 'user', text },
      {
        id: `a${Date.now()}`,
        role: 'ai',
        text: '收到。不过我现在还没有接入模型，暂时没法真的回答 —— 接入后这里就会显示回复。',
      },
    ]);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
  }, [input]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* 对话区 */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.base, gap: spacing.md }}
        keyboardShouldPersistTaps="handled"
      >
        {msgs.map((m) => (
          <View
            key={m.id}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '86%',
              backgroundColor: m.role === 'user' ? color.primary[500] : color.background.primary,
              borderRadius: radius.lg,
              paddingHorizontal: spacing.base,
              paddingVertical: spacing.md,
              borderWidth: m.role === 'user' ? 0 : 1,
              borderColor: color.neutral[200],
            }}
          >
            <Txt
              variant="body2"
              c={m.role === 'user' ? color.text.inverse : color.text.primary}
              style={{ lineHeight: 21 }}
            >
              {m.text}
            </Txt>
          </View>
        ))}
      </ScrollView>

      {/* 输入区 */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: spacing.sm,
          padding: spacing.md,
          backgroundColor: color.background.primary,
          borderTopWidth: 1,
          borderTopColor: color.neutral[200],
        }}
      >
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="说点什么…"
          placeholderTextColor={color.neutral[400]}
          multiline
          style={{
            flex: 1,
            maxHeight: 120,
            minHeight: 40,
            borderWidth: 1,
            borderColor: color.neutral[200],
            borderRadius: radius.md,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            fontSize: 15,
            color: color.text.primary,
            backgroundColor: color.neutral[50],
          }}
        />
        <Pressable
          onPress={send}
          disabled={!input.trim()}
          style={{
            paddingHorizontal: spacing.base,
            paddingVertical: 11,
            borderRadius: radius.md,
            backgroundColor: input.trim() ? color.primary[500] : color.neutral[200],
          }}
        >
          <Txt variant="body2" weight="semibold" c={input.trim() ? color.text.inverse : color.text.tertiary}>
            发送
          </Txt>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
