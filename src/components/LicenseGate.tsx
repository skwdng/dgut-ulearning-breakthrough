/**
 * 「小操作」的授权码闸门。
 *
 * ══════════════ ★★★ 这里踩过一个会让功能完全用不了的坑 ★★★ ══════════════
 *
 * 原先这个闸门读的是 `useLicense().licensed` —— 那是**另一套机制**：
 * 它要从 `EXPO_PUBLIC_LICENSE_URL` 拉一个「授权名单」(LicenseManifest)，
 * 再按学号查名单里有没有你。
 *
 * 但实际上：
 *   · 这个 App 用的是**授权码**机制（`LK1-...` 那种，本地校验 + 服务端确认）
 *   · 服务端**根本没有名单接口**（server.cjs 里搜不到 manifest 相关路由）
 *   · `EXPO_PUBLIC_LICENSE_URL` 也没配
 *
 * 结果就是用户看到的：
 *   「暂时无法校验 / 名单条目：未获取 / 上次同步：从未 / 不可用」
 * ——**不管你有没有授权码，都用不了**。
 *
 * 所以现在改成读 `useUnlock()`，那才是这个项目真正在用的那套：
 *   `entitled = unlocked && serverAuth !== 'denied'`
 *     unlocked   = 本地授权码校验通过
 *     serverAuth = 服务端说"授权了 / 拒绝了 / 不知道"
 *
 * ══════════════ 用户要的行为 ══════════════
 * 「小操作跟之前的签到一样，填授权码才会显示，填完授权后小操作内所有功能都能使用」
 *
 * 也就是：
 *   · 没填码 / 码无效 → 这里只显示**填码界面**
 *   · 填对码 → 放行，小操作里三个功能都能用
 *
 * ⚠️ 没填码时**不给任何功能内容**（连"已解锁"的字样都不该透露），
 *    但**必须给填码框** —— 否则用户不知道该怎么办。
 *
 * ══════════════ 为什么授权码要在这一页而不是只藏在设置里 ══════════════
 * 用户点「小操作」时是**带着意图**来的。让他再去设置里找填码入口，
 * 多两步且容易找不到。所以就地把入口给他。
 */
import React, { useState } from 'react';
import { TextInput, Pressable, StyleSheet, View } from 'react-native';
import {
  Badge,
  Banner,
  Button,
  Card,
  Col,
  Divider,
  Row,
  ScreenScroll,
  Section,
  Spacer,
  Txt,
} from '../components';
import { color, radius, spacing } from '../theme/tokens';
import { useUnlock, unlockText } from '../state/unlockStore';
import { useCheckin } from '../state/checkinStore';

