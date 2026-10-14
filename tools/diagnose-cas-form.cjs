/**
 * 看手机版 CAS 登录页的**表单结构**，找出原生登录失败的真正原因。
 *
 * 上面那个诊断已经排除了一种可能：
 *   ✗ 不是"手机页面没有 pwdEncryptSalt"（有的，而且正则抠得到）
 *   ✗ 不是"正则写法不对"（两种属性顺序都能匹配）
 *
 * 那 401 错在哪？看表单本身：
 *   · 手机版 `<form>` 的 action / id 是什么？（桌面版是 id="pwdFromId"）
 *   · username 输入框的 name 是什么？（手机版可能要拼国际区号）
 *   · 有没有额外的必填隐藏字段（lt / cllt / dllt / captcha / _eventId）？
 *   · 有没有 captcha 相关的隐藏项要求？
 */
const https = require('node:https');

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 12; HarmonyOS; ALN-AL00) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

/** 桌面 UA —— 用来对比：桌面版才是"学号+密码"表单 */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const url = `https://auth.dgut.edu.cn/authserver/login?service=${encodeURIComponent(
  'https://application.dgut.edu.cn/appapi',
)}`;

function fetchHtml(ua) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': ua, Accept: 'text/html' }, timeout: 15000 }, (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, html: Buffer.concat(c).toString('utf8') }));
      })
      .on('error', (e) => resolve({ status: 0, html: '', error: e.message }));
  });
}

function dumpForm(label, r) {
  console.log('');
  console.log('─'.repeat(66));
  console.log(`  ${label}`);
  console.log('─'.repeat(66));
  if (r.error) {
    console.log('  × ' + r.error);
    return;
  }
  const html = r.html;
  console.log(`  HTTP ${r.status}  字节 ${html.length}`);
  console.log(`  form: ${(/<form[^>]*>/i.exec(html) ?? ['(无)'])[0]}`);

  const fi = html.search(/<form/i);
  const fe = html.indexOf('</form>', fi);
  const formHtml = fi >= 0 && fe > fi ? html.slice(fi, fe) : html;
  const inputs = formHtml.match(/<input[^>]*>/gi) ?? [];

  console.log('');
  console.log('  表单字段：');
  let hasPassword = false;
  for (const [n, i] of inputs.entries()) {
    const name = /name=["']([^"']*)["']/i.exec(i)?.[1] ?? '(无)';
    const id = /id=["']([^"']*)["']/i.exec(i)?.[1] ?? '(无)';
    const type = /type=["']([^"']*)["']/i.exec(i)?.[1] ?? '(无)';
    const ph = /placeholder=["']([^"']*)["']/i.exec(i)?.[1] ?? '';
    if (name === 'password' || id === 'password') hasPassword = true;
    console.log(
      `  ${String(n + 1).padStart(2)}. type=${type.padEnd(8)} name=${name.padEnd(18)} id=${id.padEnd(18)}` +
        (ph ? `  ph=${ph}` : ''),
    );
  }

  console.log('');
  console.log(`  ★ 有 password 字段？  ${hasPassword ? '有 ✅（可走学号+密码）' : '没有 ❌（这个页面不能密码登录）'}`);
  console.log(`  ★ 有 pwdEncryptSalt？ ${html.includes('pwdEncryptSalt') ? '有' : '没有'}`);
  console.log(`  ★ is_dynamicLogin=true？ ${/is_dynamicLogin\s*=\s*"true"/.test(html) ? '是（短信动态登录）' : '否'}`);
  console.log(`  ★ cllt 默认值： ${(/name=["']cllt["'][^>]*value=["']([^"']*)["']/i.exec(html) ?? [, '(无)'])[1]}`);
}

(async () => {
  console.log('');
  console.log('  CAS 登录页表单结构对比');
  dumpForm('手机 UA（我们 App 现在用的）', await fetchHtml(MOBILE_UA));
  dumpForm('桌面 UA（应该用这个走学号+密码）', await fetchHtml(DESKTOP_UA));

  console.log('');
  console.log('─'.repeat(66));
  console.log('  结论');
  console.log('─'.repeat(66));
  console.log('  桌面版才有 password / pwdFromId，手机版是手机号+短信验证码。');
  console.log('  所以原生登录（提交"学号+密码"）**必须用桌面 UA 取页面并提交**，');
  console.log('  否则拿到的是短信登录表单，怎么填都不可能成功。');
  console.log('');
})();
