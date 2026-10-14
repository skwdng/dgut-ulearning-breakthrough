/**
 * CAS 登录逐步对比（交互版）—— 学号密码自己输入，不写入任何文件。
 *
 * ══════════ 为什么需要 ══════════
 * 同一个账号：手机浏览器能登，程序登不上。
 * 已排除：加密算法（与学校 encrypt.js 逐字比对）、表单编码（0 处差异）、
 *         盐长度（都是 16 字节）、请求头、cookie 清理。
 *
 * 剩下的可能都很隐蔽，所以这个工具把**每一步的原始数据**都打出来：
 *   · 页面里表单的原始 HTML
 *   · 关键字段的真实值
 *   · 提交的字段顺序与编码后的表单
 *   · 服务端返回的原始提示
 * 这样即使失败，也能从输出里看出到底哪一步与浏览器不同。
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const readline = require('node:readline');

const SERVICE = 'https://application.dgut.edu.cn/appapi/cas/fromcas';
const LOGIN_URL = `https://auth.dgut.edu.cn/authserver/login?service=${encodeURIComponent(SERVICE)}`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CHARSET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

function request(url, { method = 'GET', body, cookies = {}, extraHeaders = {} } = {}) {
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
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(payload
            ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': payload.length }
            : {}),
          ...extraHeaders,
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

const squeeze = (s) => s.replace(/\s+/g, ' ');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(question, (a) => {
    rl.close();
    r(a.trim());
  }));
}

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
  console.log('   CAS 登录逐步对比');
  console.log('  ══════════════════════════════════════════════════');
  console.log('   密码只在本机使用，不写入任何文件，输出里只显示长度。');
  console.log('');

  const sid = await ask('  学号：');
  const pwd = await askHidden('  密码（输入时不显示）：');

  if (!sid || !pwd) {
    console.log('  × 学号或密码为空');
    process.exit(1);
  }

  const pwdHash = crypto.createHash('sha256').update(pwd).digest('hex').slice(0, 8);
  console.log('');
  console.log(`  学号：${sid}   密码长度：${pwd.length}   指纹：${pwdHash}`);
  console.log(`  密码含特殊字符：${/[^A-Za-z0-9]/.test(pwd) ? '是' : '否'}`);
  console.log('');

  // ① 取登录页
  const page = await request(LOGIN_URL);
  console.log(`  ① 取登录页 → ${page.status}  ${Buffer.byteLength(page.body)} 字节`);
  console.log(`     cookie: ${Object.entries(page.cookies).map(([k, v]) => `${k}=${v.slice(0, 10)}…`).join(', ')}`);

  // ② 表单原始字段
  const formStart = page.body.indexOf('id="pwdFromId"');
  const formEnd = page.body.indexOf('</form>', formStart);
  const inputs = [...page.body.matchAll(/<input\b[^>]*>/gi)]
    .filter((m) => (m.index ?? 0) > formStart && (m.index ?? 0) < formEnd)
    .map((m) => squeeze(m[0]));
  console.log('');
  console.log('  ② pwdFromId 表单里的 input（原始 HTML）');
  for (const i of inputs) console.log(`     ${i}`);

  const pick = (id) => {
    for (const re of [
      new RegExp(`<input[^>]*id=["']${id}["'][^>]*value=["']([^"']*)["']`, 'i'),
      new RegExp(`<input[^>]*value=["']([^"']*)["'][^>]*id=["']${id}["']`, 'i'),
    ]) {
      const m = re.exec(page.body);
      if (m) return m[1];
    }
    return null;
  };
  const salt = pick('pwdEncryptSalt');
  const execution = pick('execution');
  console.log('');
  console.log(`  ③ salt=${JSON.stringify(salt)}（${salt ? salt.length : 0}字符） execution=${JSON.stringify(execution)}`);

  if (!salt || !execution) {
    console.log('  × 拿不到关键字段');
    process.exit(1);
  }

  // ④ 加密
  const rnd = (n) => Array.from({ length: n }, () => CHARSET[Math.floor(Math.random() * CHARSET.length)]).join('');
  const ivStr = rnd(16);
  const prefix = rnd(64);
  const key = Buffer.from(salt, 'utf8').subarray(0, 16);
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.from(ivStr, 'utf8'));
  const encPw = Buffer.concat([c.update(Buffer.from(prefix + pwd, 'utf8')), c.final()]).toString('base64');
  console.log(`  ④ 加密完成，密文 ${encPw.length} 字符`);

  // ⑤ 提交
  const fields = {
    username: sid,
    password: encPw,
    captcha: '',
    _eventId: 'submit',
    cllt: 'userNameLogin',
    dllt: 'generalLogin',
    lt: '',
    execution,
  };
  const form = new URLSearchParams(fields).toString();

  const r = await request(LOGIN_URL, {
    method: 'POST',
    body: form,
    cookies: page.cookies,
    extraHeaders: {
      Referer: LOGIN_URL,
      Origin: 'https://auth.dgut.edu.cn',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    },
  });

  console.log(`  ⑤ POST → ${r.status}  ${Buffer.byteLength(r.body)} 字节`);
  console.log(`     location=${r.location ?? '无'}`);
  console.log(`     setCookie=${r.setCookie.map((x) => x.split(';')[0]).join(', ') || '无'}`);

  // ⑥ 提示
  const msgRe = [
    /<[^>]*id=["']?showErrorTipSpan["']?[^>]*>([\s\S]{0,200}?)</i,
    /<[^>]*id=["']?showErrorTip["']?[^>]*>([\s\S]{0,300}?)</i,
  ];
  const msgs = [];
  for (const re of msgRe) {
    const m = re.exec(r.body);
    if (m) {
      const txt = squeeze(m[1].replace(/<[^>]*>/g, ' ')).trim();
      if (txt) msgs.push(txt.slice(0, 140));
    }
  }
  console.log('');
  if (msgs.length) for (const m of msgs) console.log(`     ★ CAS 提示：${m}`);
  console.log('');

  console.log('  ══════════════════════════════════════════════════');
  if (r.location && /ticket=/i.test(r.location)) {
    console.log('   ✅ 成功 —— 拿到 ticket');
  } else {
    console.log('   ❌ 被拒');
    console.log('      请把上面 ①②③⑤ 的输出完整截图发我。');
    console.log(`      （密文长度 ${encPw.length}、表单 ${Buffer.byteLength(form)} 字节、`);
    console.log(`        HTTP ${r.status}、返回 ${Buffer.byteLength(r.body)} 字节）`);
  }
  console.log('  ══════════════════════════════════════════════════');
  console.log('');
  console.log('  （按回车关闭）');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(0));
})();
