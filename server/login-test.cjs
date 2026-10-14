/**
 * 交互式 CAS 登录测试 —— 密码由你自己输入，不写进任何文件。
 *
 * 用途：判定「某个学号 + 密码能不能登进学校统一认证」。
 * 背景：App 里报「用户名或者密码有误」，但密码确认是对的。
 *       CAS 对"账号不存在"和"密码错"报同一句话，无法从错误上区分，
 *       所以直接把整个流程跑一遍，看能不能拿到 ticket。
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const readline = require('node:readline');

const LOGIN_URL =
  'https://auth.dgut.edu.cn/authserver/login?service=https%3A%2F%2Fapplication.dgut.edu.cn%2Fappapi%2Fcas%2Ffromcas';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CHARSET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

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

function request(url, { method = 'GET', body, cookies = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
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
  for (const kw of ['用户名或者密码有误', '用户名或密码错误', '密码错误', '账号被锁定', '验证码错误']) {
    if (html.includes(kw)) return kw;
  }
  return null;
}

/** 隐藏输入（不回显密码） */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdin = process.stdin;
    process.stdout.write(question);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let buf = '';
    const onData = (ch) => {
      const s = ch.toString('utf8');
      if (s === '\r' || s === '\n') {
        if (stdin.isTTY) stdin.setRawMode(!!wasRaw);
        stdin.removeListener('data', onData);
        rl.close();
        process.stdout.write('\n');
        resolve(buf);
      } else if (s === '\u0003') {
        process.exit(0);
      } else if (s === '\u007f' || s === '\b') {
        buf = buf.slice(0, -1);
      } else {
        buf += s;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  console.log('');
  console.log('  ══════════════════════════════════════════════════');
  console.log('   学校统一认证 登录测试');
  console.log('  ══════════════════════════════════════════════════');
  console.log('   密码只在你本机使用，不会写入任何文件。');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const sid = await new Promise((r) => rl.question('  学号：', (a) => r(a.trim())));
  rl.close();

  const pwd = await askHidden('  密码（输入时不显示）：');

  if (!sid || !pwd) {
    console.log('  × 学号或密码为空');
    process.exit(1);
  }

  console.log('');
  console.log(`  学号：${sid.slice(0, 4)}****${sid.slice(-2)}   密码长度：${pwd.length}`);
  console.log('');

  const page = await request(LOGIN_URL);
  const salt = pick(page.body, 'pwdEncryptSalt');
  const execution = pick(page.body, 'execution');
  console.log(`  ① 取登录页 → ${page.status}  ${Buffer.byteLength(page.body)} 字节`);
  console.log(`     salt=${salt ?? '★无'}  execution=${execution ?? '★无'}`);

  if (!salt || !execution) {
    console.log('  × 拿不到表单字段');
    process.exit(1);
  }

  const encPw = encryptPassword(pwd, salt);
  const form = new URLSearchParams({
    username: sid,
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
  const msg = casMessage(r.body);
  if (msg) console.log(`     ★ CAS 提示：${msg}`);
  console.log('');

  if (r.location && /ticket=/i.test(r.location)) {
    console.log('  ══════════════════════════════════════════════════');
    console.log('   ✅ 账号密码是对的 —— 拿到了 ticket');
    console.log('  ══════════════════════════════════════════════════');
    console.log('   这说明 App 里如果登不进去，问题在 App 侧，不是密码。');
    console.log('   请把这一行截图/复制给我：');
    console.log(`   ticket 存在于重定向 URL 中（长度 ${r.location.length}）`);
  } else {
    console.log('  ══════════════════════════════════════════════════');
    console.log('   ❌ 登录被拒绝');
    console.log('  ══════════════════════════════════════════════════');
    console.log('   结论：学校服务器不接受这个"学号 + 密码"组合。');
    console.log('   → 请核对密码（大小写、是否改过、是否是别的账号的密码）。');
    console.log('   → 也可以直接用手机浏览器开这个地址试一次做对照：');
    console.log('     https://auth.dgut.edu.cn/authserver/login');
    console.log('');
    console.log(`   服务端原话：${msg ?? '(没解析到)'}`);
  }
  console.log('');
  console.log('  （按回车关闭）');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(0));
})();
