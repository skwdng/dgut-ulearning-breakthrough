// 精确验证：EXPO_PUBLIC_YOUXUE_ADAPTER 到底有没有被内联进 bundle。
//
// 为什么之前误判了：
//   我用 latin1 搜 "youxue"，命中的是**类名** YouxueCheckinAdapter 的一部分，
//   而不是环境变量的值。必须搜 **UTF-16** 形式的独立字符串 "youxue"。
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const WS = path.resolve(__dirname, '..');
const apk = process.argv[2] ?? path.join(WS, 'LifeKit-v0.3.0-universal.apk');

const buf = fs.readFileSync(apk);
let e = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
  if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
}
const count = buf.readUInt16LE(e + 10);
let off = buf.readUInt32LE(e + 16);
let bun = null;
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
  if (name.includes('index.android.bundle')) bun = { m, cs, lo };
}
const lnl = buf.readUInt16LE(bun.lo + 26);
const lel = buf.readUInt16LE(bun.lo + 28);
const ds = bun.lo + 30 + lnl + lel;
const raw = buf.subarray(ds, ds + bun.cs);
const data = bun.m === 0 ? raw : zlib.inflateRawSync(raw);
const s = data.toString('latin1');
const u16 = data.toString('utf16le');

console.log('文件:', path.basename(apk));
console.log('bundle 解压后:', (data.length / 1024 / 1024).toFixed(2), 'MB');
console.log('');

console.log('═══ ① 环境变量是否被内联 ═══');
// 关键判据：如果 EXPO_PUBLIC_YOUXUE_ADAPTER=youxue 被正确内联，
// currentAdapterKind() 会变成 raw === "youxue" 这样的字面量比较。
// 反过来，如果没内联，会保留 process.env 访问或退化成 undefined。
const hasProcessEnv = s.includes('EXPO_PUBLIC_YOUXUE_ADAPTER');
console.log('  bundle 里还有 process.env.EXPO_PUBLIC_YOUXUE_ADAPTER 吗:', hasProcessEnv ? '★ 有（没被内联！）' : '没有（已被静态替换）');

// Hermes 字符串表里的独立 "youxue"
const u16HasYouxue = u16.includes('youxue');
console.log('  UTF-16 里存在独立字符串 "youxue":', u16HasYouxue ? '√' : '×');

// 找出 youxue 出现的上下文（用 UTF-16 索引反推 latin1 位置）
const idx = data.indexOf(Buffer.from('youxue', 'utf16le'));
if (idx >= 0) {
  const around = data.subarray(Math.max(0, idx - 120), idx + 60);
  console.log('  UTF-16 命中上下文:');
  console.log('    ' + around.toString('utf16le').replace(/\0/g, '·').slice(0, 120));
}

console.log('');
console.log('═══ ② 旧的 mock 提示文案是否还在（判断包的新旧）═══');
const oldText = '把 .env 里的 EXPO_PUBLIC_YOUXUE_ADAPTER 改成';
const newText = '当前是 MOCK 模式（假数据）';
console.log('  旧文案（v0.3.0 前的 bind 页版本）:', u16.includes(oldText) ? '★ 还在' : '不在');
console.log('  新文案（v0.3.0 首页横幅）:', u16.includes(newText) ? '√ 在' : '★ 不在');

console.log('');
console.log('═══ ③ 结论 ═══');
if (hasProcessEnv) {
  console.log('  ★ 环境变量没有被内联 —— 所以运行时读到 undefined，退回 mock。');
  console.log('     原因通常是：Metro 缓存、或 .env 没在打包时被加载。');
} else if (!u16HasYouxue) {
  console.log('  ★ 既没有 process.env 也没有 "youxue" 字面量 —— 说明打的是旧包。');
} else {
  console.log('  √ 环境变量已内联为 "youxue"，包是对的。');
  console.log('    如果设备上仍显示 mock，那问题在别处（例如 Metro 缓存、或装了旧包）。');
}
