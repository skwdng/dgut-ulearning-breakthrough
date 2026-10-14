// 授权码（一人一码）回归测试。
//
// 重点验证：
//  1. 生成/解析往返
//  2. ★ 一码一人：A 的码在 B 的账号上必须被拒
//  3. 篡改检测
//  4. 有效期
//  5. 输入容错（小写、空格、缺横线）
//
// 由于 licenseCode.ts 是 TS，这里用等价逻辑复刻一份做验证，
// 再通过 tsc 保证两边类型一致（见 tools/verify-code.cjs 顶部说明）。

// ⚠️ 字母表必须正好 32 个字符：5 位掩码 & 31 能取 0~31，
// 少于 32 个会让 index 30/31 变成 undefined（踩过的坑）。
// 这里从 36 个（0-9 + A-Z）里删掉最易混的 0 / 1 / I / O。
const B32 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
if (B32.length !== 32) throw new Error(`B32 长度必须是 32，当前 ${B32.length}`);
const SIGN_KEY = 'LifeKit::checkin::v1::2026';
const SEG_LEN = 5;
const CODE_PREFIX = 'LK1';

function normalizeStudentId(s) { return (s ?? '').replace(/\s+/g, '').toLowerCase(); }

function hashStudentId(studentId) {
  const s = normalizeStudentId(studentId);
  const fnv = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  return fnv(0x811c9dc5).toString(16).padStart(8, '0') + fnv(0x9e3779b9).toString(16).padStart(8, '0');
}
function sign(payloadStr) {
  const raw = `${SIGN_KEY}|${payloadStr}`;
  // ⚠️ 必须编码成 Base32：hashStudentId 返回 hex（含 0/1），而 Base32 字母表没有 0/1
  return toBase32(hexToBytes(hashStudentId(raw) + hashStudentId(`${raw}#2`)));
}
function toBase32(bytes) {
  // ⚠️ 每次只累积 1 字节：累积多字节会让 bits > 31，`>>>` 溢出算出 undefined
  let bits = 0, acc = 0, out = '';
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
function group(s) {
  const p = [];
  for (let i = 0; i < s.length; i += SEG_LEN) p.push(s.slice(i, i + SEG_LEN));
  return p.join('-');
}
function canonicalizeCodeInput(input) { return (input ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase(); }
function expireDaysFrom(expiresAt) {
  if (!expiresAt) return 0;
  const EPOCH = Date.UTC(2026, 0, 1);
  const d = Math.round((expiresAt - EPOCH) / 86400000);
  if (d <= 0) return 1;
  return Math.min(d, 0xffff);
}
function expireDaysTo(days) { return days ? Date.UTC(2026, 0, 1) + days * 86400000 : undefined; }

const PAYLOAD_BYTES = 8;
const PAYLOAD_CHARS = Math.ceil(PAYLOAD_BYTES * 8 / 5);
const SIG_CHARS = SEG_LEN * 3;

function generateLicenseCode(studentId, options = {}) {
  const sid = normalizeStudentId(studentId);
  if (!sid) throw new Error('学号不能为空');
  const hashBytes = hexToBytes(hashStudentId(sid)).slice(0, 6);
  const days = expireDaysFrom(options.expiresAt);
  const payloadStr = toBase32([...hashBytes, (days >> 8) & 0xff, days & 0xff]);
  const sigStr = sign(payloadStr).slice(0, SIG_CHARS);
  return `${CODE_PREFIX}-${group(payloadStr + sigStr)}`;
}

function fromBase32(s, n) {
  let bits = 0, acc = 0;
  const out = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) continue;
    acc = ((acc << 5) | v) & 0x3fff;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
      acc &= (1 << bits) - 1;
      if (out.length >= n) break;
    }
  }
  return out;
}

function parseLicenseCode(input) {
  const raw = canonicalizeCodeInput(input);
  if (!raw) return { ok: false, reason: 'empty' };
  if (!raw.startsWith(CODE_PREFIX)) return { ok: false, reason: 'prefix' };
  const body = raw.slice(CODE_PREFIX.length);
  if (body.length !== PAYLOAD_CHARS + SIG_CHARS) return { ok: false, reason: 'length' };
  const payloadStr = body.slice(0, PAYLOAD_CHARS);
  const sigStr = body.slice(PAYLOAD_CHARS);
  if (sign(payloadStr).slice(0, SIG_CHARS) !== sigStr) return { ok: false, reason: 'signature' };
  const pb = fromBase32(payloadStr, PAYLOAD_BYTES);
  const hashHex = pb.slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
  const days = (pb[6] << 8) | pb[7];
  return { ok: true, info: { studentIdHash: hashHex, expiresAt: expireDaysTo(days), code: `${CODE_PREFIX}-${group(body)}` } };
}

function checkCodeForStudent({ code, studentId, now = Date.now() }) {
  if (!code?.trim()) return { status: 'empty', message: '还没有填写授权码' };
  const parsed = parseLicenseCode(code);
  if (!parsed.ok) {
    const map = { empty: '授权码为空', prefix: '格式不对', length: '长度不对', signature: '校验失败' };
    return { status: 'invalid', message: map[parsed.reason] ?? '无效' };
  }
  const mine = hashStudentId(studentId).slice(0, 12);
  if (parsed.info.studentIdHash !== mine) return { status: 'mismatch', message: '不属于当前账号' };
  if (parsed.info.expiresAt && now > parsed.info.expiresAt) return { status: 'expired', message: '已过期', expiresAt: parsed.info.expiresAt };
  return { status: 'granted', message: 'ok', expiresAt: parsed.info.expiresAt };
}

