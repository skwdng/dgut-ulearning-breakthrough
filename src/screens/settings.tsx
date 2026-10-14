/**
 * 由 app/settings.tsx 迁移而来（tools/migrate-screens.cjs）。
 * 已移除 expo-router 依赖 —— 见 src/nav/router.tsx 的说明。
 */
/**
 * 设置页 —— 首页 → 设置。
 *
 * 核心：**填写授权码解锁签到插件**。
 *
 * 授权码规则（一人一码）：
 *   - 格式 LK1-XXXXX-XXXXX-...
 *   - 码里嵌了学号哈希 → **只对本人有效**，转借他人无效
 *   - 可带有效期
 *   - 本地校验，不需要联网
 */
import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, TextInput } from 'react-native';
import {
  Badge,
  Banner,
  Button,
  Card,
  Col,
  Divider,
  Field,
  Row,
  ScreenScroll,
  Section,
  SettingRow,
  Spacer,
  Txt,
} from '../components';
import { useCheckin } from '../state/checkinStore';
import { useUnlock, unlockText } from '../state/unlockStore';
import { parseLicenseCode } from '../domain/licenseCode';
import { CODE_PREFIX } from '../domain/licenseCode';
import { color, radius, spacing } from '../theme/tokens';
import { useRouter } from '../nav/router';
import { fetchMasterCode, getServerBase, pingServer, setServerBase } from '../services/serverClient';
import { flushPendingReports, pendingCount } from '../services/reportQueue';
import { useUpdate } from '../state/updateStore';
import { fmtSize } from '../services/updater';

