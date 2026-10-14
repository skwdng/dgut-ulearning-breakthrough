/**
 * 诊断：手机拿到的 CAS 登录页里，到底有没有 `pwdEncryptSalt`？
 *
 * ══════════════ 为什么必须查这个 ══════════════
 * 用户反馈：「在最上端的登录优学院入口进不去，我换了密码也不能从那里登，
 *            报错红色的字，只能从下面的用网页登录，别人也一样」
 *
 * 那条路走的是原生登录（WebCookieModule.kt 的 nativeLogin）：
 *   ① GET 登录页 → ② 从 HTML 里正则抠出 pwdEncryptSalt 与 execution
 *   → ③ AES 加密密码 → ④ 提交表单 → ⑤ 逐跳跟票拿 AUTHORIZATION
 *
 * 第 ② 步是成败关键。your earlier notes 说：
 *   「手机端拿到的 CAS 登录页是 JS 渲染的（<script src=./encrypt.js>），
 *     源码里没有 pwdEncryptSalt，App 无法程序化提交」
 *
 * 如果真是这样，那原生登录**原理上就不可能成功** ——
 * 不该把它放在主入口让所有人撞一次墙。
 *
 * 但也要排除另一种可能：页面里有 salt，只是属性顺序不常见，正则没抠到。
 * 所以直接看原文。
 *
 * 用法: node tools/diagnose-cas-page.cjs
 */
const https = require('node:https');
const http = require('node:http');

const AUTH_HOST = 'https://auth.dgut.edu.cn';
const APP_HOST = 'https://application.dgut.edu.cn';
const SERVICE = `${APP_HOST}/appapi`;

/** 模拟手机 User-Agent —— 服务器可能按 UA 返回不同页面 */
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 12; HarmonyOS; ALN-AL00) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

function fetchPage(url, ua) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      {
        headers: {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            location: res.headers.location,
            cookies: res.headers['set-cookie'] ?? [],
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message, body: '', cookies: [] }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, error: 'timeout', body: '', cookies: [] });
    });
  });
}

function report(label, r) {
  console.log('');
  console.log('─'.repeat(64));
  console.log(`  ${label}`);
  console.log('─'.repeat(64));
  if (r.error) {
    console.log(`  × 请求失败：${r.error}`);
    return;
  }
  console.log(`  HTTP ${r.status}` + (r.location ? `  → ${r.location}` : ''));
  console.log(`  cookie 数：${r.cookies.length}`);
  console.log(`  页面字节：${r.body.length}`);

  /**
   * ★ 关键检查：那几个字段在不在原文里。
   *   用宽松的字符串查找，不用正则 —— 正则本身可能是问题所在，
   *   不能拿它来验证。
   */
  const keys = ['pwdEncryptSalt', 'execution', 'encrypt.js', 'pwdFromId', 'username', 'password'];
  for (const k of keys) {
    const idx = r.body.indexOf(k);
    if (idx >= 0) {
      const around = r.body.slice(Math.max(0, idx - 60), idx + 90).replace(/\s+/g, ' ');
      console.log(`  √ 含 ${k.padEnd(15)} …${around}…`);
    } else {
      console.log(`  × 不含 ${k}`);
    }
  }

  /**
   * ★ 再按**实际用的正则**抠一次 —— 看是"页面没有"还是"正则抠不到"。
   *   这正是 nativeLogin 第②步做的事。
   */
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<input[^>]*id=["']${esc('pwdEncryptSalt')}["'][^>]*value=["']([^"']*)["']`, 'i'),
    new RegExp(`<input[^>]*value=["']([^"']*)["'][^>]*id=["']${esc('pwdEncryptSalt')}["']`, 'i'),
  ];
  let got = null;
  for (const [i, re] of patterns.entries()) {
    const m = re.exec(r.body);
    if (m && m[1]) {
      got = { pat: i + 1, val: m[1] };
      break;
    }
  }
  if (got) {
    console.log(`  ★ 正则抠到了 salt（第 ${got.pat} 种写法）：${got.val.slice(0, 12)}…`);
  } else {
    console.log('  ★ 正则**抠不到** salt');
  }

  // 有没有 <input ... id="pwdEncryptSalt" 但属性顺序异常？
  if (r.body.includes('pwdEncryptSalt')) {
    const m = /<input[^>]{0,400}pwdEncryptSalt[^>]{0,400}>/i.exec(r.body);
    if (m) console.log(`  真实 input 标签：${m[0].slice(0, 300)}`);
    else console.log('  （有 pwdEncryptSalt 字样，但没有匹配到 input 标签）');
  }
}

(async () => {
  console.log('');
  console.log('  CAS 登录页诊断 —— 手机还能不能用"学号+密码"登录');

  const url1 = `${AUTH_HOST}/authserver/login?service=${encodeURIComponent(SERVICE)}`;
  report('① 带 service 参数（手机 UA）', await fetchPage(url1, MOBILE_UA));
  report('② 不带 service 参数（手机 UA）', await fetchPage(`${AUTH_HOST}/authserver/login`, MOBILE_UA));
  report('③ 带 service 参数（桌面 UA，作对照）', await fetchPage(url1, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'));

  console.log('');
  console.log('─'.repeat(64));
  console.log('  结论怎么看');
  console.log('─'.repeat(64));
  console.log('  · 若手机 UA 下「不含 pwdEncryptSalt」→ 原生登录原理上不可能成功，');
  console.log('    应该把它从主入口拿掉，改以网页登录为主。');
  console.log('  · 若「含但正则抠不到」→ 是提取逻辑的问题，可以修好原生登录。');
  console.log('  · 若手机与桌面结果不同 → 说明服务器按 UA 返回不同页面。');
  console.log('');
})();
