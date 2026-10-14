/**
 * CAS 登录「逐步对比」工具 —— 把每一步的原始数据和网页表单并排打出来。
 *
 * ══════════ 为什么需要 ══════════
 * 同一个账号：手机浏览器能登，程序登不上。
 * 已经排除：加密算法、表单编码、盐长度、请求头、cookie 清理。
 * 剩下的可能都很隐蔽（某个字段的值、表单 action、额外参数）。
 *
 * 这个工具不去"猜"，而是把**服务端到底收到什么**逐字打出来，
 * 并把页面里表单的**原始 HTML** 一起显示，方便逐字对比。
 *
 * ⚠️ 密码从环境变量读，不写入文件；输出里密码只显示长度与 SHA-256 前 8 位。
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const SID = process.env.PROBE_SID;
const PWD = process.env.PROBE_PWD;

if (!SID || !PWD) {
  console.log('  用法：$env:PROBE_SID=...; $env:PROBE_PWD=...; node tools/probe-cas-steps.cjs');
  process.exit(2);
}

const SERVICE = 'https://application.dgut.edu.cn/appapi/cas/fromcas';
const LOGIN_URL = `https://auth.dgut.edu.cn/authserver/login?service=${encodeURIComponent(SERVICE)}`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CHARSET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

const pwdHash = crypto.createHash('sha256').update(PWD).digest('hex').slice(0, 8);

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
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
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
            headers: res.headers,
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

function extractForm(html, formId) {
  const re = new RegExp(`<form[^>]*id=["']${formId}["'][\\s\\S]*?</form>`, 'i');
  const m = re.exec(html);
  return m ? squeeze(m[0]) : null;
}

(async () => {
  console.log('  ══════════════════════════════════════════════════');
  console.log('   CAS 登录逐步对比');
  console.log('  ══════════════════════════════════════════════════');
  console.log(`  学号：${SID}   密码长度：${PWD.length}   密码SHA256前8位：${pwdHash}`);
  console.log('');

  // ══ ① 取登录页 ══
  const page = await request(LOGIN_URL);
  console.log('  ① 取登录页');
  console.log(`     URL    : ${LOGIN_URL}`);
  console.log(`     状态   : ${page.status}`);
  console.log(`     字节   : ${Buffer.byteLength(page.body)}`);
  console.log(`     cookie : ${Object.entries(page.cookies).map(([k, v]) => `${k}=${v.slice(0, 12)}…`).join(', ')}`);
  console.log('');

  // ══ ② 打印表单原始 HTML ══
  console.log('  ② 页面里 pwdFromId 表单的**原始 HTML**');
  const formHtml = extractForm(page.body, 'pwdFromId');
  if (formHtml) {
    // 只打印 form 标签和所有 input
    const tag = /<form[^>]*>/i.exec(page.body);
    console.log(`     form 标签: ${tag ? tag[0] : '(没找到)'}`);
    const inputs = [...page.body.matchAll(/<input\b[^>]*>/gi)].filter((m) => {
      // 只要 pwdFromId 里的
      const pos = m.index ?? 0;
      const formStart = page.body.indexOf('id="pwdFromId"');
      const formEnd = page.body.indexOf('</form>', formStart);
      return pos > formStart && pos < formEnd;
    });
    for (const m of inputs) console.log(`     ${squeeze(m[0])}`);
  } else {
    console.log('     (没找到 pwdFromId)');
  }
  console.log('');

  // ══ ③ 关键字段 ══
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
  const lt = pick('lt');
  console.log('  ③ 关键字段');
  console.log(`     pwdEncryptSalt = ${JSON.stringify(salt)}  (长度 ${salt ? salt.length : 0})`);
  console.log(`     execution      = ${JSON.stringify(execution)}`);
  console.log(`     lt             = ${JSON.stringify(lt)}`);
  console.log('');

  // ══ ④ 加密（固定 IV 便于复现） ══
  const ivStr = CHARSET.slice(0, 16); // 固定，便于对照
  const prefix = CHARSET.slice(0, 16).repeat(4); // 64 字符
  const key = Buffer.from(salt, 'utf8').subarray(0, 16);
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.from(ivStr, 'utf8'));
  const encPw = Buffer.concat([c.update(Buffer.from(prefix + PWD, 'utf8')), c.final()]).toString('base64');
  console.log('  ④ 加密结果（本次固定 IV，仅用于对照）');
  console.log(`     IV      = ${ivStr}`);
  console.log(`     密文长度 = ${encPw.length}`);
  console.log(`     密文     = ${encPw.slice(0, 40)}…`);
  console.log('');

  // ══ ⑤ 提交 ══
  const fields = {
    username: SID,
    password: encPw,
    captcha: '',
    _eventId: 'submit',
    cllt: 'userNameLogin',
    dllt: 'generalLogin',
    lt: '',
    execution,
  };
  const form = new URLSearchParams(fields).toString();

  console.log('  ⑤ POST 提交');
  console.log(`     目标   : ${LOGIN_URL.slice(0, 80)}…`);
  console.log(`     Referer: ${LOGIN_URL}`);
  console.log(`     字段顺序: ${Object.keys(fields).join(', ')}`);
  console.log(`     表单字节: ${Buffer.byteLength(form)}`);
  console.log(`     表单预览: username=${SID}&password=${encPw.slice(0, 20)}…&captcha=&_eventId=submit&cllt=userNameLogin&dllt=generalLogin&lt=&execution=${execution}`);
  console.log('');

  const r = await request(LOGIN_URL, {
    method: 'POST',
    body: form,
    cookies: page.cookies,
    // 补上浏览器会带的头 —— 有些风控会看这些
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

  console.log('  ⑥ 服务端回应');
  console.log(`     状态     : ${r.status}`);
  console.log(`     字节     : ${Buffer.byteLength(r.body)}`);
  console.log(`     location : ${r.location ?? '无'}`);
  console.log(`     setCookie: ${r.setCookie.map((x) => x.split(';')[0]).join(', ') || '无'}`);
  console.log('');

  // ══ ⑦ 页面里的提示 ══
  const msgPatterns = [
    /<[^>]*id=["']?showErrorTipSpan["']?[^>]*>([\s\S]{0,200}?)</i,
    /<[^>]*id=["']?showErrorTip["']?[^>]*>([\s\S]{0,300}?)</i,
    /<[^>]*class=["'][^"']*\berror\b[^"']*["'][^>]*>([\s\S]{0,200}?)</i,
  ];
  console.log('  ⑦ 返回页面里的提示');
  let foundMsg = false;
  for (const re of msgPatterns) {
    const m = re.exec(r.body);
    if (m) {
      const txt = squeeze(m[1].replace(/<[^>]*>/g, ' ')).trim();
      if (txt) {
        console.log(`     · ${txt.slice(0, 160)}`);
        foundMsg = true;
      }
    }
  }
  if (!foundMsg) console.log('     (没解析到提示文字)');
  console.log('');

  // ══ ⑧ 结论 ══
  console.log('  ══════════════════════════════════════════════════');
  if (r.location && /ticket=/i.test(r.location)) {
    console.log('   ✅ 成功 —— 拿到 ticket');
    console.log('      说明这个"学号+密码"组合是有效的。');
  } else {
    console.log('   ❌ 被拒（HTTP ' + r.status + '）');
    console.log('      服务端不接受这个"学号 + 密码"组合。');
    console.log('      如果浏览器能登进去，说明还有某个细节不一致 ——');
    console.log('      请把上面 ②③⑤ 的输出完整发给我。');
  }
  console.log('  ══════════════════════════════════════════════════');
})();
