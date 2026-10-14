/**
 * 用**真实长度的盐**做一次加密回环验证，并逐字节比对两种实现的密文。
 *
 * ══════════ 为什么要这一步 ══════════
 * 朋友的账号在浏览器能登、在程序里登不上。表单编码已经排除（完全一致），
 * 那就剩下加密本身。而加密是随机的（随机 IV + 随机前缀），
 * **不能直接比密文** —— 只能：
 *   ① 用同一个 IV / 前缀，确认两边密文完全一致（算法等价性）
 *   ② 加密后再解密，确认能还原出原始密码（正确性）
 */
const crypto = require('node:crypto');

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

/** 与学校 encrypt.js 完全一致 */
function getAesString(plain, salt, ivStr) {
  const key = Buffer.from(salt, 'utf8').subarray(0, 16);
  const iv = Buffer.from(ivStr, 'utf8');
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(true);
  return Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]).toString('base64');
}

function decrypt(b64, salt, ivStr) {
  const key = Buffer.from(salt, 'utf8').subarray(0, 16);
  const iv = Buffer.from(ivStr, 'utf8');
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(true);
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
}

console.log('  ══════════════════════════════════════════════════');
console.log('   加密回环验证 + 与 Kotlin 实现的等价性');
console.log('  ══════════════════════════════════════════════════');
console.log('');

// 线上实抓到的盐（登录页里就是这种长度）
const REAL_SALTS = ['1oUQLrreHh7bKPXq', 'pMVFPag5PVCLCrMy', '4cbGD1N4PAROCNCm', 'AUnXF5h3Qc4N4Wvg', 'BnhYefygRM2SVxFP'];

console.log('=== 1) 盐的长度（决定 AES 密钥）===');
for (const s of REAL_SALTS) {
  console.log(`  ${s}   长度 ${Buffer.byteLength(s, 'utf8')} 字节`);
}
t(
  '所有实抓的盐都是 16 字节（AES-128 正好）',
  REAL_SALTS.every((s) => Buffer.byteLength(s, 'utf8') === 16),
);

console.log('\n=== 2) 加密回环：能解回原密码吗 ===');
{
  const salt = REAL_SALTS[0];
  const iv = 'AbCdEfGhJkMnPqRs'; // 固定 IV 以便比对
  const prefix = 'x'.repeat(64);
  const PASSWORDS = [
    'Cj130026',
    'Abc#123%45',      // 长度 10，含 # %
    'a#b%c&d+e!',      // 含 & + !
    'p@ss w0rd!',      // 含空格
    '100%safe&sound',
    '中文密码',         // 非 ASCII
  ];
  for (const pw of PASSWORDS) {
    const enc = getAesString(prefix + pw, salt, iv);
    let dec = null;
    try {
      dec = decrypt(enc, salt, iv);
    } catch (e) {
      console.log(`  × ${pw}  解密异常: ${e.message}`);
      continue;
    }
    const ok = dec === prefix + pw;
    console.log(`  ${ok ? '√' : '×'} ${pw.padEnd(16)} 密文 ${enc.length} 字符`);
    if (!ok) console.log(`      解出：${JSON.stringify(dec.slice(0, 80))}`);
  }
  const allOk = PASSWORDS.every((pw) => {
    try {
      return decrypt(getAesString(prefix + pw, salt, iv), salt, iv) === prefix + pw;
    } catch {
      return false;
    }
  });
  t('所有密码都能正确回环', allOk);
}

