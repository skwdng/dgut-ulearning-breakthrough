// 交付前检查：确认 APK 里各项关键配置都在。
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const WS = path.resolve(__dirname, '..');
const apk = process.argv[2] ?? path.join(WS, 'LifeKit-v0.3.7-universal.apk');

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
const l1 = buf.readUInt16LE(bun.lo + 26);
const l2 = buf.readUInt16LE(bun.lo + 28);
const raw = buf.subarray(bun.lo + 30 + l1 + l2, bun.lo + 30 + l1 + l2 + bun.cs);
const data = bun.m === 0 ? raw : zlib.inflateRawSync(raw);
const s = data.toString('latin1');
const u16 = data.toString('utf16le');

const abis = [...new Set(names.filter((n) => n.startsWith('lib/')).map((n) => n.split('/')[1]))];

const appJson = JSON.parse(fs.readFileSync(path.join(WS, 'app.json'), 'utf8'));
const gradle = fs.readFileSync(path.join(WS, 'android', 'app', 'build.gradle'), 'utf8');
const cfg = fs.readFileSync(path.join(WS, 'src', 'config', 'buildConfig.ts'), 'utf8');
const adapter = (cfg.match(/ADAPTER\s*:\s*AdapterKind\s*=\s*'(\w+)'/) ?? [])[1] ?? '(未知)';
const versionCode = (gradle.match(/versionCode\s+(\d+)/) ?? [])[1] ?? '(未知)';

console.log('文件:', path.basename(apk));
console.log('  APK 大小:', (buf.length / 1024 / 1024).toFixed(1), 'MB');
console.log('  支持架构:', abis.join(', '));
console.log('  App 版本:', appJson.expo.version);
console.log('  versionCode:', versionCode);
console.log('  适配器:', adapter);
console.log('');

const checks = [
  ['桌面 UA', s.includes('Windows NT 10.0')],
  ['无手机 UA', !s.includes('Android 13; Pixel 6')],
  ['text/html Accept', s.includes('text/html')],
  ['CAS 表单解析', s.includes('pwdEncryptSalt')],
  ['多地址兜底（报错文案）', u16.includes('各地址实测结果')],
  ['CAS 错误提示提取', u16.includes('学校返回')],
  ['真实适配器类', s.includes('YouxueCheckinAdapter')],
  ['优学院域名', s.includes('lms.dgut.edu.cn')],
  ['外卖原生模块', null], // 需要查 dex，单独处理
];

console.log('=== 关键项 ===');
let ok = adapter === 'youxue';
for (const [label, pass] of checks) {
  if (pass === null) continue;
  if (!pass) ok = false;
  console.log(`  ${pass ? '√' : '×'} ${label}`);
}

// dex 里找原生模块
const dexEntries = [];
off = buf.readUInt32LE(e + 16);
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
  if (/^classes\d*\.dex$/.test(name)) dexEntries.push({ name, m, cs, lo });
}
let all = '';
for (const en of dexEntries) {
  const a = buf.readUInt16LE(en.lo + 26);
  const b = buf.readUInt16LE(en.lo + 28);
  const st = en.lo + 30 + a + b;
  const r = buf.subarray(st, st + en.cs);
  all += (en.m === 0 ? r : zlib.inflateRawSync(r)).toString('latin1');
}
const hasDelivery = all.includes('com/lifekit/delivery');
const hasScreens = all.includes('reactnative/screens');
if (!hasDelivery || hasScreens) ok = false;
console.log(`  ${hasDelivery ? '√' : '×'} 外卖通知原生模块`);
console.log(`  ${!hasScreens ? '√' : '×'} 无原生导航残留`);

console.log('');
console.log(ok ? '✅ 全部通过，可以交付' : '❌ 有问题，勿交付');
process.exit(ok ? 0 : 1);
