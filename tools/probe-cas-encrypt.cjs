/**
 * 抓取 DGUT CAS 的真实加密脚本（encrypt.js），把关键实现打出来。
 *
 * ══════════ 为什么必须看它 ══════════
 * 用户用朋友的学号登录，CAS 明确回「您提供的用户名或者密码有误」，
 * 但密码确认是对的。那就只剩两种可能：
 *   ① 密码加密方式与网页不一致（服务端解不出来 → 当成密码错）
 *   ② 表单字段与网页不一致
 * 猜没有意义 —— 直接看学校前端到底怎么加密的。
 *
 * 页面引用了：
 *   /authserver/dgutCusTheme23/static/common/encrypt.js
 *   /authserver/dgutCusTheme23/static/web/js/login.js
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
  // 先拿登录页，找出所有 js 引用
  const page = await get(LOGIN_URL);
  console.log(`  登录页 ${page.status}  ${Buffer.byteLength(page.body)} 字节`);
  console.log('');

  const jsRefs = [...page.body.matchAll(/<script[^>]*src\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((u) => !/^https?:\/\//.test(u));

  console.log('  === 页面引用的本地 js ===');
  for (const r of jsRefs) console.log('  · ' + r);
  console.log('');

  // 只看加密相关的
  const targets = jsRefs.filter((u) => /encrypt|login|utils/i.test(u));

  for (const rel of targets) {
    const url = rel.startsWith('http') ? rel : BASE + rel;
    let r;
    try {
      r = await get(url);
    } catch (e) {
      console.log(`  × ${rel} 抓取失败: ${e.message}`);
      continue;
    }
    console.log('═'.repeat(70));
    console.log(`  ${rel}   ${r.status}  ${Buffer.byteLength(r.body)} 字节`);
    console.log('═'.repeat(70));

    const body = r.body;

    // 1) 与密码加密有关的关键片段
    const KEYWORDS = [
      'pwdEncryptSalt', 'encryptSalt', 'saltPassword', 'passwordText',
      'encryptAES', 'encrypt', 'AES', 'CryptoJS', 'randomString', 'chars',
    ];
    console.log('  --- 关键词是否存在 ---');
    for (const k of KEYWORDS) {
      const idx = body.indexOf(k);
      console.log(`  ${idx >= 0 ? '√' : '×'} ${k}`);
    }
    console.log('');

    // 2) 把 encrypt 相关的函数体打出来
    console.log('  --- 加密相关代码片段 ---');
    const anchors = ['function encrypt', 'encrypt =', 'encryptAES', 'saltPassword', 'pwdEncryptSalt'];
    const printed = new Set();
    for (const a of anchors) {
      let i = body.indexOf(a);
      let n = 0;
      while (i >= 0 && n < 3) {
        const start = Math.max(0, i - 120);
        const end = Math.min(body.length, i + 700);
        const seg = squeeze(body.slice(start, end));
        if (!printed.has(seg.slice(0, 80))) {
          printed.add(seg.slice(0, 80));
          console.log(`  【${a}】`);
          console.log('  ' + seg);
          console.log('');
        }
        i = body.indexOf(a, i + 1);
        n += 1;
      }
    }

    // 3) 有没有引用外部加密库
    console.log('  --- 引用的其他 js / 库 ---');
    for (const m of body.matchAll(/["']([^"']*\.js[^"']*)["']/gi)) {
      console.log('  · ' + m[1]);
    }
    console.log('');
  }
})();
