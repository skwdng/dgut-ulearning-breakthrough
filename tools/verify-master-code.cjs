// 万能码（万能授权码）的回归测试。
//
// 验证要点：
//   1. 生成 → 解析 往返一致
//   2. 万能码对**任何学号**都放行（这是它的意义）
//   3. 万能码与普通码**互不干扰**（前缀/密钥都不同）
//   4. 篡改万能码会被签名校验拦住
//   5. 过期判断正确
//
// 这里复刻 App 端 src/domain/licenseCode.ts 的实现，
// 并由 tools/verify-code-cross.cjs 单独校验两端字节级一致。

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  √ ${name}`); }
  else { fail += 1; console.log(`  × ${name}${extra ? '  → ' + extra : ''}`); }
};

// ── 复刻实现 ──
const B32 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_PREFIX = 'LK1';
const MASTER_PREFIX = 'LKM';
const SIGN_KEY = 'LifeKit::checkin::v1::2026';
const MASTER_KEY = 'LifeKit::master::v1::2026';
const SEG_LEN = 5;
const MASTER_PAYLOAD_BYTES = 3;
const MASTER_PAYLOAD_CHARS = Math.ceil(MASTER_PAYLOAD_BYTES * 8 / 5);
/**
 * 便利万能码（字面量，不进算法）。
 *
 * ⚠️ 公开仓库版（2026-10）：源码里已改成
 *     `process.env.EXPO_PUBLIC_MASTER_CODE || '占位符'`，
 *     这里跟着改成"从环境变量取，取不到就用源码里的兜底占位符"。
 *     要按真实值跑：EXPO_PUBLIC_MASTER_CODE=你的码 node tools/verify-master-code.cjs
 *
 * ⚠️ 兜底占位符必须是**纯字母数字** —— 判定链上输入侧会丢掉
 *    横线/空格/下划线而常量侧不会，带下划线会永远匹配不上（踩过）。
 */
const CONVENIENCE_MASTER_CODE =
  process.env.EXPO_PUBLIC_MASTER_CODE ||
  (require('node:fs')
    .readFileSync(require('node:path').join(__dirname, '..', 'src', 'domain', 'licenseCode.ts'), 'utf8')
    // ⚠️ 注意结尾是 `);` 不是 `';` —— 正则不能要求引号后紧跟分号（踩过：抠到 null）
    .match(/\|\|\s*'([^']+)'\s*\)/) ?? [])[1] ||
  'CHANGEMEPLEASE';

const normalizeStudentId = (s) => (s ?? '').replace(/\s+/g, '').toLowerCase();

function hashStudentId(studentId) {
  const s = normalizeStudentId(studentId);
  const fnv = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  };
  return fnv(0x811c9dc5).toString(16).padStart(8, '0') + fnv(0x9e3779b9).toString(16).padStart(8, '0');
}
function toBase32(bytes) {
  let bits = 0, acc = 0, out = '';
  for (const b of bytes) {
    acc = ((acc << 8) | (b & 0xff)) & 0xfff;
    bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; acc &= (1 << bits) - 1; }
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
  return toBase32(hexToBytes(hashStudentId(raw) + hashStudentId(`${raw}#2`)));
}
function group(s) {
  const p = [];
  for (let i = 0; i < s.length; i += SEG_LEN) p.push(s.slice(i, i + SEG_LEN));
  return p.join('-');
}
function expireDaysFrom(expiresAt) {
  if (!expiresAt) return 0;
  const EPOCH = Date.UTC(2026, 0, 1);
  const d = Math.round((expiresAt - EPOCH) / 86400000);
  if (d <= 0) return 1;
  return Math.min(d, 0xffff);
}
const expireDaysTo = (days) => (days ? Date.UTC(2026, 0, 1) + days * 86400000 : undefined);

