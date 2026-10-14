// 重写设置页的「签到插件」区块。
//
// 需求：
//   - 设置页**不要展示签到插件**（没授权码的人不该知道这个 App 能签到）
//   - 授权码模块**只保留使用**，去掉"解锁/锁定"按钮
//   - 没填过码时只给一个输入框，不解释用途
const fs = require('fs');

const p = __dirname + '/src/screens/settings.tsx';
let s = fs.readFileSync(p, 'utf8');
const lines = s.split('\n');

// 定位要替换的区间：从「{/* ── 状态卡 ── */}」到「{/* ── 说明 ── */}」之前
const startIdx = lines.findIndex((l) => l.includes('状态卡'));
const endIdx = lines.findIndex((l) => l.includes('── 说明 ──'));
if (startIdx < 0 || endIdx < 0) {
  console.error('  × 找不到替换区间', { startIdx, endIdx });
  process.exit(1);
}

// 往前一行应该就是 return (<ScreenScroll> 后面
const replacement = `      {/*
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
        ── 授权码 ──
        没填过码 → 只给一个输入框，不解释用途（不暴露"签到"）
        已填过码 → 只显示状态，**没有锁定/解锁按钮**（需求如此）
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
          </Card>
        ) : (
          <Card>
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
        )}
      </Section>

`;

// startIdx 前面那行是 "{/* ── 状态卡 ── */}"，保留它之前的全部内容
const before = lines.slice(0, startIdx);
const after = lines.slice(endIdx);
s = [...before, replacement, ...after].join('\n');

fs.writeFileSync(p, s, 'utf8');
console.log('  √ 设置页签到插件区块已重写');
