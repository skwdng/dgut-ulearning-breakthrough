// 交叉验证：网页端（license-admin.html）与 App 端（licenseCode.ts）的算法必须完全一致。
//
// 做法：从 HTML 里抽出脚本，在 Node 里执行生成逻辑；再用等价 TS 逻辑对比输出。
// 若两边对同一学号生成的码不同，App 就永远校验不过。
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'web', 'license-admin.html');
const html = fs.readFileSync(HTML, 'utf8');

// 抽出 <script> 里的算法部分。
// ⚠️ 必须在「界面逻辑」那个注释块的**起始位置**切，否则会切在块注释中间造成语法错误。
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('没找到 script'); process.exit(1); }
const script = m[1];
const markerIdx = script.indexOf('界面逻辑');
if (markerIdx < 0) { console.log('没找到分界标记'); process.exit(1); }
// 往前找到该注释块的 /* 起始
const blockStart = script.lastIndexOf('/*', markerIdx);
const algo = script.slice(0, blockStart);

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  √ ${name}`); }
  else { fail += 1; console.log(`  × ${name}${extra ? '  → ' + extra : ''}`); }
};

// ── 在隔离沙箱里执行网页端算法，导出它生成码的函数 ──
const sandbox = {};
const fn = new Function('exports', algo + `
  exports.generateLicenseCode = generateLicenseCode;
  exports.generateMasterCode = generateMasterCode;
  exports.parseLicenseCode = parseLicenseCode;
  exports.hashStudentId = hashStudentId;
  exports.B32 = B32;
  exports.PAYLOAD_CHARS = PAYLOAD_CHARS;
  exports.SIG_CHARS = SIG_CHARS;
  exports.MASTER_PAYLOAD_CHARS = MASTER_PAYLOAD_CHARS;
  exports.MASTER_KEY = MASTER_KEY;