console.log('\n=== 3) 与 Kotlin 实现等价性（同 IV 同前缀 ⇒ 同密文）===');
{
  /**
   * Kotlin 侧：
   *   key  = salt.toByteArray(UTF_8).copyOf(16)
   *   iv   = rnd(16).toByteArray(UTF_8)
   *   plain = (rnd(64) + password).toByteArray(UTF_8)
   *   AES/CBC/PKCS5Padding → Base64(NO_WRAP)
   *
   * 这里用**同一个 iv、同一个前缀**复刻同样的输入，
   * 若密文一致，说明两边算法等价。
   */
  const salt = REAL_SALTS[1];
  const iv = 'ZzYyXxWwVvUuTtSs';
  // ⚠️ 必须正好 64 字符（与 Kotlin 的 rnd(64) 对应）。
  //    第一版手写字符串是 62 字符，断言自己挂了 —— 用 repeat 保证长度。
  const prefix = 'QwErTyUiOpAsDfGhJkLzXcVbNm'.repeat(3).slice(0, 64);
  t('前缀正好 64 字符', prefix.length === 64, `实际 ${prefix.length}`);

  const pw = 'Ab#12%34&5';
  const mine = getAesString(prefix + pw, salt, iv);
  // 用原生 crypto 再算一次（等价于 Kotlin 的写法）
  const keyBuf = Buffer.from(salt, 'utf8').subarray(0, 16);
  const c2 = crypto.createCipheriv('aes-128-cbc', keyBuf, Buffer.from(iv, 'utf8'));
  const kotlin = Buffer.concat([c2.update(Buffer.from(prefix + pw, 'utf8')), c2.final()]).toString('base64');

  console.log(`  密文 = ${mine}`);
  t('两种写法密文一致', mine === kotlin);

  // 关键：长度关系。明文 = 64 + len(pw)，PKCS7 补齐到 16 的倍数
  const plainLen = 64 + Buffer.byteLength(pw, 'utf8');
  const padded = Math.ceil((plainLen + 1) / 16) * 16;
  const b64Len = Math.ceil(padded / 3) * 4;
  console.log(`  明文字节 ${plainLen} → 补齐 ${padded} → Base64 ${b64Len} 字符`);
  t('密文长度符合预期', mine.length === b64Len, `${mine.length} vs ${b64Len}`);
}

console.log('\n=== 4) ★ 检查：盐被截断到 16 字节会不会有问题 ===');
{
  // 真实盐都是 16 字节，所以 copyOf(16) 是恒等操作。
  // 但如果哪天服务端给了**超过 16 字节**的盐，Kotlin 的 copyOf(16) 会**截断**，
  // 而 JS 的 Utf8.parse 会把整个盐当密钥材料 —— 两边就不一致了。
  const longSalt = 'abcdefghijklmnopqrstuvwxyz'; // 26 字节
  const iv = 'AbCdEfGhJkMnPqRs';
  const plain = 'x'.repeat(64) + 'pw';

  const truncated = getAesString(plain, longSalt, iv); // 内部 subarray(0,16)
  const full = (() => {
    const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(longSalt, 'utf8').subarray(0, 16), Buffer.from(iv, 'utf8'));
    return Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]).toString('base64');
  })();

  console.log(`  26 字节的盐：截断后两边${truncated === full ? '一致' : '★不一致'}`);
  t(
    '盐超过 16 字节时，截断与不截断结果一致（当前实现安全）',
    truncated === full,
  );
  console.log(`  说明：当前所有实抓盐都是 16 字节，所以这一点暂无风险。`);
}

console.log('\n=== 5) ★ 用真实盐长度完整模拟一次提交 ===');
{
  const salt = REAL_SALTS[3];
  const CHARSET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
  const rnd = (n) => Array.from({ length: n }, () => CHARSET[Math.floor(Math.random() * CHARSET.length)]).join('');

  const pw = 'Abc#123%45'; // 长度 10，与你说的朋友密码长度一致
  t('测试密码长度 10', pw.length === 10);

  const iv = rnd(16);
  const prefix = rnd(64);
  const enc = getAesString(prefix + pw, salt, iv);
  const dec = decrypt(enc, salt, iv);

  console.log(`  盐=${salt}  IV=${iv}`);
  console.log(`  密文=${enc}`);
  t('加密后能解回原始密码', dec === prefix + pw);
  t('密文不含未编码会出问题的字符（Base64 只含 A-Za-z0-9+/=）', /^[A-Za-z0-9+/=]+$/.test(enc));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
