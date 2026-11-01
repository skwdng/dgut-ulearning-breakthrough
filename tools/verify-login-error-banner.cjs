/**
 * 「登录页打不开时能说出原因」的回归测试。
 *
 * ══════════════ 为什么需要这个测试 ══════════════
 *
 * 用户报「登录页打不开」时，原来界面上**什么提示都没有** ——
 * WebView 加载失败只留一片白屏，用户只能以为 App 坏了，
 * 反馈时也说不清是没网、域名解析失败，还是站点选错。
 *
 * 现在补了失败横幅：地址 + 原因（`net::ERR_*` 或 HTTP 状态码）
 * + 两个自救按钮（重试 / 用浏览器打开）。
 *
 * ⚠️ 这个测试同时钉住两个相反方向，两边都容易回退：
 *   1. **失败时必须说清原因** —— 丢了这条就回到"白屏没提示"；
 *   2. **不能为了诊断把已删的手动工具栏加回来** ——
 *      用户明确要求登录页只留登录口，
 *      「读取并保存会话 / 测试登录链路 / 完整追踪」都已删除。
 *      回归时顺手复活那些按钮，是最容易发生、也最违背需求的一种回退。
 *
 * 用法: node tools/verify-login-error-banner.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOGIN = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'youxue-web-login.tsx'), 'utf8');

/** 剥掉注释，只检查真正的代码 —— 注释里引用的历史证据不算功能 */
const CODE = LOGIN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  √ ${name}`);
  } else {
    fail += 1;
    console.log(`  × ${name}${extra ? '  → ' + extra : ''}`);
  }
};

console.log('=== 1) ★★ 加载失败要能说出原因（白屏曾是最大的问题）===');
{
  t(
    '★★ 有失败状态 loadErr（{ url, reason } 或 null）',
    /const \[loadErr, setLoadErr\] = useState<\{ url: string; reason: string \} \| null>\(null\)/.test(CODE),
  );
  t(
    '★★ 失败状态默认 null（加载成功时横幅完全不占空间）',
    /\[loadErr, setLoadErr\] = useState<\{ url: string; reason: string \} \| null>\(null\)/.test(CODE),
  );
  t('★★ WebView 挂了 onError', /onError=\{\(e\) => \{/.test(CODE));
  t('★★ onError 取原生 description（net::ERR_* 就在这个字段里）', /e\.nativeEvent\?\.description/.test(CODE));
  t(
    '★★ onError 把地址 + 原因写入失败状态',
    /onError=\{\(e\) => \{[\s\S]{0,500}?setLoadErr\(\{ url, reason \}\)/.test(CODE),
  );
  t('★★ WebView 挂了 onHttpError', /onHttpError=\{\(e\) => \{/.test(CODE));
  t('★★ onHttpError 取 statusCode（HTTP 4xx/5xx 也要说清）', /e\.nativeEvent\?\.statusCode/.test(CODE));
  t(
    '★★ onHttpError 也写入失败状态（不是白屏而是错误页时）',
    /onHttpError=\{\(e\) => \{[\s\S]{0,500}?setLoadErr\(\{ url, reason: `服务器返回 HTTP \$\{code\}` \}\)/.test(CODE),
  );
  t(
    '★ 原生错误与 HTTP 错误都进崩溃日志（只在用户手机上复现时能查）',
    /webLogin\.onError/.test(CODE) && /webLogin\.onHttpError/.test(CODE),
  );
  t('★ 新一次加载会清掉旧错误（重试成功后不留残影）', /onLoadStart=\{\(\) => setLoadErr\(null\)\}/.test(CODE));
}

console.log('\n=== 2) ★★ 失败横幅：标题 + 地址行 + 原因行，默认不占空间 ===');
{
  /**
   * 只截横幅那一段（从它自己的 <Banner 到自闭合）用来检查组件与文案。
   * ⚠️ 不能用正则从第一个 `<Banner` 开始找 —— 文件前面还有别处的 Banner，
   *    中间夹着的 JSX 注释里合法地写着 `**`，会把"文案含星号"误报成失败。
   */
  const titleAt = LOGIN.indexOf('title="登录页没能打开"');
  const openAt = titleAt >= 0 ? LOGIN.lastIndexOf('<Banner', titleAt) : -1;
  const closeAt = titleAt >= 0 ? LOGIN.indexOf('/>', titleAt) : -1;
  const banner = openAt >= 0 && closeAt > titleAt ? LOGIN.slice(openAt, closeAt + 2) : null;
  t('★★ 失败时显示「登录页没能打开」横幅', Boolean(banner));
  t('★★ 横幅带地址行', /`地址：\$\{loadErr\.url\}/.test(CODE));
  t('★★ 横幅带原因行', /`原因：\$\{loadErr\.reason\}/.test(CODE));
  t('★★ 横幅只在 loadErr 非空时渲染（默认零占位）', /\{loadErr \? \(/.test(CODE));
  t('★★ 复用现有 Banner 组件与 error 配色，没有另造一套 UI', Boolean(banner) && /tone="error"/.test(banner));
  t('★★ 横幅文案没有 Markdown 星号（用户看到的应是正常中文）', Boolean(banner) && !banner.includes('*'));
  t('★ 页面没有写死颜色（颜色/间距全部走 tokens）', !/#[0-9a-fA-F]{6}\b/.test(CODE));
}

console.log('\n=== 3) ★★ 两个自救按钮：重试 / 用浏览器打开 ===');
{
  t('★★ 有「重试」按钮', /label="重试"/.test(CODE));
  t('★★ 「重试」接的是 retryLoad', /<Button label="重试" onPress=\{retryLoad\}/.test(CODE));
  t('★★ retryLoad 真的重新加载 WebView', /retryLoad = useCallback\(\(\) => \{[\s\S]{0,200}?webRef\.current\?\.reload\(\)/.test(CODE));
  t(
    '★★ 重试前先清掉错误状态（横幅立刻消失，不等下一次 onLoadStart）',
    /retryLoad = useCallback\(\(\) => \{[\s\S]{0,120}?setLoadErr\(null\);[\s\S]{0,120}?reload\(\)/.test(CODE),
  );
  t('★★ 有「用浏览器打开」按钮', /label="用浏览器打开"/.test(CODE));
  t('★★ 用浏览器打开走 Linking.openURL（真的兜底，不是空按钮）', /Linking\.openURL\(tenant\.entryUrl\)/.test(CODE));
  t(
    '★★ 打开的是登录入口地址（不是失败时跳到的第三方地址）',
    /await Linking\.openURL\(tenant\.entryUrl\)/.test(CODE),
  );
  t(
    '★★ 接住了 openURL 的异常（否则点了没反应，控制台只有未处理的 Promise）',
    /try \{[\s\S]{0,200}?await Linking\.openURL\([\s\S]{0,500}?\} catch \(e\)/.test(CODE),
  );
  t(
    '★ Linking 从 react-native 官方入口引入，没新增依赖',
    /import \{[^}]*\bLinking\b[^}]*\} from 'react-native'/.test(CODE) && !/from 'expo-/.test(CODE),
  );
}

console.log('\n=== 4) ★★ 防回退：已删掉的手动工具栏不许加回来 ===');
{
  /**
   * ⚠️ 用户原话：「把读取并保存隐藏，只留下方登录口」。
   * 这些按钮/诊断文字一旦被"顺手加回来"，登录页就又变回诊断面板了。
   */
  const REMOVED = [
    ['读取并保存会话', /读取并保存会话/],
    ['测试登录链路', /测试登录链路/],
    ['完整追踪 / 开始追踪', /完整追踪|开始追踪/],
    ['Cookie 状态文字「已读到 Cookie：」', /已读到 Cookie：/],
    ['诊断结果浮层（Modal）', /<Modal\b/],
    ['诊断 state（probeOut / diag）', /setProbeOut|setDiag\b/],
    ['探查/追踪函数（runProbe / runTrace / nativeLogin / diagnoseCookieRead）', /runProbe|runTrace|nativeLogin|diagnoseCookieRead/],
    ['追踪输入框（traceId / tracePw）', /traceId|tracePw/],
  ];
  for (const [name, re] of REMOVED) t(`★★ 没有把「${name}」加回来`, !re.test(CODE));
}

console.log('\n=== 5) ★★ 原有的自动保存会话逻辑没被破坏 ===');
{
  t(
    '★★ onLoadEnd 仍会自动采集会话（harvest(true)）',
    /onLoadEnd=\{\(\) => setTimeout\(\(\) => void harvest\(true\), \d+\)\}/.test(CODE),
  );
  t('★ 采集仍然交给 bindWithSession（会话真的会被保存）', /bindWithSession\(/.test(CODE));
  t('★ onLoadStart 与 onLoadEnd 并存（新增的没顶掉自动保存）', /onLoadStart=\{/.test(CODE) && /onLoadEnd=\{/.test(CODE));
  t(
    '★ 登录成功仍显示本次学号与 userId（换账号串号的诊断线索没丢）',
    /服务端认到的 userId/.test(CODE) && /本次登录学号/.test(CODE),
  );
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
