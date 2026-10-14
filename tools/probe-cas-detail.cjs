/**
 * 把 CAS 登录页里关键片段原样打出来，确认原生登录提交的参数与网页表单一致。
 *
 * 重点看三处：
 *   · pwdEncryptSalt 的值与它所在的 script
 *   · execution 的值（表单里默认是 e1s1，但 JS 会替换）
 *   · password 隐藏字段是怎么被 JS 填上的、form 的 submit 拦在哪里
 */
const https = require('node:https');

const LOGIN_URL =
  'https://auth.dgut.edu.cn/authserver/login?service=https%3A%2F%2Fapplication.dgut.edu.cn%2Fappapi%2Fcas%2Ffromcas';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, timeout: 20000 }, (res) => {
        const cs = [];
        res.on('data', (c) => cs.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString('utf8') }));
      })
      .on('error', reject);
  });
}

const squeeze = (s) => s.replace(/\s+/g, ' ');

(async () => {
  const r = await fetchText(LOGIN_URL);
  const html = r.body;

  console.log(`  状态 ${r.status}   字节 ${Buffer.byteLength(html)}`);
  console.log('');

  console.log('═══ 1) pwdEncryptSalt 的所有出现位置 ═══');
  {
    let i = html.indexOf('pwdEncryptSalt');
    let n = 0;
    while (i >= 0 && n < 6) {
      console.log(`  [${n}] …${squeeze(html.slice(Math.max(0, i - 200), i + 240))}…`);
      console.log('');
      i = html.indexOf('pwdEncryptSalt', i + 1);
      n += 1;
    }
    if (n === 0) console.log('  （没找到）');
  }

  console.log('═══ 2) execution 的所有出现位置 ═══');
  {
    let i = html.indexOf('execution');
    let n = 0;
    while (i >= 0 && n < 6) {
      console.log(`  [${n}] …${squeeze(html.slice(Math.max(0, i - 160), i + 200))}…`);
      console.log('');
      i = html.indexOf('execution', i + 1);
      n += 1;
    }
  }

  console.log('═══ 3) 提交前 JS 做了什么的线索 ═══');
  for (const key of ['encrypt', 'encryptPassword', 'pwdFromId', 'loginFromId', 'submit', 'AES', 'encryptAES']) {
    const i = html.indexOf(key);
    console.log(`  ${i >= 0 ? '√' : '×'} ${key}`);
  }
  console.log('');

  console.log('═══ 4) pwdFromId 表单前后原文 ═══');
  {
    const i = html.indexOf('pwdFromId');
    if (i >= 0) {
      const start = html.lastIndexOf('<form', i);
      const end = html.indexOf('</form>', i);
      console.log(squeeze(html.slice(start, Math.min(end + 7, start + 1600))));
    } else {
      console.log('  （没找到）');
    }
  }
  console.log('');

  console.log('═══ 5) 引入的 js 文件 ═══');
  for (const m of html.matchAll(/<script[^>]*src\s*=\s*["']([^"']+)["']/gi)) {
    console.log('  · ' + m[1]);
  }

  console.log('');
  console.log('═══ 6) 内联 script 里与加密相关的片段 ═══');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  let found = 0;
  for (const s of scripts) {
    if (/encrypt|AES|password/i.test(s)) {
      const idx = s.search(/encrypt|AES/i);
      console.log('  ---');
      console.log('  ' + squeeze(s.slice(Math.max(0, idx - 200), idx + 600)));
      found += 1;
      if (found >= 3) break;
    }
  }
  if (!found) console.log('  （内联脚本里没有加密逻辑，可能在外部 js 里）');
})();