export function SettingsScreen() {
  const router = useRouter();
  const { account } = useCheckin();
  const { unlocked, result, code, actions } = useUnlock();

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [serverBase, setServerBase] = useState('');
  const [pingBusy, setPingBusy] = useState(false);
  const [serverMsg, setServerMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** 还有几条登录记录没上报上去（服务器没开时会积压） */
  const [pendingN, setPendingN] = useState(0);
  const [flushBusy, setFlushBusy] = useState(false);
  /** 版本与更新状态 */
  const upd = useUpdate();

  /** 启动时读已保存的服务器地址 + 待上报数量 */
  useEffect(() => {
    void (async () => {
      setServerBase(await getServerBase());
      setPendingN(await pendingCount());
    })();
  }, []);

  /** 手动补发积压的上报 */
  const retryFlush = async () => {
    setFlushBusy(true);
    try {
      const base = await getServerBase();
      if (!base) {
        setServerMsg({ ok: false, text: '还没填服务器地址，无法上报' });
        return;
      }
      const r = await flushPendingReports(base);
      setPendingN(r.remaining);
      setServerMsg({
        ok: r.remaining === 0,
        text:
          r.total === 0
            ? '没有待上报的记录'
            : r.remaining === 0
              ? `已补发 ${r.sent} 条，全部完成`
              : `补发 ${r.sent} 条，还有 ${r.remaining} 条没发出去（服务器可能还没开）`,
      });
    } finally {
      setFlushBusy(false);
    }
  };

  /** 保存服务器地址并测连通性 */
  const saveServer = async () => {
    setPingBusy(true);
    setServerMsg(null);
    try {
      await setServerBase(serverBase);
      const base = await getServerBase();
      if (!base) {
        setServerMsg({ ok: false, text: '已清空 —— 万能码将使用 App 内置的那个' });
        return;
      }
      const r = await pingServer(base);
      if (r.ok) {
        const code = await fetchMasterCode(base);
        // 连上服务器了，顺手把积压的上报补发掉 —— 这是最自然的时机
        const flush = await flushPendingReports(base);
        setPendingN(flush.remaining);
        /**
         * ⚠️ **不显示万能码**（现在服务端也不再回传明文了）。
         *
         * 设置页是**任何使用者**都能打开的地方 —— 原先这里把服务器的
         * 万能码明文打出来，等于告诉每一个装了这个 App 的人
         * （而万能码能改所有人的签到状态）。
         *
         * 现在只说明"服务器上有没有设置"，内容一律不显示。
         */
        setServerMsg({
          ok: true,
          text:
            `连接成功（端口 ${r.port ?? '?'}）` +
            (code.ok ? '　服务器上已设置万能码（内容不回传）' : `　读万能码状态失败：${code.error}`) +
            (flush.sent > 0 ? `　已补发 ${flush.sent} 条登录记录` : ''),
        });
      } else {
        setServerMsg({
          ok: false,
          text: `连不上：${r.error}。请确认电脑上的管理服务在运行、手机与电脑同一 WiFi。`,
        });
      }
    } finally {
      setPingBusy(false);
    }
  };

  /** 万能码来源（校验过后才知道） */
  const masterInfo =
    result?.masterSource === 'server'
      ? '服务器（在管理页改就能立刻生效）'
      : result?.masterSource === 'builtin'
        ? 'App 内置（服务器不可用）'
        : null;

  const submit = async () => {
    const raw = input.trim();
    if (!raw) {
      setLastResult({ ok: false, message: '请先填写授权码' });
      return;
    }
    // 万能码（LKM-）不绑学号，所以不要求先绑定账号；一人一码才要求
    const parsed = parseLicenseCode(raw);
    const isMaster = parsed.ok && parsed.info.isMaster === true;
    if (!isMaster && !account) {
      setLastResult({ ok: false, message: '一人一码要和学号比对，请先绑定优学院账号（万能码不受此限制）' });
      return;
    }
    setBusy(true);
    try {
      // submit 现在是 async —— 万能码要先问管理服务端，
      // 这样在网页上改码能立刻生效，不用重新打包。
      const r = await actions.submit(raw);
      if (r.status === 'granted') {
        setLastResult({ ok: true, message: `解锁成功：${r.message}` });
        setInput('');
      } else {
        setLastResult({ ok: false, message: r.message });
      }
    } finally {
      setBusy(false);
    }
  };

  const clearCode = () => {
    Alert.alert('锁定签到插件', '清除已保存的授权码？清除后签到插件会重新锁上。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清除',
        style: 'destructive',
        onPress: async () => {
          await actions.clear();
          setLastResult(null);
        },
      },
    ]);
  };

  const statusMeta = result ? unlockText(result.status) : null;

  return (
    <ScreenScroll>
      {/*
        ── 管理服务器 ──
        填了它之后：
          ① 万能码以**服务器上的**为准 —— 管理员在网页上改一下就生效，
             不用重新打包 App（这是加它的主要理由）
          ② 登录成功会把你登记到管理页，管理员能看到谁在用
          ③ 管理员能单独关掉某个学号的授权
        留空也能用：退化成本地校验 + App 内置的万能码。
      */}
      <Section title="管理服务器（选填）">
        <Card>
          <Txt variant="caption" c={color.text.tertiary} style={{ marginBottom: spacing.sm, lineHeight: 18 }}>
            {'这是电脑上跑的一个小后台，用来管理谁能用、以及改万能码。\n'}
            {'\n填了它：'}
            {'\n  · 万能码以电脑上的为准，管理员改完立刻生效（不用重装 App）'}
            {'\n  · 登录后会把你登记到管理页，管理员能单独关掉某人的授权'}
            {'\n\n不填也能用：万能码退回 App 内置的那个，但改码就要重新装 App。'}
          </Txt>

          <TextInput
            value={serverBase}
            onChangeText={setServerBase}
            placeholder="例如 192.168.1.5:8787 或 100.64.1.2:8787"
            placeholderTextColor={color.neutral[400]}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />

          {/*
            ── 常见地址一键填入 ──
            地址里最容易错的就是 IP 和端口，手打很烦。
            这里给几个常见形态，点一下填进输入框，再改数字即可。
          */}
          <Spacer h={spacing.sm} />
          <Row gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
            {[
              { label: '同一 WiFi', value: '192.168.1.5:8787' },
              { label: '手机热点', value: '192.168.43.6:8787' },
              { label: 'Tailscale（跨网络）', value: '100.64.1.2:8787' },
            ].map((p) => (
              <Pressable
                key={p.label}
                onPress={() => setServerBase(p.value)}
                style={{
                  paddingHorizontal: spacing.md,
                  paddingVertical: 6,
                  borderRadius: radius.full,
                  backgroundColor: color.neutral[100],
                }}
              >
                <Txt variant="caption" c={color.text.secondary}>
                  {p.label}
                </Txt>
              </Pressable>
            ))}
          </Row>
          <Txt variant="caption" c={color.text.tertiary} style={{ marginTop: 6, lineHeight: 16 }}>
            上面只是**示例格式**，点一下填进输入框后，把 IP 改成管理员给你的那个。
          </Txt>

          <Spacer h={spacing.md} />
          <Row gap={spacing.sm}>
            <Button label={pingBusy ? '测试中…' : '保存并测试'} onPress={() => void saveServer()} disabled={pingBusy} style={{ flex: 1 }} />
          </Row>

          {/*
            ── 待补发的上报 ──
            管理员是"需要的时候才开服务器"，所以服务器经常连不上。
            连不上的时候登录记录会**先存在本机**，连上后自动补发
            （见 services/reportQueue.ts）。
            这里显示积压数量并提供手动重试 —— 否则用户不知道"到底报上没报上去"。
          */}
          {pendingN > 0 ? (
            <>
              <Spacer h={spacing.md} />
              <Banner
                tone="warning"
                title={`有 ${pendingN} 条登录记录还没上报`}
                message="管理服务器之前连不上，这些记录暂存在本机。点右边的按钮现在重试。"
                actionLabel={flushBusy ? '重试中…' : '立刻重试'}
                onAction={() => void retryFlush()}
              />
            </>
          ) : null}

          {serverMsg ? (
            <>
              <Spacer h={spacing.md} />
              <Banner tone={serverMsg.ok ? 'info' : 'warning'} title={serverMsg.text} />
            </>
          ) : null}

          <Spacer h={spacing.md} />
          <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
            当前生效的万能码来源：
            {masterInfo
              ? ` ${masterInfo}`
              : ' 尚未校验过。填一次万能码即可看到来源（服务器 / 内置）。'}
          </Txt>
        </Card>
      </Section>

      {/*
        ── 功能模块 ──
        刻意**不出现"签到插件"字样**：这个功能是要隐藏的。
        没有授权码的人不该从界面上得知"这个 App 能签到"。
      */}
      <Section title="功能模块">
        <Card style={{ padding: 0 }}>
          <SettingRow
            icon="🔌"
            label="功能模块"
            subLabel="按需开启各个功能"
            onPress={() => router.push('/modules')}
          />
        </Card>
      </Section>

      {/*
        ── 版本与更新 ──

        需求：「可不可以让他们在应用内部更新」——
        以前每次改点东西都要手动传 APK、对方手动装，太累。
        现在 App 启动后会静默检查一次；这里再给一个手动入口。

        ⚠️ 手动检查时必须把"已是最新"也显示出来 ——
           否则用户点了没反应，会以为坏了。
      */}
      <Section title="版本与更新">
        <Card>
          <Row justify="space-between" align="center" gap={spacing.md}>
            <Col flex={1} gap={2}>
              <Txt variant="body2" weight="medium">
                当前版本 {upd.current.version}
              </Txt>
              <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
                {upd.phase === 'checking'
                  ? '正在检查…'
                  : upd.phase === 'available' && upd.info
                    ? `有新版本 ${upd.info.version}（${fmtSize(upd.info.sizeBytes)}）`
                    : upd.phase === 'downloading'
                      ? `下载中 ${Math.round(upd.progress * 100)}%`
                      : upd.phase === 'installing'
                        ? '已交给系统安装器'
                        : upd.phase === 'uptodate'
                          ? '已是最新版本'
                          : '有新版本时会自动提示'}
              </Txt>
            </Col>
            <Button
              label={
                upd.phase === 'available' ? '去更新' : upd.phase === 'checking' ? '检查中…' : '检查更新'
              }
              onPress={() =>
                void (upd.phase === 'available'
                  ? upd.actions.downloadAndInstall()
                  : upd.actions.check(true))
              }
              disabled={upd.phase === 'checking' || upd.phase === 'downloading'}
            />
          </Row>

          {upd.phase === 'error' && upd.error ? (
            <>
              <Spacer h={spacing.md} />
              <Banner
                tone="warning"
                title="更新失败"
                message={upd.error}
                actionLabel="知道了"
                onAction={() => upd.actions.dismiss()}
              />
            </>
          ) : null}

          <Spacer h={spacing.md} />
          <Txt variant="caption" c={color.text.tertiary} style={{ lineHeight: 17 }}>
            {'更新会下载一个新的安装包，装的时候系统会问一次。\n'}
            {'如果系统提示「不允许安装」，去「设置 → 应用 → LifeKit → 安装未知应用」打开开关再试。'}
          </Txt>
        </Card>
      </Section>

      {/*
        ── 授权码 ──

        没填过码      → 只给输入框（不解释用途，不暴露"签到"）
        **已生效**    → 只显示状态（需求：已生效后不给锁定/解锁按钮）
        **存了但没生效** → ★ 状态 + 输入框都要给

        ⚠️ 最后这条是踩过的坑：
          原先写成「只要存过码就只显示状态」，于是一旦存进一个无效的码
          （格式错、学号不符、过期），界面上既看不到输入框也没法清除 ——
          **彻底卡死**，只能卸载重装。
      */}
      <Section title="授权码">
        {code ? (
          <Card>
            <Row justify="space-between" align="center">
              <Row gap={spacing.sm} align="center">
                <Txt variant="h2">{unlocked ? '🔓' : '🔒'}</Txt>
                <Col gap={2}>
                  <Txt variant="body" weight="semibold">
                    {unlocked ? '已生效' : '未生效'}
                  </Txt>
                  <Txt variant="small" c={color.text.tertiary}>
                    {result?.message ?? '—'}
                  </Txt>
                </Col>
              </Row>
              {unlocked ? <Badge text="可用" fg={color.success[600]} bg={color.success[50]} /> : null}
            </Row>

            {/* 已生效 → 不提供任何改动入口（需求如此） */}
            {!unlocked ? (
              <>
                <Spacer h={spacing.md} />
                <Divider />
                <Spacer h={spacing.md} />
                <Txt variant="small" c={color.text.secondary} style={{ lineHeight: 18 }}>
                  当前保存的授权码没有通过校验，可以重新填写：
                </Txt>
              </>
            ) : null}
          </Card>
        ) : null}

        {/* 输入框：没存过码、或存了但没生效时都显示 */}
        {!code || !unlocked ? (
          <Card style={code ? { marginTop: spacing.md } : undefined}>
            <TextInput
              value={input}
              onChangeText={(t) => {
                setInput(t);
                if (lastResult) setLastResult(null);
              }}
              placeholder="请输入授权码"
              placeholderTextColor={color.text.tertiary}
              style={styles.input}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <Spacer h={spacing.md} />
            <Button label={busy ? '校验中…' : '提交'} loading={busy} onPress={() => void submit()} />

            {/* 存过无效码 → 给一个清除入口，避免彻底卡死 */}
            {code ? (
              <>
                <Spacer h={spacing.sm} />
                <Pressable onPress={() => void clearCode()} style={styles.clearBtn}>
                  <Txt variant="small" c={color.text.tertiary}>
                    清除当前保存的授权码
                  </Txt>
                </Pressable>
              </>
            ) : null}

            {lastResult ? (
              <>
                <Spacer h={spacing.md} />
                <Banner
                  tone={lastResult.ok ? 'info' : 'error'}
                  title={lastResult.ok ? '已生效' : '未通过'}
                  message={lastResult.message}
                />
              </>
            ) : null}
          </Card>
        ) : null}
      </Section>


      {/* ── 说明 ── */}
      <Section title="关于授权码">
        <Card>
          <Pressable onPress={() => setShowHelp((v) => !v)}>
            <Row justify="space-between" align="center">
              <Txt variant="body2" weight="medium">
                一码一人，怎么理解？
              </Txt>
              <Txt variant="body2" c={color.neutral[400]}>
                {showHelp ? '收起' : '展开'}
              </Txt>
            </Row>
          </Pressable>

          {showHelp ? (
            <>
              <Divider style={{ marginVertical: spacing.md }} />
              <Txt variant="body2" c={color.text.secondary} style={{ lineHeight: 20 }}>
                授权码里嵌了**你的学号的哈希**。校验时 App 会拿当前登录账号的学号去比对：
                {'\n\n'}
                • 码是你的 → 比对通过 → 解锁{'\n'}
                • 码是别人的 → 比对失败 → 提示「不属于当前账号」
                {'\n\n'}
                所以**把码发给别人没有用** —— 他填进去会被拒。
                {'\n\n'}
                如果你换了优学院账号，需要找管理员要新账号对应的码。
              </Txt>
            </>
          ) : null}
        </Card>
      </Section>

      {/* ── 其他设置入口 ── */}
      <Section title="其他">
        <Card style={{ padding: 0 }}>
          <SettingRow
            icon="🔌"
            label="功能模块"
            subLabel="按需开关各个插件"
            onPress={() => router.push('/modules')}
            divider
          />
          <SettingRow
            icon="🎓"
            label="优学院账号"
            subLabel={account ? `${account.studentName?.trim() || '已绑定'} · 已连接` : '未绑定'}
            onPress={() => router.push('/youxue-bind')}
            divider
          />
          <SettingRow
            icon="📜"
            label="签到日志"
            subLabel="查看历史提交记录"
            onPress={() => router.push('/checkin-log')}
            divider
          />
          {/*
            ⚠️ 这里原来还有一个「崩溃日志」入口（指向 /crash-log）。
               用户要求删掉崩溃日志 —— 入口和页面都删了。
               底层记录仍在写（crashLog.ts 的 logFault 被 9 个模块调用），
               要看就用下面的「诊断信息」。
          */}
          <SettingRow
            icon="🔍"
            label="诊断信息"
            subLabel="界面留白、账号状态、登录凭据的真实数值"
            onPress={() => router.push('/diagnostics')}
          />
          <SettingRow
            icon="🛡"
            label="授权详情"
            subLabel="旧的名单校验方式（兼容保留）"
            onPress={() => router.push('/license')}
          />
        </Card>
      </Section>

      <Section>
        <Card>
          <Txt variant="small" c={color.text.tertiary} style={{ lineHeight: 18 }}>
            说明：授权码在**本地校验**，密钥编译在 App 里。这套机制防的是「转借」与「误传」，
            不是对抗逆向。真要强防护必须上服务端校验。
          </Txt>
        </Card>
      </Section>
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderColor: color.neutral[300],
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
    letterSpacing: 0.5,
    color: color.text.primary,
    backgroundColor: color.background.primary,
  },
  /** 「清除当前保存的授权码」—— 弱化的文字按钮，避免误点 */
  clearBtn: {
    alignSelf: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
});
