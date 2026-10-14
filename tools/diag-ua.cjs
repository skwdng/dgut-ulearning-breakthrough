// 验证 v0.3.4 的 bundle 里用的是桌面 UA（登录页问题的修复）。
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const apk = process.argv[2] ?? path.join(__dirname, '..', 'LifeKit-v0.3.4-universal.apk');
const buf = fs.readFileSync(apk);
let e = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
  if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
}
const count = buf.readUInt16LE(e + 10);
let off = buf.readUInt32LE(e + 16);
let bun = null;
const names = [];
for (let i = 0; i < count; i += 1) {
  if (buf.readUInt32LE(off) !== 0x02014b50) break;
  const m = buf.readUInt16LE(off + 10);
  const cs = buf.readUInt32LE(off + 20);
  const nl = buf.readUInt16LE(off + 28);
  const el = buf.readUInt16LE(off + 30);
  const cl = buf.readUInt16LE(off + 32);
  const lo = buf.readUInt32LE(off + 42);
  const name = buf.subarray(off + 46, off + 46 + nl).toString('utf8');
  off += 46 + nl + el + cl;
  names.push(name);
  if (name.includes('index.android.bundle')) bun = { m, cs, lo };
}
const lnl = buf.readUInt16LE(bun.lo + 26);
const lel = buf.readUInt16LE(bun.lo + 28);
const ds = bun.lo + 30 + lnl + lel;
const raw = buf.subarray(ds, ds + bun.cs);
const data = bun.m === 0 ? raw : zlib.inflateRawSync(raw);
const s = data.toString('latin1');

const abis = [...new Set(names.filter((n) => n.startsWith('lib/')).map((n) => n.split('/')[1]))];

console.log('文件:', path.basename(apk));
console.log('  APK:', (buf.length / 1024 / 1024).toFixed(1), 'MB');
console.log('  架构:', abis.join(', '));
console.log('  bundle:', (data.length / 1024 / 1024).toFixed(2), 'MB');
console.log('');

const checks = [
  ['Windows NT 10.0', '桌面 UA 已进包', true],
  ['Android 13; Pixel 6', '旧手机 UA（应该没了）', false],
  ['Mobile Safari', '手机 UA 特征（应该没了）', false],
  ['text/html', '浏览器风格 Accept', true],
  ['pwdEncryptSalt', 'CAS 隐藏域解析代码', true],
  ['execution', 'CAS execution 字段', true],
  ['lms.dgut.edu.cn', '优学院域名', true],
  ['auth.dgut.edu.cn', '认证域名', true],
];

console.log('=== 检查项 ===');
let ok = true;
for (const [needle, label, want] of checks) {
  const has = s.includes(needle);
  const pass = has === want;
  if (!pass) ok = false;
  console.log(`  ${pass ? '√' : '×'} ${label.padEnd(26)} "${needle}" ${has ? '存在' : '不存在'}`);
}

console.log('');
console.log(ok ? '√ 全部符合预期' : '× 有不符预期的项');
process.exit(ok ? 0 : 1);
