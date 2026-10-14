/**
 * 从文件读密码做登录测试 —— 完全绕过命令行输入。
 *
 * ══════════ 为什么需要这样 ══════════
 * 用户情况：
 *   同一套代码，浏览器能登 114（密码是微信粘贴的），
 *   命令行登不上（密码也是粘贴的）。
 *   → 说明问题出在"密码怎么进到程序里"，而不是密码本身或代码。
 *
 * cmd 窗口的粘贴很容易引入看不见的东西：
 *   · 零宽字符（U+200B/200C/200D/FEFF）—— 微信/QQ 复制时常见
 *   · 全角字符（＃％＆＋ 等，中文输入法）
 *   · 尾随空格 / 换行
 *   · 终端对某些字节的转换或截断
 *
 * 所以这里改为**从 UTF-8 文本文件读密码**：
 *   你在记事本里粘贴 → 保存 → 脚本读原文，一个字节都不动。
 *
 * 用法：
 *   1. 新建 密码.txt（记事本，另存为 UTF-8）
 *   2. 第一行写学号，第二行写密码
 *   3. 双击 用文件测登录.cmd
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SERVICE = 'https://application.dgut.edu.cn/appapi/cas/fromcas';
const LOGIN_URL = `https://auth.dgut.edu.cn/authserver/login?service=${encodeURIComponent(SERVICE)}`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CHARSET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

/** 找密码文件（支持几个常见名字） */
function findCredFile() {
  const here = __dirname;
  const names = ['credentials.txt', '凭据.txt', '密码.txt', 'login.txt'];
  for (const n of names) {
    const p = path.join(here, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

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

/** 逐字符分析：只报类别，不泄露内容 */
function analyze(s) {
  const rows = [];
  const invisible = [];
  const fullwidth = [];
  const nonAscii = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    const code = ch.codePointAt(0);
    let kind;
    if (/[a-z]/.test(ch)) kind = '小写字母';
    else if (/[A-Z]/.test(ch)) kind = '大写字母';
    else if (/[0-9]/.test(ch)) kind = '数字';
    else if (code === 0x20) {
      kind = '★空格';
      invisible.push({ i, code, what: '空格' });
    } else if (code === 0x09) {
      kind = '★制表符';
      invisible.push({ i, code, what: 'Tab' });
    } else if (code === 0x0a || code === 0x0d) {
      kind = '★换行';
      invisible.push({ i, code, what: '换行' });
    } else if (code >= 0xff01 && code <= 0xff5e) {
      kind = '★★全角符号';
      fullwidth.push({ i, code, ch });
      nonAscii.push({ i, code, ch });
    } else if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) {
      kind = '★★零宽字符';
      invisible.push({ i, code, what: '零宽 U+' + code.toString(16).toUpperCase() });
      nonAscii.push({ i, code, ch });
    } else if (code > 127) {
      kind = '★非ASCII';
      nonAscii.push({ i, code, ch });
    } else {
      kind = '符号 ' + ch;
    }
    rows.push(`     [${String(i).padStart(2)}] U+${code.toString(16).toUpperCase().padStart(4, '0')}  ${kind}`);
  }
  return { rows, invisible, fullwidth, nonAscii };
}

(async () => {
  console.log('');
  console.log('  ══════════════════════════════════════════════════');
  console.log('   从文件读密码做登录测试（绕过命令行输入）');
  console.log('  ══════════════════════════════════════════════════');
  console.log('');

  const file = findCredFile();
  if (!file) {
    console.log('  × 没找到凭据文件。');
    console.log('');
    console.log('  请在本文件夹里新建一个文本文件，命名为 credentials.txt');
    console.log('  （用记事本，编码选 UTF-8），内容两行：');
    console.log('');
    console.log('      第一行：学号');
    console.log('      第二行：密码');
    console.log('');
    console.log('  ⚠️ 密码直接粘贴进去，不要手打、不要加空格。');
    console.log('  ⚠️ 测完记得把文件删掉。');
    console.log('');
    console.log('  （按回车关闭）');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(0));
    return;
  }

  console.log(`  凭据文件：${file}`);
  const rawBytes = fs.readFileSync(file);
  console.log(`  文件大小：${rawBytes.length} 字节`);

  // BOM 检测
  const hasBOM = rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf;
  console.log(`  BOM：${hasBOM ? '有（UTF-8 BOM）' : '无'}`);

  let text = rawBytes.toString('utf8');
  if (hasBOM) text = text.slice(1);

  // 分行：第一行学号，其余全部作为密码（密码里可能有换行？不太可能，取第二行）
  const lines = text.split(/\r?\n/);
  const sid = (lines[0] ?? '').trim();
  // ⚠️ 密码**不做 trim** —— 前导/尾随空格可能就是密码的一部分
  const pwd = lines[1] ?? '';

  console.log(`  学号：${sid}`);
  console.log(`  密码：长度 ${pwd.length}，字节 ${Buffer.byteLength(pwd, 'utf8')}`);
  console.log('');

  // ★ 逐字符分析
  const a = analyze(pwd);
  console.log('  ── 密码逐字符分析（只看类别，不显示内容）──');
  for (const r of a.rows) console.log(r);
  console.log('');

  if (a.fullwidth.length) {
    console.log(`  ★★ 发现 ${a.fullwidth.length} 个**全角字符**！`);
    for (const f of a.fullwidth) {
      console.log(`       位置 ${f.i}  U+${f.code.toString(16).toUpperCase()}  ${f.ch}`);
    }
    console.log('     全角与半角看起来一样但编码不同 —— 多半就是它。');
    console.log('');
  }
  if (a.invisible.length) {
    console.log(`  ★★ 发现 ${a.invisible.length} 个**看不见的字符**！`);
    for (const v of a.invisible) console.log(`       位置 ${v.i}  ${v.what}`);
    console.log('     微信/QQ 复制经常带这些，会让密码"看起来一样但实际不同"。');
    console.log('');
  }
  if (!a.fullwidth.length && !a.invisible.length && !a.nonAscii.length) {
    console.log('  √ 密码只由 ASCII 可见字符组成，没有隐藏字符。');
    console.log('');
  }

  if (!sid || !pwd) {
    console.log('  × 学号或密码为空（文件第一行学号、第二行密码）');
    console.log('');
    console.log('  （按回车关闭）');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(0));
    return;
  }

  // 开始登录
  const page = await request(LOGIN_URL);
  const salt = pick(page.body, 'pwdEncryptSalt');
  const execution = pick(page.body, 'execution');
  console.log(`  ① 取登录页 → ${page.status}   salt=${salt}  execution=${execution}`);

  const rnd = (n) => Array.from({ length: n }, () => CHARSET[Math.floor(Math.random() * CHARSET.length)]).join('');
  const key = Buffer.from(salt, 'utf8').subarray(0, 16);
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
    execution,
  }).toString();

  const r = await request(LOGIN_URL, {
    method: 'POST',
    body: form,
    cookies: page.cookies,
    extraHeaders: { Referer: LOGIN_URL, Origin: 'https://auth.dgut.edu.cn' },
  });

  console.log(`  ② POST → ${r.status}  ${Buffer.byteLength(r.body)} 字节`);
  console.log('');

  console.log('  ══════════════════════════════════════════════════');
  if (r.location && /ticket=/i.test(r.location)) {
    console.log('   ✅ 成功 —— 拿到 ticket');
    console.log('      说明密码是对的，而且这套请求完全正确。');
    console.log('      → App 里如果用同样的密码登不上，就是 App 的输入环节问题。');
  } else {
    console.log(`   ❌ 被拒（HTTP ${r.status}）`);
    if (a.fullwidth.length || a.invisible.length) {
      console.log('   → 上面标出的 ★★ 字符就是原因。');
      console.log('     请把密码在**英文输入法**下重新打一遍，或让朋友发纯文本。');
    } else {
      console.log('   → 密码本身不含隐藏字符，但服务端仍拒绝。');
      console.log('     请确认这个密码就是浏览器里能登的那个。');
    }
  }
  console.log('  ══════════════════════════════════════════════════');
  console.log('');
  console.log('  ⚠️ 测完请删除 credentials.txt（里面是明文密码）');
  console.log('');
  console.log('  （按回车关闭）');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(0));
})();