export function LicenseGate() {
  const { account } = useCheckin();
  const { unlocked, result, code, actions, serverAuth, serverAuthMessage } = useUnlock();

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [localMsg, setLocalMsg] = useState<{ ok: boolean; message: string } | null>(null);
  /**
   * ★★★ 已生效时**是否展开"更换授权码"**。
   *
   * ══════════════ 🚨 为什么要有这个（用户真实卡住，2026-10）══════════════
   *
   * 用户原话：「然后没找到哪里可以修改授权码」
   *
   * 情况：他的授权**已生效**（所以闸门放行了），但云端报
   *   「这个授权码不属于当前学号」—— 因为 App 里存着一份**已作废的旧个人码**。
   *   解决办法是"清掉重填"，可**界面上根本没有这个入口**：
   *   原来只有未生效时才渲染填码区，一生效就只剩状态展示。
   *
   * 所以：已生效时也给一个「更换授权码」按钮，点开就是同一套填码界面。
   */
  const [showChange, setShowChange] = useState(false);

  const statusMeta = result ? unlockText(result.status) : null;

  /**
   * ══════════════ ★★★ 本地过了但服务器说"没授权" ══════════════
   *
   * 用户反馈的真实场景（2026-10）：
   *   他朋友的手机显示「授权状态 已生效／可用」，
   *   但**卡在这一页出不去**，而且界面上**什么都没说**。
   *
   * 根因：原来的渲染逻辑是
   *   · `unlocked` 为 true → **不渲染填码区**（一句解释都没有）
   *   · 而 `entitled = unlocked && serverAuth !== 'denied'`
   *   · 服务器说 denied 时 → 页面被拦住，但**没有任何提示**
   *
   * ⚠️ 这正是"卡住"的观感来源：状态写着"已生效"，却又进不去，
   *    也没有输入框可以补救。
   *
   * 修法：本地过了但服务器拒绝时，**照样给出填码区 + 明确说明**，
   *      让用户有事可做（换一个服务器认的码），而不是干等。
   */
  const serverDenied = unlocked && serverAuth === 'denied';

  /**
   * 要不要渲染填码区。
   *   · 没生效 → 必须给（否则用户不知道怎么办）
   *   · 服务器拒绝 → 必须给（换一个它能认的码是唯一的自救）
   *   · 已生效 → 只在用户主动点「更换授权码」后给
   */
  const showCodeForm = !unlocked || serverDenied || showChange;

  const submit = async () => {
    const raw = input.trim();
    if (!raw) {
      setLocalMsg({ ok: false, message: '请先填写授权码' });
      return;
    }
    setBusy(true);
    setLocalMsg(null);
    try {
      const r = await actions.submit(raw);
      /**
       * ⚠️ 成功状态是 `'granted'`，**不是** `'ok'` ——
       *    见 domain/licenseCode.ts 的 CodeCheckStatus：
       *    granted / expired / mismatch / invalid / empty。
       *    （我一开始写成 'ok'，被 tsc 拦下来了。）
       */
      const ok = r.status === 'granted';
      setLocalMsg({ ok, message: r.message ?? '' });
      if (ok) setInput('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenScroll>
      <Section style={{ marginTop: spacing.md }} title="小操作需要授权码">
        <Card variant="elevated" style={{ padding: spacing.lg }}>
          <Row justify="space-between" align="center">
            <Col flex={1}>
              <Txt variant="body2" c={color.text.secondary}>
                授权状态
              </Txt>
              <Txt variant="h3" weight="bold" style={{ marginTop: 6 }}>
                {serverDenied ? '未通过' : unlocked ? '已生效' : '未生效'}
              </Txt>
            </Col>
            <Badge
              text={serverDenied ? '不可用' : unlocked ? '可用' : '不可用'}
              fg={!serverDenied && unlocked ? color.success[500] : color.error[500]}
              bg={!serverDenied && unlocked ? color.success[50] : color.error[50]}
            />
          </Row>

          <Divider style={{ marginVertical: spacing.base }} />

          <Row justify="space-between">
            <Txt variant="caption" c={color.text.secondary}>
              我的学号
            </Txt>
            <Txt variant="body2">{account?.studentId ?? '未绑定优学院账号'}</Txt>
          </Row>
        </Card>
      </Section>

      {/*
        ⚠️ 服务器说"这个学号没授权"时**必须说清楚** ——
           否则用户看到"已生效"却进不去，只会以为 App 坏了（踩过）。
      */}
      {serverDenied ? (
        <Section>
          <Banner
            tone="error"
            title="管理员没有给这个学号授权"
            message={
              (serverAuthMessage ? `${serverAuthMessage}\n\n` : '') +
              `服务器上查不到学号 ${account?.studentId ?? ''} 的授权。\n` +
              '请把你的学号发给管理员，让他生成一个和你学号对应的授权码。'
            }
          />
        </Section>
      ) : null}

      {/*
        ══════════════ ★★★ 已生效时的「更换授权码」入口 ══════════════
        用户原话：「然后没找到哪里可以修改授权码」

        原因：一生效就不渲染填码区了，界面上**根本没有改码的入口**。
        而"换一份能用的码"恰恰是解决
        「这个授权码不属于当前学号」的唯一办法。
      */}
      {unlocked && !serverDenied ? (
        <Section>
          <Card>
            <Row justify="space-between" align="center">
              <Col flex={1}>
                <Txt variant="body2">当前使用的授权码</Txt>
                <Txt variant="caption" c={color.text.tertiary} style={{ marginTop: 4 }}>
                  {code ? `…${code.slice(-8)}` : '（无）'}
                </Txt>
              </Col>
              <Button
                label={showChange ? '收起' : '更换'}
                variant="secondary"
                onPress={() => {
                  setShowChange((v) => !v);
                  setLocalMsg(null);
                }}
              />
            </Row>
            {/*
              ⚠️ 说清"什么情况下需要换" —— 否则用户不知道为什么要点它。
                 最常见的就是："改签到报『这个授权码不属于当前学号』"。
            */}
            <Spacer h={spacing.sm} />
            <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
              {'如果改签到时报「这个授权码不属于当前学号」，' +
                '说明存的那份码已经作废（管理员换过码）。\n' +
                '点「更换」重新填一份即可 —— 推荐直接填**万能码**（不绑学号、不会过期）。'}
            </Txt>
          </Card>
        </Section>
      ) : null}

      {/*
        ══════════ 填码区 ══════════
        ⚠️ 没生效时**必须**给输入框。原先那版只说"把学号发给管理员"，
           而我们的机制是"管理员发码给你" —— 用户根本没地方填。
        ⚠️ 服务器拒绝时（serverDenied）**也要给** —— 他可能填的是别人的码，
           需要换一个自己的（这是唯一能自救的操作）。
        ⚠️ 已生效时，用户点了「更换」也要给（见上面的 showChange）。
      */}
      {showCodeForm ? (
        <Section title={unlocked ? '更换授权码' : '填写授权码'}>
          <Card>
            <Txt variant="small" c={color.text.secondary} style={{ lineHeight: 20 }}>
              {'向管理员要一个**和你的学号对应**的授权码，粘到下面提交即可。\n'}
              {'码是一人一码的 —— 别人的码在你这里用不了。\n'}
              {'也可以直接填万能码（管理员持有，不绑学号）。'}
            </Txt>
            <Spacer h={spacing.md} />
            <TextInput
              value={input}
              onChangeText={(t) => {
                setInput(t);
                if (localMsg) setLocalMsg(null);
              }}
              placeholder="请输入授权码"
              placeholderTextColor={color.text.tertiary}
              style={styles.input}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <Spacer h={spacing.md} />
            <Button label={busy ? '校验中…' : '提交'} loading={busy} onPress={() => void submit()} />

            {localMsg ? (
              <>
                <Spacer h={spacing.md} />
                <Banner
                  tone={localMsg.ok ? 'info' : 'error'}
                  title={localMsg.ok ? '已生效' : '未通过'}
                  message={localMsg.message || (localMsg.ok ? '现在可以使用小操作了。' : '请核对后重试。')}
                />
              </>
            ) : null}

            {/* 存过无效码 → 给清除入口，避免彻底卡死（这个坑踩过） */}
            {code ? (
              <>
                <Spacer h={spacing.sm} />
                <Pressable onPress={() => void actions.clear()} style={styles.clearBtn}>
                  <Txt variant="small" c={color.text.tertiary}>
                    清除当前保存的授权码
                  </Txt>
                </Pressable>
              </>
            ) : null}
          </Card>
        </Section>
      ) : null}

      {/* 校验结果里带上这层状态（比如"服务端说未授权"） */}
      {statusMeta && !unlocked ? (
        <Section>
          <Banner tone="warning" title={statusMeta.title} message={statusMeta.hint} />
        </Section>
      ) : null}

      <Section title="怎么拿到授权码">
        <Card>
          <Col gap={spacing.sm}>
            <Step no="1" text="绑定你的优学院账号（设置 → 优学院设置）" done={!!account} />
            <Step no="2" text="把你的学号发给管理员，让他生成对应的授权码" done={false} />
            <Step no="3" text="把码粘到上面提交 —— 生效后小操作里三个功能都能用" done={false} />
          </Col>
        </Card>
      </Section>

      <Section>
        <Card>
          <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 18 }}>
            {'• 授权码只控制**小操作**（签到 / 加减分 / 点不中），任务查询不受影响。\n'}
            {'• 码里嵌了你学号的哈希，校验时会拿当前登录的学号比对。\n'}
            {'• 换账号后需要重新填一次与新学号对应的码。'}
          </Txt>
        </Card>
      </Section>
    </ScreenScroll>
  );
}

function Step({ no, text, done }: { no: string; text: string; done: boolean }) {
  return (
    <Row gap={spacing.md} align="flex-start">
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: done ? color.success[500] : color.neutral[200],
        }}
      >
        <Txt variant="small" c={done ? color.text.inverse : color.text.secondary}>
          {done ? '✓' : no}
        </Txt>
      </View>
      <Txt variant="body2" c={done ? color.text.tertiary : color.text.primary} style={{ flex: 1 }}>
        {text}
      </Txt>
    </Row>
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderColor: color.neutral[200],
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 15,
    color: color.text.primary,
    backgroundColor: color.background.primary,
  },
  clearBtn: {
    alignSelf: 'center',
    paddingVertical: spacing.sm,
  },
});
