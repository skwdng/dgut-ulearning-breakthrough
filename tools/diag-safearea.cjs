// 查清楚：安全区失效的确切原因。
//
// 三个问题：
//   1. 我写的 paddingTop 到底有没有进 bundle
//   2. react-native-safe-area-context 的原生模块在不在 APK 里
//   3. SafeAreaProvider 有没有可能在鸿蒙上拿不到 inset
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const WS = path.resolve(__dirname, '..');
const apk = path.join(WS, 'LifeKit-v0.2.1-universal.apk');

console.log('① bundle 里有没有我的安全区代码');
const buf = fs.readFileSync(apk);
let e = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
  if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
}
const count = buf.readUInt16LE(e + 10);
let off = buf.readUInt32LE(e + 16);
let bundleEnt = null;
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
  if (name.includes('index.android.bundle')) bundleEnt = { name, m, cs, lo };
}
if (!bundleEnt) { console.log('  × 找不到 bundle'); process.exit(1); }
const lnl = buf.readUInt16LE(bundleEnt.lo + 26);
const lel = buf.readUInt16LE(bundleEnt.lo + 28);
const ds = bundleEnt.lo + 30 + lnl + lel;
const raw = buf.subarray(ds, ds + bundleEnt.cs);
const data = bundleEnt.m === 0 ? raw : zlib.inflateRawSync(raw);
const s = data.toString('latin1');
console.log('  bundle 大小:', (data.length / 1024 / 1024).toFixed(2), 'MB');

// Hermes 字节码里字符串仍以明文存在，可以搜关键字
const probes = [
  ['useSafeAreaInsets', '我的 inset 调用'],
  ['SafeAreaProvider', '安全区 Provider'],
  ['SafeAreaInsetsContext', '安全区 Context'],
  ['react-native-safe-area-context', '安全区库'],
];
for (const [k, label] of probes) {
  console.log(`  ${s.includes(k) ? '√' : '×'} ${label.padEnd(20)} ${k}`);
}

console.log('\n② APK 里有没有安全区的原生代码');
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
for (const [k, label] of [
  ['safeareacontext', '安全区原生包'],
  ['SafeAreaContext', 'SafeAreaContext 类'],
  ['SafeAreaProvider', 'SafeAreaProvider 类'],
  ['StatusBarModule', 'RN StatusBar 原生模块'],
]) {
  console.log(`  ${all.includes(k) ? '√' : '×'} ${label.padEnd(20)} ${k}`);
}

console.log('\n③ 结论提示');
console.log('  如果 ① 全是 √ 而 ② 有 ×，说明 JS 调了但原生模块不在 → inset 恒为 0');
console.log('  如果 ①② 都齐全，那就是鸿蒙上 SafeAreaProvider 拿不到 inset → 用 StatusBar.currentHeight 兜底');
