// 在 APK 的 Hermes bundle 里**精确**找万能码，避免命中警告文案里的巧合子串。
//
// ⚠️ 公开仓库版（2026-10）：要搜的码不再写死，从环境变量取 ——
//     用法：EXPO_PUBLIC_MASTER_CODE=你的码 node tools/check-master-code-bundle.cjs <apk>
const fs = require('fs');
const zlib = require('zlib');

const apk = process.argv[2] ?? '';
if (!apk) {
  console.error('  × 用法：node tools/check-master-code-bundle.cjs <apk路径>');
  process.exit(2);
}
const buf = fs.readFileSync(apk);

let e = -1;
for (let i = buf.length - 22; i >= 0; i -= 1) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    e = i;
    break;
  }
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
const l1 = buf.readUInt16LE(bun.lo + 26);
const l2 = buf.readUInt16LE(bun.lo + 28);
const raw = buf.subarray(bun.lo + 30 + l1 + l2, bun.lo + 30 + l1 + l2 + bun.cs);
const data = bun.m === 0 ? raw : zlib.inflateRawSync(raw);
const s = data.toString('latin1');

console.log(`  APK: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
console.log('');

// 精确找所有出现处，并判断是不是"值"
/** 要搜的码：优先环境变量（仓库里没有真实值） */
const target = process.env.EXPO_PUBLIC_MASTER_CODE || '';
if (!target) {
  console.error('  × 没设 EXPO_PUBLIC_MASTER_CODE —— 公开仓库里没有内置码，得由你提供');
  process.exit(2);
}
const hits = [];
let i = -1;
while ((i = s.indexOf(target, i + 1)) !== -1) hits.push(i);

console.log(`  "${target}" 出现 ${hits.length} 次：`);
let real = 0;
for (const at of hits) {
  const before = s.slice(Math.max(0, at - 30), at);
  const after = s.slice(at + target.length, at + target.length + 20);
  // RN 警告文案里是 "...%<那个码>Height..." 这种，前后都是字母
  const prevChar = s[at - 1] ?? '';
  const nextChar = s[at + target.length] ?? '';
  const looksLikeValue = !/[A-Za-z]/.test(prevChar) && !/[A-Za-z]/.test(nextChar);
  if (looksLikeValue) real += 1;
  console.log(
    `    ${looksLikeValue ? '★ 像常量值' : '· 警告文案'}  ...${before.replace(/[^\x20-\x7E]/g, '·')}[${target}]${after.replace(/[^\x20-\x7E]/g, '·')}...`,
  );
}

console.log('');
console.log(`  结论：像常量值的 ${real} 处`);
const oldHits = (s.match(/['"]jcnb['"]/g) ?? []).length;
console.log(`  旧码 'jcnb' 作为字面量出现：${oldHits} 次 ${oldHits === 0 ? '（已清除）' : '（仍有残留）'}`);
console.log('');
console.log(real >= 1 && oldHits === 0 ? '  ✅ 新码已进包、旧码已清除' : '  ❌ 需检查');