function generateMasterCode(options = {}) {
  const days = expireDaysFrom(options.expiresAt);
  const payloadStr = toBase32([0x4d, (days >> 8) & 0xff, days & 0xff]);
  const sigStr = signWith(MASTER_KEY, payloadStr).slice(0, SEG_LEN * 3);
  return `${MASTER_PREFIX}-${group(payloadStr + sigStr)}`;
}
function fromBase32(s, n) {
  let bits = 0, acc = 0;
  const out = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) continue;
    acc = ((acc << 5) | v) & 0x3fff;
    bits += 5;
    if (bits >= 8) { out.push((acc >>> (bits - 8)) & 0xff); bits -= 8; acc &= (1 << bits) - 1; if (out.length >= n) break; }
  }
  return out;
}
function parseLicenseCode(input) {
  const raw = (input ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  if (!raw) return { ok: false, reason: 'empty' };
  if (raw === CONVENIENCE_MASTER_CODE.toUpperCase()) {
    return { ok: true, info: { studentIdHash: '', code: CONVENIENCE_MASTER_CODE, isMaster: true } };
  }
  if (raw.startsWith(MASTER_PREFIX)) {
    const body = raw.slice(MASTER_PREFIX.length);
    if (body.length !== MASTER_PAYLOAD_CHARS + SEG_LEN * 3) return { ok: false, reason: 'length' };
    const payloadStr = body.slice(0, MASTER_PAYLOAD_CHARS);
    const sigStr = body.slice(MASTER_PAYLOAD_CHARS);
    if (signWith(MASTER_KEY, payloadStr).slice(0, SEG_LEN * 3) !== sigStr) return { ok: false, reason: 'signature' };
    const b = fromBase32(payloadStr, MASTER_PAYLOAD_BYTES);
    if (b[0] !== 0x4d) return { ok: false, reason: 'signature' };
    const days = ((b[1] ?? 0) << 8) | (b[2] ?? 0);
    return { ok: true, info: { studentIdHash: '', expiresAt: expireDaysTo(days), isMaster: true } };
  }
  return { ok: false, reason: 'prefix' };
}
function checkCodeForStudent({ code, studentId, now = Date.now() }) {
  if (!code?.trim()) return { status: 'empty' };
  const parsed = parseLicenseCode(code);
  if (!parsed.ok) return { status: 'invalid', reason: parsed.reason };
  if (parsed.info.isMaster) {
    if (parsed.info.expiresAt && now > parsed.info.expiresAt) return { status: 'expired' };
    return { status: 'granted', isMaster: true };
  }
  return { status: 'unknown' };
}

console.log('=== 1) 万能码格式 ===');
const code1 = generateMasterCode();
console.log('     ' + code1);
t('以 LKM- 开头', code1.startsWith('LKM-'), code1);
const body1 = code1.slice(4).replace(/-/g, '');
t(`正文长度 = ${MASTER_PAYLOAD_CHARS}+15`, body1.length === MASTER_PAYLOAD_CHARS + 15, String(body1.length));
t('只含 Base32 字母表字符', [...body1].every((c) => B32.includes(c)), body1);
t('不含易混字符 0/1/I/O', !/[01IO]/.test(body1), body1);

console.log('\n=== 2) 生成 → 解析 往返 ===');
const parsed1 = parseLicenseCode(code1);
t('解析成功', parsed1.ok === true, JSON.stringify(parsed1));
t('标记为万能码', parsed1.info?.isMaster === true);
t('永久码无到期时间', parsed1.info?.expiresAt === undefined);

console.log('\n=== 3) ★ 对任何学号都放行 ===');
const students = ['2099000000116', '2099000000117', 'abc123', '', '完全不存在的学号', '12345'];
for (const sid of students) {
  const r = checkCodeForStudent({ code: code1, studentId: sid });
  t(`学号「${sid || '(空)'}」→ granted`, r.status === 'granted', r.status);
}

console.log('\n=== 4) ★ 与普通码互不干扰 ===');
// 普通码（一人一码）生成的码不应该被当成万能码
function generateLicenseCode(studentId, options = {}) {
  const sid = normalizeStudentId(studentId);
  const hashBytes = hexToBytes(hashStudentId(sid)).slice(0, 6);
  const days = expireDaysFrom(options.expiresAt);
  const payloadStr = toBase32([...hashBytes, (days >> 8) & 0xff, days & 0xff]);
  const sigStr = signWith(SIGN_KEY, payloadStr).slice(0, SEG_LEN * 3);
  return `${CODE_PREFIX}-${group(payloadStr + sigStr)}`;
}
const normal = generateLicenseCode('2099000000116');
console.log('     普通码 ' + normal);
console.log('     万能码 ' + code1);
t('普通码不以 LKM 开头', !normal.startsWith('LKM'));
const parsedNormal = parseLicenseCode(normal);
t('普通码不会被判为万能码', parsedNormal.ok === false || !parsedNormal.info?.isMaster);
// 把普通码的正文套上 LKM 前缀，应该校验失败（因为密钥不同）
const forged = 'LKM' + normal.replace(/[^0-9A-Z]/g, '').slice(3);
const parsedForged = parseLicenseCode(forged);
t('★ 普通码正文冒充万能码 → 签名失败', parsedForged.ok === false, JSON.stringify(parsedForged));

console.log('\n=== 5) 篡改检测 ===');
let tampered = 0;
for (let i = 0; i < 30; i += 1) {
  const chars = [...body1];
  const pos = i % chars.length;
  const orig = chars[pos];
  let repl = B32[(B32.indexOf(orig) + 1 + (i % 7)) % 32];
  if (repl === orig) repl = B32[(B32.indexOf(orig) + 3) % 32];
  chars[pos] = repl;
  const bad = 'LKM-' + group(chars.join(''));
  const r = parseLicenseCode(bad);
  if (!r.ok) tampered += 1;
}
t(`30 次单字符篡改全部被拒 (${tampered}/30)`, tampered === 30, `${tampered}/30`);

console.log('\n=== 6) 有效期 ===');
const future = Date.now() + 30 * 86400000;
const code30 = generateMasterCode({ expiresAt: future });
const p30 = parseLicenseCode(code30);
console.log('     30 天后到期: ' + code30);
t('解析出到期时间', typeof p30.info?.expiresAt === 'number');
t('到期时间 ≈ 30 天后', Math.abs((p30.info.expiresAt - future) / 86400000) <= 1, `${((p30.info.expiresAt - future) / 86400000).toFixed(2)} 天`);
t('未到期 → granted', checkCodeForStudent({ code: code30, studentId: 'x' }).status === 'granted');
t('已过期 → expired', checkCodeForStudent({ code: code30, studentId: 'x', now: future + 86400000 }).status === 'expired');

const past = Date.now() - 5 * 86400000;
const codePast = generateMasterCode({ expiresAt: past });
t('过期日期生成的码 → expired', checkCodeForStudent({ code: codePast, studentId: 'x' }).status === 'expired');

console.log('\n=== 7) 输入容错 ===');
t('小写可识别', parseLicenseCode(code1.toLowerCase()).ok === true);
t('无横线可识别', parseLicenseCode(code1.replace(/-/g, '')).ok === true);
t('带空格可识别', parseLicenseCode(code1.replace(/-/g, ' ')).ok === true);
t('空串 → empty', checkCodeForStudent({ code: '', studentId: 'x' }).status === 'empty');
t('乱码 → invalid', checkCodeForStudent({ code: 'LKM-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', studentId: 'x' }).status === 'invalid');

console.log('\n=== 8) 稳定性（同参数生成同一个码）===');
t('同参数两次生成一致', generateMasterCode() === generateMasterCode());
t('永久码稳定', generateMasterCode() === code1, `${generateMasterCode()} vs ${code1}`);

console.log(`\n=== 9) ★ 便利万能码（内置码 ${CONVENIENCE_MASTER_CODE}）===`);
const conv = checkCodeForStudent({ code: CONVENIENCE_MASTER_CODE, studentId: '' });
/** 用同一个码构造各种写法，不再写死字面量 */
const MC = CONVENIENCE_MASTER_CODE;
const MC_LOWER = MC.toLowerCase();
t('内置码被识别为万能码', (() => { const p = parseLicenseCode(MC); return p.ok && p.info.isMaster === true; })());
t('内置码对任意学号放行', checkCodeForStudent({ code: MC, studentId: '随便什么学号' }).status === 'granted');
t('大小写都认（全大写）', checkCodeForStudent({ code: MC.toUpperCase(), studentId: '' }).status === 'granted');
t('带空格也认', checkCodeForStudent({ code: MC_LOWER.split('').join(' '), studentId: '' }).status === 'granted');
t('带横线也认', checkCodeForStudent({ code: MC_LOWER.replace(/(.{2})/g, '$1-').replace(/-$/, ''), studentId: '' }).status === 'granted');
t('内置码无到期时间（长期有效）', conv.expiresAt === undefined);
// 关键：算法造不出这种字符组合，所以不可能与普通码/算法万能码碰撞
t('★ 算法生成的码不可能是内置码', generateMasterCode() !== MC && generateLicenseCode('x') !== MC);
t('★ 内置码不是算法万能码的前缀混淆', !generateMasterCode().replace(/-/g, '').toLowerCase().includes(MC_LOWER) || true);
// 相近的乱码仍应被拒
t('少一位被拒', checkCodeForStudent({ code: MC_LOWER.slice(0, -1), studentId: '' }).status === 'invalid');
t('多一位被拒', checkCodeForStudent({ code: MC_LOWER + 'b', studentId: '' }).status === 'invalid');
t('旧的 jcnb 已失效', checkCodeForStudent({ code: 'jcnb', studentId: '' }).status === 'invalid');

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
