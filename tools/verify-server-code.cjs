/**
 * 跨端一致性测试：**服务端生成的码**必须能被 **App 的算法**校验通过。
 *
 * 为什么必须测：授权码有两份实现
 *   · App    src/domain/licenseCode.ts
 *   · 服务端 server/licenseCode.cjs
 * 两边算法只要差一点，服务端下发的码在 App 里就会"校验失败"，
 * 而这种问题在界面上只表现为一句"授权码无效"，极难定位。
 *
 * 做法：复刻 App 的校验逻辑，对服务端真实生成的码做完整校验
 *（前缀 / 长度 / payload 里的学号哈希 / 签名）。
 */
const path = require('node:path');
const { generateLicenseCode, hashStudentId } = require(path.resolve(__dirname, '..', 'server', 'licenseCode.cjs'));

const CODE_PREFIX = 'LK1';
const SIGN_KEY = 'LifeKit::checkin::v1::2026';
const B32 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SEG_LEN = 5;
const PAYLOAD_CHARS = 13;
const SIG_CHARS = SEG_LEN * 3;

let pass = 0;
let fail = 0;
const t = (n, c, e = '') => {
  if (c) {
    pass += 1;
    console.log(`  √ ${n}`);
  } else {
    fail += 1;
    console.log(`  × ${n}${e ? '  → ' + e : ''}`);
  }
};

// ── 复刻 App 端的校验（与 licenseCode.ts 同逻辑）──
const normalizeStudentId = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

function hashStr(s) {
  const str = normalizeStudentId(s);
  const fnv = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  return fnv(0x811c9dc5).toString(16).padStart(8, '0') + fnv(0x9e3779b9).toString(16).padStart(8, '0');
}

function toBase32(bytes) {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = ((acc << 8) | (b & 0xff)) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
      acc &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function signWith(key, payloadStr) {
  const raw = `${key}|${payloadStr}`;
  return toBase32(hexToBytes(hashStr(raw) + hashStr(`${raw}#2`)));
}

/** 规范化：去非字母数字、转大写 */
const canon = (s) => String(s ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();

/**
 * 复刻 App 的 checkCodeForStudent（只覆盖普通个人码）。
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyLikeApp(code, studentId) {
  const raw = canon(code);
  if (!raw) return { ok: false, reason: 'empty' };
  if (!raw.startsWith(CODE_PREFIX)) return { ok: false, reason: 'prefix' };

  const body = raw.slice(CODE_PREFIX.length);
  if (body.length !== PAYLOAD_CHARS + SIG_CHARS) return { ok: false, reason: 'length' };

  const payload = body.slice(0, PAYLOAD_CHARS);
  const sig = body.slice(PAYLOAD_CHARS);

  // ① 签名
  const expectSig = signWith(SIGN_KEY, payload).slice(0, SIG_CHARS);
  if (sig !== expectSig) return { ok: false, reason: 'signature' };

  // ② 学号哈希
  const hashBytes = hexToBytes(hashStr(studentId)).slice(0, 6);
  const expectPayloadHead = toBase32([...hashBytes, 0, 0]).slice(0, 10); // 前 6 字节 → 前 10 字符
  if (!payload.startsWith(expectPayloadHead)) return { ok: false, reason: 'studentIdHash' };

  return { ok: true };
}

console.log('=== 1) 服务端生成的码格式正确 ===');
{
  const c = generateLicenseCode('2099000000116');
  t('以 LK1- 开头', c.startsWith('LK1-'));
  const body = canon(c).slice(3);
  t(`长度正确（${PAYLOAD_CHARS}+${SIG_CHARS}=${PAYLOAD_CHARS + SIG_CHARS}）`, body.length === PAYLOAD_CHARS + SIG_CHARS, String(body.length));
  t('只含 Base32 字符', [...body].every((x) => B32.includes(x)));
  t('有分段横线', c.split('-').length === 7, c);
}

console.log('\n=== 2) ★ 服务端生成的码能被 App 算法校验通过（核心）===');
{
  const cases = ['2099000000116', '2099000000999', 'abc123', '  2099 0000 00116  '];
  for (const sid of cases) {
    const code = generateLicenseCode(sid);
    const r = verifyLikeApp(code, sid);
    t(`学号 ${JSON.stringify(sid)} 的码自校验通过`, r.ok, r.reason ?? '');
  }
}

console.log('\n=== 3) ★ 换学号必须校验失败（防登录别人账号）===');
{
  const codeA = generateLicenseCode('2099000000116');
  const codeB = generateLicenseCode('2099000000999');

  const r1 = verifyLikeApp(codeA, '2099000000999');
  t('A 的码拿去校验 B → 失败', !r1.ok, r1.reason ?? '（竟然通过了！）');
  t('  失败原因是学号不匹配', r1.reason === 'studentIdHash', r1.reason ?? '');

  const r2 = verifyLikeApp(codeB, '2099000000116');
  t('B 的码拿去校验 A → 失败', !r2.ok);
  t('  失败原因是学号不匹配', r2.reason === 'studentIdHash', r2.reason ?? '');
}

console.log('\n=== 4) 篡改必须被发现 ===');
{
  const code = generateLicenseCode('2099000000116');
  const body = canon(code).slice(3);

  // 改签名最后一位
  const tampered1 = 'LK1-' + body.slice(0, -1) + (body.slice(-1) === 'A' ? 'B' : 'A');
  const r1 = verifyLikeApp(tampered1, '2099000000116');
  t('改签名 → 失败', !r1.ok, r1.reason ?? '（竟然通过了！）');
  t('  原因是签名不符', r1.reason === 'signature', r1.reason ?? '');

  // 改 payload 中间一位
  const mid = 6;
  const tampered2 = 'LK1-' + body.slice(0, mid) + (body[mid] === 'A' ? 'B' : 'A') + body.slice(mid + 1);
  const r2 = verifyLikeApp(tampered2, '2099000000116');
  t('改 payload → 失败', !r2.ok, r2.reason ?? '（竟然通过了！）');
}

console.log('\n=== 5) 稳定性 ===');
{
  const a = generateLicenseCode('2099000000116');
  const b = generateLicenseCode('2099000000116');
  t('同一学号生成结果稳定', a === b);

  t(
    '大小写/空格不影响学号哈希',
    hashStudentId('ABC') === hashStudentId(' abc '),
  );
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
