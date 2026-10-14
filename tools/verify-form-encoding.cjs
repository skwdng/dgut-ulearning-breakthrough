/**
 * 对比两种表单编码方式，找出 App 提交密码时可能的编码错误。
 *
 * ══════════ 背景 ══════════
 * 朋友账号（密码含特殊符号）在手机浏览器能登，我写的 Node 工具也能登，
 * 但 App（原生 Kotlin）登不上 —— 所以问题在 App 的**参数编码**。
 *
 * App 用的是 java.net.URLEncoder.encode(s, "UTF-8")，逐字段拼接；
 * 我的工具用的是 URLSearchParams（等价于 HTML 表单的标准编码）。
 * 这个脚本把两者在 Node 里都复刻出来，逐一对比。
 */
const CHARSET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  √ ${name}`);
  } else {
    fail += 1;
    console.log(`  × ${name}${extra ? '  → ' + extra : ''}`);
  }
};

/**
 * 复刻 java.net.URLEncoder.encode(s, "UTF-8")。
 *
 * ⚠️ Java 的规则与 HTML 表单标准编码**有一处不同**：
 *    Java 把空格编成 `+`；而表单标准也是 `+`，这两者一致。
 *    但 Java **不编码** `*`，也不编码 `-_.`；
 *    表单标准（application/x-www-form-urlencoded）同样不编码 `*-._`。
 * 所以理论上应完全一致 —— 逐字符验证一下。
 */
function javaUrlEncoder(s) {
  const UNRESERVED = /[A-Za-z0-9\-_.*]/;
  let out = '';
  for (const ch of s) {
    if (ch === ' ') {
      out += '+';
    } else if (UNRESERVED.test(ch)) {
      out += ch;
    } else {
      // UTF-8 编码后逐字节 %XX
      const bytes = Buffer.from(ch, 'utf8');
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/** 复刻 Kotlin 的 buildForm（逐字段 URLEncoder 后拼 &） */
function kotlinForm(fields) {
  return Object.entries(fields)
    .map(([k, v]) => `${javaUrlEncoder(k)}=${javaUrlEncoder(v)}`)
    .join('&');
}

/** HTML 表单标准编码（URLSearchParams 就是它） */
function standardForm(fields) {
  return new URLSearchParams(fields).toString();
}

console.log('  ══════════════════════════════════════════════════');
console.log('   表单编码对比：App(Kotlin URLEncoder) vs 标准表单');
console.log('  ══════════════════════════════════════════════════');
console.log('');

console.log('=== 1) 特殊字符逐个对比 ===');
const SPECIALS = [
  '!', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
  ':', ';', '<', '=', '>', '?', '@', '[', ']', '^', '_', '`', '{', '|', '}', '~',
  ' ', '"', '\\',
];
{
  let mismatch = 0;
  for (const ch of SPECIALS) {
    const sample = `a${ch}b`;
    const k = javaUrlEncoder(sample);
    const s = new URLSearchParams({ v: sample }).toString().slice(2); // 去掉 "v="
    const same = k === s;
    if (!same) {
      mismatch += 1;
      console.log(`  × ${JSON.stringify(ch)}  Kotlin=${k}  标准=${s}`);
    }
  }
  t(`所有特殊字符编码一致（差异 ${mismatch} 处）`, mismatch === 0);
}

console.log('\n=== 2) 典型密码对比 ===');
{
  const PWDS = [
    'Cj130026',
    'abc#123',
    'abc%123',
    'abc&123',
    'abc+123',
    'p@ss w0rd',
    'a#b%c&d+e',
    'Abc123!@#',
    '中文密码123',
    'a=b&c=d',
    '100%safe',
    'x+y=z',
  ];
  for (const p of PWDS) {
    const k = javaUrlEncoder(p);
    const s = new URLSearchParams({ v: p }).toString().slice(2);
    const same = k === s;
    console.log(`  ${same ? '√' : '×'} ${p.padEnd(16)} App=${k.padEnd(26)} 标准=${s}`);
  }
  const allSame = PWDS.every(
    (p) => javaUrlEncoder(p) === new URLSearchParams({ v: p }).toString().slice(2),
  );
  t('典型密码编码全部一致', allSame);
}

console.log('\n=== 3) 完整表单对比（含 Base64 密码）===');
{
  // 模拟一个真实的加密后密码（Base64，含 + / =）
  const encPw = 'Ab+C/dEf==';
  const fields = {
    username: '2099000000114',
    password: encPw,
    captcha: '',
    _eventId: 'submit',
    cllt: 'userNameLogin',
    dllt: 'generalLogin',
    lt: '',
    execution: 'e1s1',
  };
  const k = kotlinForm(fields);
  const s = standardForm(fields);
  console.log(`  App : ${k}`);
  console.log(`  标准: ${s}`);
  t('完整表单一致', k === s);

  // 关键：Base64 里的 + / = 必须被编码
  t('Base64 的 + 被编码为 %2B', k.includes('%2B') && !/[^%]\+/.test(k));
  t('Base64 的 = 被编码为 %3D', k.includes('%3D'));
  t('Base64 的 / 被编码为 %2F', k.includes('%2F'));
}

console.log('\n=== 4) ★ 重点排查：Base64 加密结果里的 + / = ===');
{
  /**
   * 加密后的密码是 Base64。Base64 字母表包含 `+` `/` 和结尾的 `=`。
   * 如果提交时**没有编码** `+`，服务端会把它解成**空格** ——
   * 于是解密出来的密码就错了，CAS 报"用户名或密码有误"。
   *
   * ⚠️ 第一版这里假设"随机 Base64 多半含 +"，实测**不成立**
   *    （固定的 64 字符前缀 + 短密码 → 长度正好 3 的倍数时根本不含 =，
   *     且 + / 出现概率很低）。所以改成用**确定性样本**验证编码正确性，
   *     而不是统计随机样本 —— 断言必须稳定，不能靠概率。
   */
  // 构造必定含 + / = 的样本
  const samples = ['Ab+C/dEf==', '///+++===', 'a+b/c='];
  let allGood = true;
  for (const s of samples) {
    const encoded = javaUrlEncoder(s);
    const restored = new URLSearchParams(`v=${encoded}`).get('v');
    if (restored !== s || encoded !== new URLSearchParams({ v: s }).toString().slice(2)) {
      allGood = false;
      console.log(`  × ${s} → ${encoded}（还原成 ${restored}）`);
    }
  }
  t('含 + / = 的样本编码后能原样还原', allGood);

  // 实测一下真实加密结果里 + / 的出现率（仅作参考，不做断言）
  let hit = 0;
  const N = 500;
  for (let i = 0; i < N; i += 1) {
    const rnd = Array.from({ length: 64 }, () => CHARSET[Math.floor(Math.random() * CHARSET.length)]).join('');
    const b64 = Buffer.from(rnd + 'password', 'utf8').toString('base64');
    if (b64.includes('+') || b64.includes('/') || b64.includes('=')) hit += 1;
  }
  console.log(`  参考：${N} 个真实样本中，含 +///= 的有 ${hit} 个（${((hit / N) * 100).toFixed(0)}%）`);

  // 不编码的后果
  const bad = 'password=Ab+C/dEf==';
  const good = `password=${javaUrlEncoder('Ab+C/dEf==')}`;
  console.log('');
  console.log(`  未编码（错）: ${bad}`);
  console.log(`  已编码（对）: ${good}`);
  t('未编码的 + 会被服务端当成空格', new URLSearchParams(bad).get('password') !== 'Ab+C/dEf==');
  t('已编码的能原样还原', new URLSearchParams(good).get('password') === 'Ab+C/dEf==');
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
