/**
 * 启动时的「有新版本」弹窗。
 *
 * ══════════════ 需求原话 ══════════════
 * 「如果有新版本那么在刚进去的时候就有弹窗检查更新，
 *   上面写如果关闭后可以去首页检查更新，首页如果需要更新加一个检查更新板块，
 *   弹窗可以关闭，以免应急」
 *
 * ══════════════ 三个设计点 ══════════════
 *
 * ① **可关闭，且关掉不丢更新**
 *    用户"应急"时最烦被挡着。关掉只是**收起这次弹窗**，
 *    首页那个「检查更新」板块照旧在 —— 他回头自己点。
 *    所以关掉按钮的文案是「以后再说」而不是「不再提示」，
 *    并且明确告诉他去哪找。
 *
 * ② **关掉记的是"版本号"，不是"关过了"**
 *    只记布尔的话，关掉 0.17 之后发 0.18 他就再也看不到弹窗了。
 *    记版本号：85 → 86 会重新弹。（见 updateStore 的 dismissedRef）
 *
 * ③ **只有自动检查才弹**
 *    手动点"检查更新"时用户已经在看那一页了，再弹个窗很莫名其妙。
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Button, Row, Spacer, Txt } from '../components';
import { color, radius, spacing } from '../theme/tokens';
import { useUpdate } from '../state/updateStore';
import { fmtSize } from '../services/updater';

export function UpdatePromptDialog() {
  const upd = useUpdate();
  const info = upd.info;
  /**
   * ★★★ 强制更新时必须**无条件**显示（不能用 promptVisible 判）。
   *
   * ⚠️ 为什么：启动那次检查更新是**延迟 6 秒**跑的（避免抢启动资源）。
   *    如果这里跟着 `promptVisible` 走，那 6 秒里弹窗还没出现，
   *    用户完全可以先进去把排查工具用一遍 —— 强制就形同虚设。
   *
   *    用户原话：「这次更新要设置为强制更新，有人要用我的诊断工具」
   *    → 所以判据改成：只要 service 说 force，且有更新信息，就**一直显示**。
   */
  const forced = upd.forceUpdate;

  if (!info) return null;
  if (!forced && !upd.promptVisible) return null;

  const size = fmtSize(info.sizeBytes);

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      /**
       * ⚠️ 安卓返回键：强制模式下**什么都不做**，否则一按返回就绕过去了。
       */
      onRequestClose={() => {
        if (!forced) upd.actions.dismissPrompt();
      }}
    >
      {/*
        ⚠️ 点背景**不关闭** —— 这是个"要不要现在更新"的选择，
        误触关掉会让人以为没提示过。要关就点明确的按钮。
        （与「改签到状态」那个弹窗不同：那个点背景关掉是合理的。）
      */}
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Txt variant="h3" weight="bold">
            {forced ? '必须更新后才能继续使用' : '有新版本可以更新'}
          </Txt>
          <Spacer h={6} />
          <Txt variant="body2" c={color.text.secondary} style={{ lineHeight: 20 }}>
            {`当前 ${upd.current.version}　→　最新 ${info.version}${size ? `（${size}）` : ''}`}
          </Txt>

          {info.note ? (
            <>
              <Spacer h={spacing.md} />
              <View style={styles.noteBox}>
                <Txt variant="caption" c={color.text.secondary} style={{ lineHeight: 18 }}>
                  {`本次更新：${info.note}`}
                </Txt>
              </View>
            </>
          ) : null}

          <Spacer h={spacing.md} />
          <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 18 }}>
            {forced
              ? '这个版本必须更新。旧版本里的排查工具已经下线，' +
                '请点下面的按钮完成更新。\n' +
                '更新会下载一个新的安装包，装的时候系统会问一次。'
              : '更新会下载一个新的安装包，装的时候系统会问一次。\n' +
                '如果现在不方便，可以点「以后再说」—— 之后在首页的「检查更新」里随时能装。'}
          </Txt>

          <Spacer h={spacing.lg} />
          {/*
            ⚠️ 强制模式下**不给"以后再说"**（用户要求关闭不掉）。
               只留一个"现在更新"，中间不留别的出口。
          */}
          <Row gap={spacing.sm}>
            {!forced ? (
              <Button
                label="以后再说"
                variant="secondary"
                onPress={() => upd.actions.dismissPrompt()}
                style={{ flex: 1 }}
              />
            ) : null}
            <Button
              label="现在更新"
              onPress={() => void upd.actions.downloadAndInstall()}
              style={{ flex: 1 }}
            />
          </Row>

          {/*
            关闭后去哪找 —— 需求明确要求写上这句。
            用一行小字而不是只靠按钮文案，避免用户点完就忘了。
            ⚠️ 强制模式不显示（关不掉，说"关闭后"会误导）。
          */}
          {!forced ? (
            <>
              <Spacer h={spacing.md} />
              <Pressable onPress={() => upd.actions.dismissPrompt()} hitSlop={8}>
                <Txt variant="caption" c={color.text.tertiary} style={{ textAlign: 'center' }}>
                  关闭后可在「首页 → 检查更新」里继续
                </Txt>
              </Pressable>
            </>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  /** 居中弹窗（不是底部面板）—— 这是个"需要你决定"的询问，居中更醒目 */
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  sheet: {
    backgroundColor: color.background.primary,
    borderRadius: radius.xl,
    padding: spacing.lg,
  },
  noteBox: {
    backgroundColor: color.neutral[100],
    borderRadius: radius.md,
    padding: spacing.md,
  },
});