// ─────────────────────────── 测试 ───────────────────────────
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  √ ${name}`); }
  else { fail += 1; console.log(`  × ${name}${extra ? '  → ' + extra : ''}`); }
};

console.log('=== 1) 码的格式 ===');
const codeA = generateLicenseCode('2099000000116');
console.log(`  学号 2099000000116 的码: ${codeA}`);
t('以 LK1- 开头', codeA.startsWith('LK1-'), codeA);
t('长度合理（>=20 字符）', codeA.length >= 20, `${codeA.length}`);
// 字母表为 23456789ABCDEFGHJKLMNPQRSTUVWXYZ（无 0/1/I/O）
t('只含合法 Base32 字符与横线', /^LK1-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ-]+$/.test(codeA), codeA);
t('不含易混字符 0/1/I/O', !/[01IO]/.test(codeA.slice(4)), codeA);

console.log('\n=== 2) 生成/解析往返 ===');
const p1 = parseLicenseCode(codeA);
t('解析成功', p1.ok === true, JSON.stringify(p1));
t('学号哈希一致', p1.ok && p1.info.studentIdHash === hashStudentId('2099000000116').slice(0, 12));
t('永久码无到期时间', p1.ok && p1.info.expiresAt === undefined);

console.log('\n=== 3) ★ 一码一人（核心）===');
const r1 = checkCodeForStudent({ code: codeA, studentId: '2099000000116' });
t('A 的码 → A 用：通过', r1.status === 'granted', r1.status);

const r2 = checkCodeForStudent({ code: codeA, studentId: '2099000000117' });
t('★ A 的码 → B 用：被拒', r2.status === 'mismatch', r2.status);

const r3 = checkCodeForStudent({ code: codeA, studentId: '2099000000116 ' });
t('学号带空格也能匹配', r3.status === 'granted', r3.status);

const r4 = checkCodeForStudent({ code: codeA, studentId: '  2099000000116  ' });
t('学号两侧空格', r4.status === 'granted', r4.status);

console.log('\n=== 4) 篡改检测 ===');
const tampered = codeA.slice(0, -1) + (codeA.slice(-1) === 'A' ? 'B' : 'A');
const pt = parseLicenseCode(tampered);
t('改最后一个字符 → 签名失败', pt.ok === false && pt.reason === 'signature', JSON.stringify(pt));

const tampered2 = 'LK1-' + codeA.slice(4).split('-').map((s, i) => (i === 0 ? 'ZZZZZ' : s)).join('-');
const pt2 = parseLicenseCode(tampered2);
t('改载荷段 → 签名失败', pt2.ok === false, JSON.stringify(pt2));

const truncated = codeA.slice(0, codeA.length - 3);
t('截断 → 长度不足', parseLicenseCode(truncated).ok === false, JSON.stringify(parseLicenseCode(truncated)));

console.log('\n=== 5) 输入容错 ===');
const lower = codeA.toLowerCase();
t('全小写也能识别', parseLicenseCode(lower).ok === true);
const noDash = codeA.replace(/-/g, '');
t('去掉横线也能识别', parseLicenseCode(noDash).ok === true);
const spaced = '  ' + codeA.split('').join(' ') + '  ';
t('字符间插空格', parseLicenseCode(spaced).ok === true, `${spaced.length} 字符`);

console.log('\n=== 6) 有效期 ===');
const future = Date.UTC(2027, 5, 1);
const codeExp = generateLicenseCode('2099000000116', { expiresAt: future });
const pe = parseLicenseCode(codeExp);
t('带到期时间的码可解析', pe.ok === true);
const daysDiff = pe.ok && pe.info.expiresAt ? Math.round(((pe.info.expiresAt) - future) / 86400000) : 999;
t('到期时间误差 <= 1 天', Math.abs(daysDiff) <= 1, `diff=${daysDiff} 天`);

const rExpNow = checkCodeForStudent({ code: codeExp, studentId: '2099000000116', now: future + 86400000 });
t('过期后判定为 expired', rExpNow.status === 'expired', rExpNow.status);
const rExpBefore = checkCodeForStudent({ code: codeExp, studentId: '2099000000116', now: future - 86400000 });
t('未过期判定为 granted', rExpBefore.status === 'granted', rExpBefore.status);

console.log('\n=== 7) 边界与鲁棒性 ===');
t('空码 → empty', parseLicenseCode('').reason === 'empty');
t('乱码 → 失败', parseLicenseCode('HELLO-WORLD').ok === false);
t('错前缀 → prefix', parseLicenseCode('XX9-ABCDE-FGHJK-MNPQR-STVWX').reason === 'prefix');

// 哈希碰撞检查（1000 个学号）
const seen = new Map();
let collisions = 0;
for (let i = 0; i < 1000; i += 1) {
  const sid = `20254040${String(30000 + i)}`;
  const h = hashStudentId(sid).slice(0, 12);
  if (seen.has(h)) collisions += 1;
  seen.set(h, sid);
}
t('1000 个学号无哈希碰撞', collisions === 0, `碰撞 ${collisions} 次`);

// 不同学号的码互不通用
let crossOk = 0;
for (let i = 0; i < 50; i += 1) {
  const a = `20254040${String(10000 + i)}`;
  const b = `20254040${String(20000 + i)}`;
  const c = generateLicenseCode(a);
  if (checkCodeForStudent({ code: c, studentId: b }).status === 'granted') crossOk += 1;
}
t('50 组交叉验证：无一组错配', crossOk === 0, `错配 ${crossOk} 组`);

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
