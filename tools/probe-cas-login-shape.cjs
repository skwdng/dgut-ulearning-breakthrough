/**
 * 用**假密码**完整走一遍 CAS 登录流程，观察服务端的反应。
 *
 * ══════════ 目的 ══════════
 * 用户报告：用自己的账号能登，用朋友的 114 登录时
 * CAS 回「您提供的用户名或者密码有误」，但密码确认是对的。
 *
 * 需要判定的是：
 *   · 如果"假密码"和"真密码"得到的错误**完全一样**，
 *     说明服务端把"解密失败 / 参数不对"也统一报成"密码有误" ——
 *     那 App 的加密/表单仍有问题。
 *   · 如果假密码被拒但真密码能通（用户端验证），
 *     说明 App 侧没问题，是那个账号的凭据问题。
 *
 * ⚠️ 本脚本只用**明显的假密码**，不涉及任何真实凭据。
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const LOGIN_URL =
  'https://auth.dgut.edu.cn/authserver/login?service=https%3A%2F%2Fapplication.dgut.edu.cn%2Fappapi%2Fcas%2Ffromcas';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CHARSET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

/** 与服务端前端 encrypt.js 完全一致的加密 */
function encryptPassword(password, salt) {
  const rnd = (n) => {
    let s = '';
    for (let i = 0; i < n; i += 1) s += CHARSET[Math.floor(Math.random() * CHARSET.length)];
    return s;
  };
  const key = Buffer.from(salt, 'utf8').subarray(0, 16);
  const iv = Buffer.from(rnd(16), 'utf8');
  const plain = Buffer.from(rnd(64) + password, 'utf8');
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(true); // PKCS7
  return Buffer.concat([c.update(plain), c.final()]).toString('base64');
}

/** 带 cookie 罐的请求 */
function request(url, { method = 'GET', body, cookies = {}, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const payload = body ? Buffer.from(body, 'utf8') : null;

    const req = lib.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(payload
            ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': payload.length }
            : {}),
          ...headers,
        },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          // 收集 Set-Cookie
          const setRaw = res.headers['set-cookie'] ?? [];
          const newCookies = { ...cookies };
          for (const raw of setRaw) {
            const pair = raw.split(';')[0];
            const i = pair.indexOf('=');
            if (i > 0) newCookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
          }
          resolve({
            status: res.statusCode,
            location: res.headers.location ?? null,
            setCookie: setRaw,
            body: Buffer.concat(chunks).toString('utf8'),
            cookies: newCookies,
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function pick(html, id) {
  const pats = [
    new RegExp(`<input[^>]*id=["']${id}["'][^>]*value=["']([^"']*)["']`, 'i'),
    new RegExp(`<input[^>]*value=["']([^"']*)["'][^>]*id=["']${id}["']`, 'i'),
  ];
  for (const re of pats) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return null;
}

function casMessage(html) {
  for (const key of ['showErrorTipSpan', 'showErrorTip', 'errorMsg', 'formErrorTip']) {
    const re = new RegExp(`<[^>]*id=["']?${key}["']?[^>]*>([\\s\\S]{0,300}?)</`, 'i');
    const m = re.exec(html);
    if (m) {
      const t = m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (t.length >= 2) return t;
    }
  }
  for (const kw of ['用户名或者密码有误', '用户名或密码错误', '密码错误', '账号被锁定', '验证码错误']) {
    if (html.includes(kw)) return kw;
  }
  return null;
}

async function attempt(studentId, password, label) {
  console.log('─'.repeat(66));
  console.log(`  用例：${label}`);
  console.log(`  学号：${studentId}   密码：${password}`);

  // ① 取登录页（全新 cookie 罐）
  const page = await request(LOGIN_URL);
  const salt = pick(page.body, 'pwdEncryptSalt');
  const execution = pick(page.body, 'execution');
  console.log(`  ① 登录页 ${page.status}  cookie=[${Object.keys(page.cookies).join(',')}]`);
  console.log(`     salt=${salt ?? '无'}  execution=${execution ?? '无'}`);

  if (!salt || !execution) {
    console.log('  × 拿不到表单，终止');
    return null;
  }

  // ② 加密 + 提交（与 App 完全相同的字段顺序）
  const encPw = encryptPassword(password, salt);
  const form = new URLSearchParams({
    username: studentId,
    password: encPw,
    captcha: '',
    _eventId: 'submit',
    cllt: 'userNameLogin',
    dllt: 'generalLogin',
    lt: '',
    execution,
  }).toString();

  const r = await request(LOGIN_URL, { method: 'POST', body: form, cookies: page.cookies });
  console.log(`  ② POST → ${r.status}  ${Buffer.byteLength(r.body)} 字节`);
  console.log(`     location=${r.location ?? '无'}`);
  console.log(`     setCookie=[${r.setCookie.map((c) => c.split(';')[0]).join(',') || '无'}]`);

  const msg = casMessage(r.body);
  console.log(`     ★ CAS 提示：${msg ?? '(无)'}`);

  // ③ 有 ticket 就说明成功了
  if (r.location && /ticket=/i.test(r.location)) {
    console.log('     ★ 拿到 ticket —— 登录成功');
  }
  console.log('');
  return { status: r.status, location: r.location, msg };
}

(async () => {
  console.log('  用假密码探测 CAS 的响应模式');
  console.log('  ⚠️ 只用明显的假密码，不涉及真实凭据');
  console.log('');

  const results = [];

  // 用例 1：学号明显不存在
  results.push(await attempt('1000000000000', 'definitely-wrong-password-xyz', '不存在的学号 + 假密码'));

  // 用例 2：用一个真实格式的学号 + 假密码（不碰用户真实账号）
  results.push(await attempt('2099000009999', 'definitely-wrong-password-xyz', '不存在的学号（真实格式）+ 假密码'));

  console.log('═'.repeat(66));
  console.log('  结论');
  console.log('═'.repeat(66));
  const msgs = results.map((r) => (r ? r.msg : null));
  const same = msgs[0] === msgs[1];
  console.log(`  两个用例的 CAS 提示：${JSON.stringify(msgs)}`);
  console.log(
    same
      ? '  → 提示一致。说明服务端对"账号不存在"和"密码错"报同一句话，\n' +
          '     所以 App 侧看到的"用户名或者密码有误"无法区分这两者。'
      : '  → 提示不同。可以据此区分失败原因。',
  );
  console.log('');
  console.log('  下一步判断：如果用户用**浏览器**能登录那个账号，');
  console.log('  则证明账号密码没问题 → 问题在 App 侧，需要继续查。');
})();
