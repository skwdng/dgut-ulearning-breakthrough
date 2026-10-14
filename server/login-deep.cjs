/**
 * 交互式诊断：CAS 登录 401 时，把服务端返回的**原始页面**完整解析出来。
 *
 * ══════════ 为什么需要 ══════════
 * 用同一套代码：学号 116 能登、114 登不上。加密与表单已逐字节验证一致。
 * 这种"代码相同、账号不同、结果不同"的矛盾，只能靠看**服务端原文**来解。
 *
 * 本工具除了看错误提示，还重点检查：
 *   · 返回页面的 salt 是否**与提交时不同**（服务端可能换了 salt）
 *   · 是否有"该账号需要XX"这类附加要求
 *   · 表单字段在返回页里的值有没有变化
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const readline = require('node:readline');
const fs = require('node:fs');

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
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
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

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) =>
    rl.question(q, (a) => {
      rl.close();
      r(a.trim());
    }),
  );
}

function askHidden(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdin = process.stdin;
    process.stdout.write(q);
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
      } else if (s === '\u0003') process.exit(0);
      else if (s === '\u007f' || s === '\b') buf = buf.slice(0, -1);
      else buf += s;
    };
    stdin.on('data', onData);
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

/** 把页面里所有可见文字都抽出来（去掉 script/style） */
function visibleText(html) {
  return squeeze(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' '),
  ).trim();
}

(async () => {
  console.log('');
  console.log('  ══════════════════════════════════════════════════');
  console.log('   登录失败原因深度诊断');
  console.log('  ══════════════════════════════════════════════════');
  console.log('');

  const sid = await ask('  学号：');
  const pwd = await askHidden('  密码（输入时不显示）：');
  if (!sid || !pwd) process.exit(1);

  console.log('');
  console.log(`  学号：${sid}   密码长度：${pwd.length}`);

  // 密码逐字符分类（只显示类别，不显示字符本身）
  const kinds = [...pwd].map((ch) => {
    if (/[a-z]/.test(ch)) return 'a';
    if (/[A-Z]/.test(ch)) return 'A';
    if (/[0-9]/.test(ch)) return '0';
    const code = ch.codePointAt(0);
    if (code > 127) return '★非ASCII(' + code + ')';
    return '★符号(' + code + ')';
  });
  const shape = kinds
    .map((k) => (k === 'a' ? 'a' : k === 'A' ? 'A' : k === '0' ? '0' : k))
    .join(' ');
  console.log(`  密码构成：${shape}`);

  // ★ 重点提示：非 ASCII 与全角
  const nonAscii = [...pwd].filter((c) => c.codePointAt(0) > 127);
  const fullwidth = [...pwd].filter((c) => {
    const code = c.codePointAt(0);
    return code >= 0xff01 && code <= 0xff5e;
  });
  if (nonAscii.length) {
    console.log(`  ★ 检测到 ${nonAscii.length} 个非 ASCII 字符：`);
    for (const c of nonAscii) {
      console.log(`      码位 U+${c.codePointAt(0).toString(16).toUpperCase()}  ${JSON.stringify(c)}`);
    }
  }
  if (fullwidth.length) {
    console.log(`  ★★ 其中 ${fullwidth.length} 个是**全角字符**（中文输入法下打出来的）！`);
    console.log('     全角与半角看起来一样，但是完全不同的字符 ——');
    console.log('     浏览器里可能因为是复制粘贴所以对，手输就容易出错。');
  }
  console.log('');

  // ① 取登录页
  const page = await request(LOGIN_URL);
  const salt1 = pick(page.body, 'pwdEncryptSalt');
  const exec1 = pick(page.body, 'execution');
  console.log(`  ① 取登录页 → ${page.status}   salt=${salt1}  execution=${exec1}`);

  // ② 提交
  const rnd = (n) => Array.from({ length: n }, () => CHARSET[Math.floor(Math.random() * CHARSET.length)]).join('');
  const key = Buffer.from(salt1, 'utf8').subarray(0, 16);
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.from(rnd(16), 'utf8'));
  const encPw = Buffer.concat([c.update(Buffer.from(rnd(64) + pwd, 'utf8')), c.final()]).toString('base64');

  const form = new URLSearchParams({
    username: sid,
    password: encPw,
    captcha: '',
    _eventId: 'submit',
    cllt: 'userNameLogin',
    dllt: 'generalLogin',
    lt: '',
    execution: exec1,
  }).toString();

  const r = await request(LOGIN_URL, {
    method: 'POST',
    body: form,
    cookies: page.cookies,
    extraHeaders: { Referer: LOGIN_URL, Origin: 'https://auth.dgut.edu.cn' },
  });

  console.log(`  ② POST → ${r.status}  ${Buffer.byteLength(r.body)} 字节`);
  console.log(`     location=${r.location ?? '无'}`);
  console.log('');

  // ③ 保存原始响应，便于事后分析
  /** ⚠️ 落在脚本同级目录，不写死本机绝对路径 */
  const outFile = path.join(__dirname, `.cas-response-${Date.now()}.html`);
  try {
    fs.writeFileSync(outFile, r.body, 'utf8');
    console.log(`  ③ 原始响应已保存：${outFile}`);
  } catch {
    /* 忽略 */
  }
  console.log('');

  // ④ 返回页里的 salt 与提交时是否一致
  const salt2 = pick(r.body, 'pwdEncryptSalt');
  const exec2 = pick(r.body, 'execution');
  console.log('  ④ 返回页里的关键字段');
  console.log(`     提交用 salt = ${salt1}`);
  console.log(`     返回页 salt = ${salt2}`);
  console.log(`     ${salt1 === salt2 ? '√ 一致（服务端没换 salt）' : '★ 不一致！服务端换了 salt —— 说明会话对不上'}`);
  console.log(`     提交用 execution = ${exec1}   返回页 execution = ${exec2}`);
  console.log('');

  // ⑤ 返回页里的可见文字
  console.log('  ⑤ 返回页的可见文字（前 600 字）');
  const txt = visibleText(r.body);
  console.log('     ' + txt.slice(0, 600));
  console.log('');

  // ⑥ 抓所有 error/tip 容器
  console.log('  ⑥ 所有提示容器');
  let any = false;
  for (const re of [
    /<[^>]*id=["']?([A-Za-z]*[Ee]rror[A-Za-z]*)["']?[^>]*>([\s\S]{0,200}?)</gi,
    /<[^>]*class=["'][^"']*\b(?:error|alert|tip|msg)\b[^"']*["'][^>]*>([\s\S]{0,200}?)</gi,
  ]) {
    let m;
    while ((m = re.exec(r.body))) {
      const t = squeeze((m[2] ?? m[1]).replace(/<[^>]*>/g, ' ')).trim();
      if (t && t.length > 1 && t.length < 200) {
        console.log(`     · ${t}`);
        any = true;
      }
    }
  }
  if (!any) console.log('     (没找到提示容器)');
  console.log('');

  // ⑦ 结论
  console.log('  ══════════════════════════════════════════════════');
  if (r.location && /ticket=/i.test(r.location)) {
    console.log('   ✅ 登录成功');
  } else {
    console.log(`   ❌ 被拒（HTTP ${r.status}）`);
    if (fullwidth.length) {
      console.log('   ★★ 最可能的原因：密码里有全角字符');
      console.log('      请在**英文输入法**下重新输入密码再试。');
    } else if (nonAscii.length) {
      console.log('   ★ 密码里有非 ASCII 字符，请确认与朋友给的一致。');
    }
  }
  console.log('  ══════════════════════════════════════════════════');
  console.log('');
  console.log('  （按回车关闭）');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(0));
})();
