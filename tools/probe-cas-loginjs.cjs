/**
 * 抓学校自己的 login.js，看它的**表单提交**与页面动态行为。
 *
 * ══════════ 为什么必须看它 ══════════
 * 朋友的账号密码在手机浏览器里能登，但在 App（和我写的测试工具）里被拒。
 * 说明"学号 + 加密密码"这套**不够** —— 网页一定还做了别的事。
 *
 * 重点找：
 *   · 提交前是否动态补字段（rememberMe 之类）
 *   · pwdEncryptSalt 是不是被服务端换过（页面里的初始值可能是占位）
 *   · 是否有"常用账号"绑定 / 设备指纹 / 额外校验
 */
const https = require('node:https');

const BASE = 'https://auth.dgut.edu.cn';
const LOGIN_URL = `${BASE}/authserver/login?service=https%3A%2F%2Fapplication.dgut.edu.cn%2Fappapi%2Fcas%2Ffromcas`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, timeout: 20000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      })
      .on('error', reject);
  });
}

const squeeze = (s) => s.replace(/\s+/g, ' ');

(async () => {
  const r = await get(`${BASE}/authserver/dgutCusTheme23/static/web/js/login.js?v=20260529.200429`);
  const js = r.body;

  console.log(`  login.js  ${r.status}  ${Buffer.byteLength(js)} 字节`);
  console.log('');

  // ── 1) 提交相关的关键词 ──
  console.log('=== 1) 提交相关关键词 ===');
  for (const k of [
    'pwdFromId', 'loginFromId', 'saltPassword', 'pwdEncryptSalt', 'encryptPassword',
    'rememberMe', 'submit', 'ajaxSubmit', 'form.submit', 'serialize',
    'preventDefault', 'return false',
  ]) {
    const n = (js.match(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    console.log(`  ${n > 0 ? '√' : '×'} ${k.padEnd(20)} 出现 ${n} 次`);
  }
  console.log('');

  // ── 2) 密码登录的提交逻辑 ──
  console.log('=== 2) 密码登录提交逻辑（pwdFromId 附近）===');
  {
    let i = js.indexOf('pwdFromId');
    let n = 0;
    while (i >= 0 && n < 4) {
      console.log(`  【片段 ${n + 1}】`);
      console.log('  ' + squeeze(js.slice(Math.max(0, i - 300), i + 1200)));
      console.log('');
      i = js.indexOf('pwdFromId', i + 1);
      n += 1;
    }
  }

  // ── 3) 提交前是否补字段 ──
  console.log('=== 3) 是否动态追加字段（append / hidden / val）===');
  {
    const re = /(\$\([^)]*\)\s*\.\s*(?:append|val|attr|prop)\s*\([^;]{0,160})/g;
    let m;
    let n = 0;
    while ((m = re.exec(js)) && n < 25) {
      const seg = squeeze(m[1]);
      if (/password|salt|remember|hidden|input|username|_eventId|execution|cllt|dllt|lt/i.test(seg)) {
        console.log('  · ' + seg);
        n += 1;
      }
    }
    if (n === 0) console.log('  （没找到明显追加字段的代码）');
  }
  console.log('');

  // ── 4) 是否有"常用账号"/设备绑定相关提示 ──
  console.log('=== 4) 常用账号 / 设备绑定 / 风控相关 ===');
  for (const k of ['常用账号', '非常用', '绑定', '设备', '指纹', '风险', '安全', '206302', 'errCode']) {
    const i = js.indexOf(k);
    if (i >= 0) {
      console.log(`  √ ${k}`);
      console.log('    ' + squeeze(js.slice(Math.max(0, i - 160), i + 260)));
    } else {
      console.log(`  × ${k}`);
    }
  }
  console.log('');

  // ── 5) 登录页里"非常用账号"这句话是从哪来的 ──
  console.log('=== 5) 登录页里那句话的上下文 ===');
  {
    const page = await get(LOGIN_URL);
    for (const k of ['非常用', '常用账号']) {
      const i = page.body.indexOf(k);
      if (i >= 0) {
        console.log(`  √ 登录页含「${k}」`);
        console.log('    ' + squeeze(page.body.slice(Math.max(0, i - 300), i + 300)));
      } else {
        console.log(`  × 登录页不含「${k}」（说明是登录失败后才出现的提示）`);
      }
    }
  }
})();
