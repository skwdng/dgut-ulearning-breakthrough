/**
 * 优学院账号绑定页。
 *
 * ══════════════ ⚠️ 这里**只有一条路：应用内网页登录（WebView）** ══════════════
 *
 * 为什么把"学号+密码"输入框撤掉了（2026-10 实测）：
 *
 *   原先这里是主入口：一个学号框 + 密码框，走原生提交
 *   （WebCookieModule.kt 的 nativeLogin：取页面 → 抠 pwdEncryptSalt
 *     → AES 加密 → POST 表单 → 逐跳跟票）。
 *
 *   **它从来没能成功过**，用户反馈：
 *     「在最上端的登录优学院入口进不去，我换了密码也不能从那里登，
 *       报错红色的字，只能从下面的用网页登录，别人也一样」
 *
 *   实测原因（tools/diagnose-cas-form.cjs 把两个 UA 的页面都打出来了）：
 *     学校 CAS 已经改成 **JS 动态渲染登录方式**，
 *     静态 HTML 里**根本没有 password 输入框**：
 *
 *       手机 UA → username 的提示是「请输入手机号」，
 *                还有 dynamicCode「请输入短信验证码」，cllt=dynamicLogin
 *       桌面 UA → cllt=fidoLogin，username-fido / responseJson-fido
 *                 （指纹/FIDO 登录）
 *       两个页面：**都没有 type=password 的字段**
 *
 *   所以"程序化拼表单提交密码"**原理上不可能成功** ——
 *   密码框是 JS 跑起来之后才出现的。
 *
 *   而 WebView 能成，是因为它**真的执行了页面的 JS**，
 *   走的是学校自己的前端逻辑，和我们拼表单完全无关。
 *
 * ══════════════ 结论 ══════════════
 *   把 WebView 作为**唯一且主推**的入口，别再让用户先撞一次墙。
 *   密码永远不经过 App —— 只在学校的页面里输入。
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, Col, Divider, Row, ScreenScroll, Section, Spacer, StatusBadge, Txt } from '../components';
import { color, radius, spacing } from '../theme/tokens';
import { useCheckin } from '../state/checkinStore';
import { getTenant } from '../config/tenants';
import { BUILD_CONFIG } from '../config/buildConfig';
import { getCurrentSite, saveCurrentSite } from '../config/currentSite';
import { currentAdapterKind } from '../services/checkin';
import { useRouter, useNavigation } from '../nav/router';

export function YouxueBindScreen() {
  const router = useRouter();
  const { switchTab } = useNavigation();
  const { account, courses, sessionState, actions } = useCheckin();
  const tenant = getTenant(account?.tenant ?? BUILD_CONFIG.tenant);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'error' | 'warning'; text: string } | null>(null);

  const isMock = currentAdapterKind() === 'mock';

  /**
   * 当前选中的站点（用户可能在设置/登录页之间来回切）。
   * ⚠️ 用 state 而不是直接读 `getCurrentSite()` —— 切换后要重渲染。
   */
  const [current, setCurrent] = useState(() => getCurrentSite().code);

  /**
   * ★ 选站点 → 落盘 → 打开对应登录页。
   *
   * ⚠️ 必须先 `saveCurrentSite` 再跳转：
   *    登录页的 `entryUrl`（WebView 打开哪个地址）是**按当前站点**算的，
   *    先跳转再切站点的话，WebView 已经拿着旧地址渲染了。
   */
  const pickSiteAndLogin = async (code: string) => {
    setBusy(true);
    try {
      /** 已绑定且站点不同 → 不允许直接切（否则旧账号的 token 会拿去打新站点，必然 401） */
      if (account && account.tenant !== code) {
        setMessage({
          tone: 'warning',
          text: '已绑定的账号属于另一个站点。请先在下面「解除绑定」，再登录新站点。',
        });
        return;
      }
      await saveCurrentSite(code);
      setCurrent(code);
      router.push('/youxue-web-login');
    } finally {
      setBusy(false);
    }
  };

  const doUnbind = async () => {
    setBusy(true);
    try {
      await actions.unbind();
      setMessage({ tone: 'info', text: '已解除绑定' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenScroll>
      {isMock ? (
        <Banner
          tone="info"
          title="当前是 MOCK 模式"
          message="流程可完整走通，但不会连接真实优学院。要连真实数据，把 src/config/buildConfig.ts 里的 ADAPTER 改成 youxue 后重新打包。"
        />
      ) : null}

      {/*
        ══════════ 唯一的登录入口：应用内网页登录 ══════════

        为什么这里**没有**学号/密码输入框了：
        学校的 CAS 改成 JS 动态渲染登录方式，静态页面里根本没有
        password 字段（手机版是手机号+短信，桌面版是 FIDO）——
        所以"App 里拼表单提交密码"原理上不可能成功。
        原先把它当主入口，结果**所有人都登不上**，只能往下找到网页登录。

        现在只留这条路。密码在学校自己的页面里输入，App 完全不碰。
      */}
      <Section style={{ marginTop: spacing.md }} title="登录优学院">
        <Card>
          {/*
            用户要求（2026-10）：
              「登录优学院下面这一块只留打开登录页面按钮，下面的全部删掉」

            所以这里只剩一个按钮 —— 页面说明、"绑定后能用什么"、"登录不成功？"
            整块都删了（见文件末尾的说明）。
          */}
          <Button label="打开登录页面" onPress={() => void pickSiteAndLogin(current)} />
        </Card>
      </Section>

      {/* ── 已绑定状态 ── */}
      {account ? (
        <Section style={{ marginTop: spacing.md }} title="当前账号">
          <Card variant="elevated" style={{ padding: spacing.lg }}>
            <Row gap={spacing.md} align="center">
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: radius.md,
                  backgroundColor: color.primary[100],
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Txt variant="title" c={color.primary[500]}>
                  {(account.studentName ?? '优').slice(0, 1)}
                </Txt>
              </View>
              <Col flex={1} gap={2}>
                <Txt variant="title" weight="semibold">
                  {account.studentName ?? '未填姓名'}
                </Txt>
                <Txt variant="body2" c={color.text.secondary}>
                  {maskStudentId(account.studentId)}
                </Txt>
              </Col>
              <StatusBadge state={sessionState === 'expired' ? 'expired' : 'idle'} />
            </Row>

            <Divider style={{ marginVertical: spacing.base }} />

            <Row justify="space-between">
              <Txt variant="body2" c={color.text.secondary}>
                学校
              </Txt>
              <Txt variant="body2">{account.school ?? tenant.schoolName}</Txt>
            </Row>
            <Spacer h={spacing.sm} />
            <Row justify="space-between">
              <Txt variant="body2" c={color.text.secondary}>
                已读取课程
              </Txt>
              <Txt variant="body2">{courses.length} 门</Txt>
            </Row>
            <Spacer h={spacing.sm} />
            <Row justify="space-between">
              <Txt variant="body2" c={color.text.secondary}>
                绑定时间
              </Txt>
              <Txt variant="body2">{new Date(account.boundAt).toLocaleString('zh-CN')}</Txt>
            </Row>

            <Spacer h={spacing.base} />
            <Row gap={spacing.sm}>
              {/* ⚠️ 不能用 router.push('/youxue') —— 那不是路由，是底部标签页。
                  点它会推入一个不存在的页面（白屏）。要回优学院应该切标签。 */}
              <Button label="去优学院看数据" onPress={() => switchTab('youxue')} style={{ flex: 1 }} />
              <Button
                label={busy ? '处理中…' : '解除绑定'}
                variant="secondary"
                onPress={() => void doUnbind()}
                disabled={busy}
                style={{ flex: 1 }}
              />
            </Row>
          </Card>
        </Section>
      ) : null}

      {message ? (
        <Section>
          <Banner tone={message.tone} title={message.text} actionLabel="知道了" onAction={() => setMessage(null)} />
        </Section>
      ) : null}
    </ScreenScroll>
  );
}

/** 学号打码：只留前 4 位和后 2 位，避免完整学号出现在界面上 */
function maskStudentId(sid: string): string {
  if (sid.length <= 6) return sid;
  return `${sid.slice(0, 4)}****${sid.slice(-2)}`;
}
