/**
 * 用【环境变量传入】的凭据走一次完整的 CAS 登录 + ticket 换会话，
 * 直接判定"账号密码能不能登"。
 *
 * ══════════ 为什么需要 ══════════
 * App 里报「用户名或者密码有误」，但用户确认密码是对的 —— 双方各执一词。
 * 而 CAS 对"账号不存在"和"密码错"报的是同一句话，无法区分。
 *
 * 这个脚本把 App 的整个流程（取表单 → 加密 → 提交 → 跟 ticket → 换会话）
 * 用 Node 原样跑一遍，并打印 CAS 到底怎么回应。
 * 这样就能确定是"凭据问题"还是"App 的请求有问题"。
 *
 * ⚠️ 凭据只从环境变量读，**不写进文件、不写日志、不回显**。
 *
 * 用法（在 PowerShell 里）：
 *   $env:PROBE_SID='学号'
 *   $env:PROBE_PWD='密码'
 *   node tools/probe-cas-real-login.cjs
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const SID = process.env.PROBE_SID;
const PWD = process.env.PROBE_PWD;

if (!SID || !PWD) {
  console.log('  用法：');
  console.log("    $env:PROBE_SID='学号'");
  console.log("    $env:PROBE_PWD='密码'");
  console.log('    node tools/probe-cas-real-login.cjs');
  console.log('');
  console.log('  说明：凭据只从环境变量读取，不会被写入任何文件。');
  process.exit(2);
}

const LOGIN_URL =
  'https://auth.dgut.edu.cn/authserver/login?service=https%3A%2F%2Fapplication.dgut.edu.cn%2Fappapi%2Fcas%2Ffromcas';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CHARSET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

/** 与学校前端 encrypt.js 完全一致 */
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
  c.setAutoPadding(true);
  return Buffer.concat([c.update(plain), c.final()]).toString('base64');
}

function request(url, { method = 'GET', body, cookies = {}, followRedirects = 0 } = {}) {
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
        },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const setRaw = res.headers['set-cookie'] ?? [];
          const next = { ...cookies };
          for (const raw of setRaw) {
            const pair = raw.split(';')[0];
            const i = pair.indexOf('=');
            if (i > 0) next[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
          }
          resolve({
            status: res.statusCode,
            location: res.headers.location ?? null,
            setCookie: setRaw,
            body: Buffer.concat(chunks).toString('utf8'),
            cookies: next,
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
  for (const re of [
    new RegExp(`<input[^>]*id=["']${id}["'][^>]*value=["']([^"']*)["']`, 'i'),
    new RegExp(`<input[^>]*value=["']([^"']*)["'][^>]*id=["']${id}["']`, 'i'),
  ]) {
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
  for (const kw of [
    '用户名或者密码有误', '用户名或密码错误', '密码错误', '账号被锁定',
    '验证码错误', '该账号非常用账号',
  ]) {
    if (html.includes(kw)) return kw;
  }
  return null;
}

(async () => {
  console.log('  ══════════════════════════════════════════════════');
  console.log('   CAS 真实登录探测（凭据来自环境变量，不落盘）');
  console.log('  ══════════════════════════════════════════════════');
  console.log(`  学号：${SID.slice(0, 4)}****${SID.slice(-2)}   密码长度：${PWD.length}`);
  console.log('');

  // ① 取登录页
  const page = await request(LOGIN_URL);
  const salt = pick(page.body, 'pwdEncryptSalt');
  const execution = pick(page.body, 'execution');
  console.log(`  ① 取登录页 → ${page.status}  ${Buffer.byteLength(page.body)} 字节`);
  console.log(`     cookie=[${Object.keys(page.cookies).join(',')}]`);
  console.log(`     salt=${salt ?? '★无'}  execution=${execution ?? '★无'}`);

  if (!salt || !execution) {
    console.log('  × 拿不到表单字段，无法继续');
    process.exit(1);
  }

  // ② 加密 + 提交
  const encPw = encryptPassword(PWD, salt);
  const form = new URLSearchParams({
    username: SID,
    password: encPw,
    captcha: '',
    _eventId: 'submit',
    cllt: 'userNameLogin',
    dllt: 'generalLogin',
    lt: '',
    execution,
  }).toString();

  let r = await request(LOGIN_URL, { method: 'POST', body: form, cookies: page.cookies });
  console.log(`  ② POST 表单（${Buffer.byteLength(form)} 字节）→ ${r.status}  ${Buffer.byteLength(r.body)} 字节`);
  console.log(`     location=${r.location ?? '无'}`);
  console.log(`     setCookie=[${r.setCookie.map((c) => c.split(';')[0]).join(', ') || '无'}]`);

  const msg = casMessage(r.body);
  if (msg) console.log(`     ★ CAS 提示：${msg}`);

  // ③ 有 ticket 就跟着换会话
  if (r.location && /ticket=/i.test(r.location)) {
    console.log('');
    console.log('  ★ 拿到 ticket —— 账号密码是对的！');
    console.log('     现在跟随重定向，看能不能换到 AUTHORIZATION：');
    let url = new URL(r.location, LOGIN_URL).toString();
    let hops = 0;
    let cookies = r.cookies;
    while (hops < 6) {
      hops += 1;
      const h = await request(url, { cookies });
      cookies = h.cookies;
      console.log(`     第${hops}跳 ${new URL(url).host} → ${h.status}  ${Buffer.byteLength(h.body)} 字节`);
      const names = h.setCookie.map((c) => c.split(';')[0]);
      if (names.length) console.log(`           setCookie=[${names.join(', ')}]`);
      if (!h.location || h.status < 300 || h.status > 399) {
        console.log(`           最终 URL: ${url}`);
        break;
      }
      url = new URL(h.location, url).toString();
    }
    const auth = cookies.AUTHORIZATION ?? cookies.token;
    console.log('');
    console.log(`  ★ AUTHORIZATION = ${auth ? `有（${auth.length} 字符）` : '★ 没有'}`);
    console.log(`  ★ cookie 一览：[${Object.keys(cookies).join(', ')}]`);
    console.log('');
    console.log('  结论：账号密码正确，App 侧若失败，问题在 App 的请求细节。');
  } else {
    console.log('');
    console.log('  结论：CAS 拒绝了这次登录。');
    console.log('        由于 CAS 对"账号不存在"和"密码错"报同一句话，');
    console.log('        无法进一步区分 —— 需要拿同一个密码在浏览器里试一次对照。');
  }
})();
