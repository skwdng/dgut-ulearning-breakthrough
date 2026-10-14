/**
 * 直接探测 DGUT CAS 登录页，把表单结构原样打出来。
 *
 * 目的：确认原生登录模块提交的字段/地址与网页表单**完全一致**。
 * 背景：用户反馈 POST 登录返回 401，响应体约 19KB（≈登录页大小），
 *       说明 CAS 拒绝了这次提交但把登录页返回了。
 *
 * 用法: node tools/probe-cas.cjs
 */
const https = require('node:https');
const http = require('node:http');

const LOGIN_URL =
  'https://auth.dgut.edu.cn/authserver/login?service=https%3A%2F%2Fapplication.dgut.edu.cn%2Fappapi%2Fcas%2Ffromcas';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function get(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': DESKTOP_UA,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...headers,
        },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          // 跟随重定向，记录每一跳
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 6) {
            const next = new URL(res.headers.location, url).toString();
            resolve({
              hops: [
                { url, status: res.statusCode, location: res.headers.location, setCookie: res.headers['set-cookie'] },
              ],
              ...get(next, headers, redirects + 1),
            });
            return;
          }
          resolve({
            hops: [
              { url, status: res.statusCode, location: res.headers.location ?? null, setCookie: res.headers['set-cookie'] ?? null },
            ],
            status: res.statusCode,
            finalUrl: url,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

/** 把 <form> 里的 input 全部抽出来 */
function extractFormInputs(html) {
  const out = [];
  const formRe = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let fm;
  while ((fm = formRe.exec(html))) {
    const attrs = fm[0].slice(0, fm[0].indexOf('>') + 1);
    const inputs = [];
    const inputRe = /<input\b[^>]*>/gi;
    let im;
    while ((im = inputRe.exec(fm[1]))) {
      const tag = im[0];
      const name = (tag.match(/\bname\s*=\s*["']([^"']*)["']/i) ?? [])[1] ?? null;
      const value = (tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i) ?? [])[1] ?? null;
      const type = (tag.match(/\btype\s*=\s*["']([^"']*)["']/i) ?? [])[1] ?? 'text';
      if (name) inputs.push({ name, type, value: value ? value.slice(0, 40) : null });
    }
    out.push({
      action: (attrs.match(/\baction\s*=\s*["']([^"']*)["']/i) ?? [])[1] ?? null,
      method: ((attrs.match(/\bmethod\s*=\s*["']([^"']*)["']/i) ?? [])[1] ?? 'get').toUpperCase(),
      id: (attrs.match(/\bid\s*=\s*["']([^"']*)["']/i) ?? [])[1] ?? null,
      inputs,
    });
  }
  return out;
}

/** 找页面里的提示文字（错误信息通常在这些 class 里） */
function extractMessages(html) {
  const patterns = [
    /<[^>]*class\s*=\s*["'][^"']*(?:error|alert|tip|msg|message)[^"']*["'][^>]*>([\s\S]{0,200}?)<\//gi,
    /id\s*=\s*["'](?:errorMsg|msg|showErrorTip|formErrorTip)["'][^>]*>([\s\S]{0,200}?)<\//gi,
  ];
  const out = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html))) {
      const text = m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (text) out.push(text.slice(0, 160));
    }
  }
  return [...new Set(out)];
}

(async () => {
  console.log('  探测 CAS 登录页');
  console.log('  ' + LOGIN_URL);
  console.log('');

  let r;
  try {
    r = await get(LOGIN_URL);
  } catch (e) {
    console.log('  × 请求失败：' + e.message);
    console.log('    （本机可能访问不了校园网 —— 这是正常的）');
    process.exit(2);
  }

  console.log('=== 跳转链 ===');
  for (const h of r.hops) {
    console.log(`  ${h.status}  ${h.url.slice(0, 90)}`);
    if (h.location) console.log(`        → ${String(h.location).slice(0, 90)}`);
    if (h.setCookie) {
      for (const c of h.setCookie) console.log(`        setCookie: ${c.split(';')[0]}`);
    }
  }
  console.log('');

  console.log(`=== 最终响应 ===`);
  console.log(`  状态: ${r.status}`);
  console.log(`  字节: ${Buffer.byteLength(r.body)}`);
  console.log(`  Content-Type: ${r.headers['content-type'] ?? '(无)'}`);
  console.log('');

  const forms = extractFormInputs(r.body);
  console.log(`=== 表单（找到 ${forms.length} 个）===`);
  for (const f of forms) {
    console.log(`  action=${f.action ?? '(无)'}  method=${f.method}  id=${f.id ?? '-'}`);
    for (const i of f.inputs) {
      console.log(`      ${i.name.padEnd(24)} type=${i.type.padEnd(10)} value=${i.value ?? '(空)'}`);
    }
  }
  console.log('');

  const msgs = extractMessages(r.body);
  console.log(`=== 页面提示（找到 ${msgs.length} 条）===`);
  for (const m of msgs) console.log('  · ' + m);
  if (!msgs.length) console.log('  （没有明显提示）');
  console.log('');

  // 关键字段是否存在
  console.log('=== 关键字段检查 ===');
  for (const [label, re] of [
    ['pwdEncryptSalt', /pwdEncryptSalt/i],
    ['pwdDefaultEncryptSalt', /pwdDefaultEncryptSalt/i],
    ['execution', /\bexecution\b/i],
    ['username 字段', /name\s*=\s*["']username["']/i],
    ['password 字段', /name\s*=\s*["']password["']/i],
    ['_eventId', /_eventId/i],
    ['cllt', /\bcllt\b/i],
    ['dllt', /\bdllt\b/i],
    ['captcha 相关', /captcha/i],
  ]) {
    console.log(`  ${re.test(r.body) ? '√' : '×'} ${label}`);
  }
  console.log('');

  // 顺带记下页面里出现的所有 name（便于发现遗漏字段）
  const allNames = [...r.body.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  console.log('=== 页面所有 name 属性（去重）===');
  for (const n of [...new Set(allNames)].slice(0, 40)) console.log('  · ' + n);
})();