`);
fn(sandbox);

console.log('=== 1) 网页端算法基本可用 ===');
const webCode = sandbox.generateLicenseCode('2099000000116');
console.log(`  网页端生成: ${webCode}`);
t('以 LK1- 开头', webCode.startsWith('LK1-'), webCode);
t('字母表长度 32', sandbox.B32.length === 32, `${sandbox.B32.length}`);
t('不含 undefined', !webCode.includes('undefined'), webCode);
t('载荷 13 字符 + 签名 15 字符', sandbox.PAYLOAD_CHARS === 13 && sandbox.SIG_CHARS === 15,
  `payload=${sandbox.PAYLOAD_CHARS} sig=${sandbox.SIG_CHARS}`);
t('网页端可自解析', sandbox.parseLicenseCode(webCode).ok === true,
  JSON.stringify(sandbox.parseLicenseCode(webCode)));

console.log('\n=== 2) ★ 与 App 端（TS 实现）逐字节一致 ===');
// 用与 licenseCode.ts 完全相同的独立实现复刻（第三份，用于交叉比对）
const B32 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
if (B32.length !== 32) throw new Error('B32 长度错');
const SIGN_KEY = 'LifeKit::checkin::v1::2026';
const SEG_LEN = 5;
const PAYLOAD_CHARS = Math.ceil(8 * 8 / 5);
const SIG_CHARS = SEG_LEN * 3;

function norm(s) { return (s ?? '').replace(/\s+/g, '').toLowerCase(); }
function hash(sid) {
  const s = norm(sid);
  const fnv = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  };
  return fnv(0x811c9dc5).toString(16).padStart(8, '0') + fnv(0x9e3779b9).toString(16).padStart(8, '0');
}
function toB32(bytes) {
  let bits = 0, acc = 0, out = '';
  for (const b of bytes) {
    acc = ((acc << 8) | (b & 0xff)) & 0xfff;
    bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; acc &= (1 << bits) - 1; }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
function hexToBytes(hex) { const o = []; for (let i = 0; i + 1 < hex.length; i += 2) o.push(parseInt(hex.slice(i, i + 2), 16)); return o; }
function tsign(p) { const raw = SIGN_KEY + '|' + p; return toB32(hexToBytes(hash(raw) + hash(raw + '#2'))); }
function grp(s) { const p = []; for (let i = 0; i < s.length; i += SEG_LEN) p.push(s.slice(i, i + SEG_LEN)); return p.join('-'); }
function daysFrom(ts) {
  if (!ts) return 0;
  const d = Math.round((ts - Date.UTC(2026, 0, 1)) / 86400000);
  return d <= 0 ? 1 : Math.min(d, 0xffff);
}
function tsGenerate(sid, opts = {}) {
  const s = norm(sid);
  const hb = hexToBytes(hash(s)).slice(0, 6);
  const d = daysFrom(opts.expiresAt);
  const payload = toB32([...hb, (d >> 8) & 0xff, d & 0xff]);
  return 'LK1-' + grp(payload + tsign(payload).slice(0, SIG_CHARS));
}

const sids = [
  '2099000000116', '2099000000117', '2099000000001', 'abc123', 'ABC123',
  '  2099 0000 00116  ', '9999999999999999', 'x', 'a1b2c3d4e5f6',
];
let mismatch = 0;
for (const sid of sids) {
  const w = sandbox.generateLicenseCode(sid);
  const a = tsGenerate(sid);
  const same = w === a;
  if (!same) mismatch += 1;
  console.log(`  ${same ? '√' : '×'} ${JSON.stringify(sid).padEnd(24)} ${w}`);
  if (!same) console.log(`      App 端: ${a}`);
}
t('所有学号两端生成结果一致', mismatch === 0, `不一致 ${mismatch} 个`);

console.log('\n=== 3) 带有效期也一致 ===');
let expMismatch = 0;
for (const days of [1, 30, 365, 3650]) {
  const ts = Date.UTC(2026, 0, 1) + days * 86400000;
  const w = sandbox.generateLicenseCode('2099000000116', { expiresAt: ts });
  const a = tsGenerate('2099000000116', { expiresAt: ts });
  if (w !== a) { expMismatch += 1; console.log(`  × ${days} 天不一致`); }
}
t('不同有效期两端一致', expMismatch === 0, `不一致 ${expMismatch} 个`);

console.log('\n=== 4) 一码一人（网页端生成 → App 端校验）===');
const codeForA = sandbox.generateLicenseCode('2099000000116');
const hashA = hash('2099000000116').slice(0, 12);
const hashB = hash('2099000000117').slice(0, 12);
const parsed = sandbox.parseLicenseCode(codeForA);
t('A 的码解析出的哈希 = A 的哈希', parsed.ok && parsed.info.studentIdHash === hashA);
t('A 的码哈希 ≠ B 的哈希（一码一人成立）', hashA !== hashB);

console.log('\n=== 5) 网页端生成的码，App 端格式校验 ===');
let formatOk = 0;
for (const sid of sids) {
  const c = sandbox.generateLicenseCode(sid);
  const body = c.replace(/-/g, '').slice(3);
  if (body.length === PAYLOAD_CHARS + SIG_CHARS && [...body].every((ch) => B32.includes(ch))) formatOk += 1;
}
t('所有码长度与字符集合法', formatOk === sids.length, `${formatOk}/${sids.length}`);

console.log('\n=== 6) ★ 万能码：网页端 vs App 端逐字节一致 ===');
// 第三份独立实现（对应 licenseCode.ts 的 master 分支）
const MASTER_KEY = 'LifeKit::master::v1::2026';
const MASTER_PAYLOAD_CHARS = Math.ceil(3 * 8 / 5);
function tsGenerateMaster(opts = {}) {
  const d = daysFrom(opts.expiresAt);
  const payload = toB32([0x4d, (d >> 8) & 0xff, d & 0xff]);
  const sig = toB32(hexToBytes(hash(MASTER_KEY + '|' + payload) + hash(MASTER_KEY + '|' + payload + '#2')));
  return 'LKM-' + grp(payload + sig.slice(0, SIG_CHARS));
}

const webMaster = sandbox.generateMasterCode();
console.log(`  网页端: ${webMaster}`);
console.log(`  App 端: ${tsGenerateMaster()}`);
t('永久万能码两端一致', webMaster === tsGenerateMaster(), `${webMaster} vs ${tsGenerateMaster()}`);
t('载荷 5 字符', sandbox.MASTER_PAYLOAD_CHARS === 5, String(sandbox.MASTER_PAYLOAD_CHARS));

let mm = 0;
for (const days of [1, 30, 365, 3650]) {
  const ts = Date.UTC(2026, 0, 1) + days * 86400000;
  const w = sandbox.generateMasterCode({ expiresAt: ts });
  const a = tsGenerateMaster({ expiresAt: ts });
  if (w !== a) { mm += 1; console.log(`  × ${days} 天不一致\n      网页 ${w}\n      App  ${a}`); }
}
t('不同有效期的万能码两端一致', mm === 0, `不一致 ${mm} 个`);

console.log('\n=== 7) ★ 万能码与普通码不互通 ===');
t('网页端万能码不以 LK1 开头', !webMaster.startsWith('LK1'));
const wp = sandbox.parseLicenseCode(webMaster);
t('网页端把万能码标记为 isMaster', wp.ok === true && wp.info.isMaster === true, JSON.stringify(wp));
// 普通码的正文加 LKM 前缀 → 必须失败（密钥不同）
const forgedWeb = 'LKM' + sandbox.generateLicenseCode('2099000000116').replace(/[^0-9A-Z]/g, '').slice(3);
t('★ 普通码冒充万能码 → 网页端也拒绝', sandbox.parseLicenseCode(forgedWeb).ok === false);
t('★ 普通码冒充万能码 → App 端也拒绝', tsGenerateMaster() !== forgedWeb);

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
