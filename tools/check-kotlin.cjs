// Kotlin 源文件静态自检（编译前的廉价检查，能挡掉一批低级错误）
const fs = require('fs');

// ⚠️ 路径基于 __dirname 往上找：原来是写死本机绝对路径（公开仓库里不能有）
const p = require('node:path').join(__dirname, '..', 'android-native', 'WebCookieModule.kt');
const raw = fs.readFileSync(p, 'utf8');
const checks = [
  ['无 "var body:"（会遮蔽 step 的形参）', !/var\s+body\s*:/.test(raw)],
  ['有 postBody', raw.includes('postBody')],
  ['step 形参名是 s', raw.includes('fun step(s: String)')],
  ['steps.pushString(s)', raw.includes('steps.pushString(s)')],
  ['网络在后台线程', raw.includes('Thread {')],
  ['不自动跟重定向', raw.includes('instanceFollowRedirects = false')],
  ['AES 加密存在', raw.includes('AES/CBC/PKCS5Padding')],
  ['每跳都存 cookie', raw.includes('cm.setCookie(url, raw)')],
  ['无 WebStorage（编不过）', !raw.includes('import android.webkit.WebStorage')],
  ['无 keySetIterator 变量名 it', !/val\s+it\s*=/.test(raw)],
  /*
   * ══════════ CAS 报错必须能带回 App ══════════
   * 踩过的坑：登录 POST 返回 401，CAS 把登录页（约 19KB）+ 错误提示
   * 一起返回，但诊断里只有状态码和字节数 —— 只能猜"密码错还是参数漏"。
   * 必须把错误文字抽出来，否则以后每次登录失败都要重新猜一遍。
   */
  ['能从 CAS 页面抽出错误提示', raw.includes('private fun extractCasMessage')],
  ['错误文本会清洗（去标签/限长）', raw.includes('private fun cleanMessage')],
  ['每跳后打印 CAS 提示', raw.includes('CAS 提示：')],
  ['页面提示的常见容器都试过', raw.includes('showErrorTipSpan') && raw.includes('showErrorTip')],
  ['salt 按 id 匹配（该页面有 id 无 name）', raw.includes('id=[\\"\']" + Regex.escape(id)')],
  /*
   * ══════════ WebView cookie 同步 ══════════
   * 踩过的坑：WebView 里已登录（页面显示"欢迎您，XXX 学生"），
   * 但 CookieManager.getCookie() 读到 0 个 —— 两套 cookie 存储不同步。
   * 解决：页面里 JS 读 document.cookie → 回传 RN → 用 setCookie 写回 CookieManager。
   */
  ['有 setCookie 方法（写回 CookieManager）', raw.includes('fun setCookie(url: String, cookieLine: String')],
  // setCookie 会返回"是否被接受"，必须接住 —— 否则格式不对时会静默失败
  ['检查 setCookie 的返回值', /fun setCookie[\s\S]{0,900}val accepted = cm\.setCookie\(/.test(raw)],
  ['写 cookie 后 flush', /fun setCookie[\s\S]{0,900}cm\.flush\(\)/.test(raw)],
];

let braces = 0;
let parens = 0;
for (const c of raw) {
  if (c === '{') braces += 1;
  else if (c === '}') braces -= 1;
  if (c === '(') parens += 1;
  else if (c === ')') parens -= 1;
}
checks.push(['花括号平衡', braces === 0]);
checks.push(['圆括号平衡', parens === 0]);

let fail = 0;
for (const [name, ok] of checks) {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '√' : '×'} ${name}`);
}
console.log('');
console.log(`  行数 ${raw.split('\n').length}，@ReactMethod ${(raw.match(/@ReactMethod/g) || []).length} 个`);
console.log(fail === 0 ? '  ✅ 自检通过' : `  ❌ ${fail} 项不通过`);
process.exit(fail === 0 ? 0 : 1);
