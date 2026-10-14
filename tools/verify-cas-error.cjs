/**
 * 测试「从 CAS 返回的 HTML 里抽错误提示」的逻辑。
 *
 * ══════════ 为什么必须测 ══════════
 * 用户登录 POST 返回 401，CAS 把登录页（约 19KB）+ 错误提示一起返回。
 * 之前的诊断只有状态码和字节数，**看不到失败原因**，只能猜。
 * 补上 extractCasMessage 后，如果它的正则有偏差，
 * 下次登录失败时屏幕上还是什么都没有 —— 等于白加。
 *
 * 这个脚本复刻 Kotlin 里的正则，用真实的 CAS 页面片段（已从线上抓到）验证。
 */
const path = require('path');
const fs = require('fs');

const KT = path.resolve(__dirname, '..', 'android-native', 'WebCookieModule.kt');
const kt = fs.readFileSync(KT, 'utf8');

let pass = 0;
let fail = 0;
const t = (n, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  √ ${n}`);
  } else {
    fail += 1;
    console.log(`  × ${n}${extra ? '  → ' + extra : ''}`);
  }
};

// ── 1) Kotlin 里确实用了原始字符串且没有非法转义 ──
console.log('=== 1) Kotlin 源码层面的正确性 ===');
{
  t('extractCasMessage 存在', kt.includes('private fun extractCasMessage'));
  t('cleanMessage 存在', kt.includes('private fun cleanMessage'));
  t('正则用原始字符串（""")', /"""<\[\^>\]\*id=/.test(kt));
  // 普通字符串里不得出现单反斜杠 + s/S/b/d/w
  const lines = kt.split('\n');
  const bad = [];
  lines.forEach((l, i) => {
    const rawOpen = l.indexOf('"""');
    let from = 0;
    for (const seg of l.match(/"(?:[^"\\]|\\.)*"/g) || []) {
      const at = l.indexOf(seg, from);
      from = at + seg.length;
      if (rawOpen >= 0 && at > rawOpen) continue;
      if (/(^|[^\\])\\[sSbdw]/.test(seg)) bad.push(i + 1);
    }
  });
  t('没有非法 Kotlin 转义', bad.length === 0, bad.length ? `第 ${bad.join(',')} 行` : '');
}

// ── 2) 复刻 extractCasMessage 的算法（与 Kotlin 逐条对应）──
const ID_OR_CLASS = [
  'showErrorTipSpan', 'showErrorTip', 'errorMsg', 'formErrorTip',
  'showMsg', 'msg', 'message', 'error', 'tip',
];

function cleanMessage(raw) {
  if (raw == null || !String(raw).trim()) return null;
  const text = String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 2 || text.length > 120) return null;
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(text)) return null;
  return text;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCasMessage(html) {
  if (!html) return null;
  for (const key of ID_OR_CLASS) {
    const re = new RegExp(`<[^>]*id=["']?${escapeRe(key)}["']?[^>]*>([\\s\\S]{0,300}?)</`, 'i');
    const m = re.exec(html);
    const text = cleanMessage(m && m[1]);
    if (text != null) return text;
  }
  const reCls = /<[^>]*class=["'][^"']*\b(?:error|alert|tip|msg)[^"']*["'][^>]*>([\s\S]{0,300}?)</gi;
  let m;
  while ((m = reCls.exec(html))) {
    const text = cleanMessage(m[1]);
    if (text != null) return text;
  }
  for (const kw of ['用户名或密码错误', '密码错误', '账号被锁定', '验证码错误', '用户不存在']) {
    if (html.includes(kw)) return kw;
  }
  return null;
}

// ── 3) 用真实的 CAS 页面片段测 ──
console.log('\n=== 2) 真实 CAS 页面片段 ===');

/**
 * 该主题（dgutCusTheme23）真实的提示容器。
 * 下面这些片段来自线上页面，class / id 都是实抓的。
 */
const CASES = [
  {
    name: 'showErrorTipSpan（最常见）',
    html: '<div class="lang_text_ellipsis" style="width:100%;color: red;" id="showErrorTip"> <span id="showErrorTipSpan" style="font-size: 14px;">用户名或密码错误</span></div>',
    expect: '用户名或密码错误',
  },
  {
    name: 'errorMsg',
    html: '<div id="errorMsg" class="error">账号已被锁定，请 5 分钟后再试</div>',
    expect: '账号已被锁定，请 5 分钟后再试',
  },
  {
    name: 'class 含 error',
    html: '<p class="login-error-text">验证码错误</p>',
    expect: '验证码错误',
  },
  {
    name: 'formErrorTip',
    html: '<span id="formErrorTip">用户名不能为空</span>',
    expect: '用户名不能为空',
  },
  {
    name: '只有 JS 变量里的兜底话术',
    html: '<script>var msg = "用户名或密码错误";</script>',
    expect: '用户名或密码错误',
  },
  {
    name: '无提示（正常登录页）',
    html: '<form id="pwdFromId"><input id="pwdEncryptSalt" value="BnhYefygRM2SVxFP"></form>',
    expect: null,
  },
  {
    name: '空 HTML',
    html: '',
    expect: null,
  },
];

for (const c of CASES) {
  const got = extractCasMessage(c.html);
  t(`${c.name} → ${got === null ? 'null' : `"${got}"`}`, got === c.expect, `期望 ${JSON.stringify(c.expect)}`);
}

console.log('\n=== 3) 抽取的文本要干净 ===');
{
  const got = extractCasMessage(
    '<div id="showErrorTip"><span id="showErrorTipSpan">\n  用户名或密码  错误\n  <b>!</b></span></div>',
  );
  t('去掉了内部标签', got !== null && !got.includes('<'), String(got));
  t('压掉了多余空白', got === '用户名或密码 错误 !', String(got));
}

console.log('\n=== 4) 不会把整页 HTML 当成提示 ===');
{
  const huge = `<div id="showErrorTip">${'很长的内容'.repeat(200)}</div>`;
  const got = extractCasMessage(huge);
  t('超长内容被丢弃（不刷屏）', got === null, String(got).slice(0, 60));
}

console.log('\n=== 5) 真实登录页不会误报 ===');
{
  // 线上实抓的登录页里，那几个 id 的默认内容是空的
  const realPage = `
    <div class="lang_text_ellipsis" style="width:100%;color: red;display: none;" id="showFidoErrorTip">
      <span id="showFidoErrorTipSpan" style="font-size: 14px;"></span>
    </div>
    <input type="hidden" id="pwdEncryptSalt" value="BnhYefygRM2SVxFP" />
    <input type="hidden" id="execution" name="execution" value="e1s1" />
  `;
  const got = extractCasMessage(realPage);
  t('未登录时的页面不产生假提示', got === null, String(got));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
