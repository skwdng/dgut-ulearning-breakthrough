/**
 * 确认某个原生模块**真的进了 APK**。
 *
 * ══════════ 为什么要单独验 ══════════
 * 踩过的坑：装了新依赖、`npm install` 显示成功、构建也 BUILD SUCCESSFUL，
 * 但模块其实没被链接进去 —— 运行时才报 "Cannot find native module"。
 * 所以每次加原生依赖，都值得直接翻 APK 确认。
 *
 * 用法: node tools/verify-native-module.cjs <apk> <关键字...>
 */
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

const APK = process.argv[2];
const KEYS = process.argv.slice(3);

if (!APK || !KEYS.length) {
  console.log('  用法: node tools/verify-native-module.cjs <apk> <关键字...>');
  process.exit(2);
}
if (!fs.existsSync(APK)) {
  console.error(`  × 找不到 APK: ${APK}`);
  process.exit(1);
}

const buf = fs.readFileSync(APK);

// ── 读 zip 中央目录 ──
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i -= 1) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
if (eocd < 0) {
  console.error('  × 不是有效的 zip/APK');
  process.exit(1);
}
const count = buf.readUInt16LE(eocd + 10);
let o = buf.readUInt32LE(eocd + 16);
const entries = [];
for (let i = 0; i < count; i += 1) {
  if (buf.readUInt32LE(o) !== 0x02014b50) break;
  const method = buf.readUInt16LE(o + 10);
  const csize = buf.readUInt32LE(o + 20);
  const nameLen = buf.readUInt16LE(o + 28);
  const extraLen = buf.readUInt16LE(o + 30);
  const commentLen = buf.readUInt16LE(o + 32);
  const lo = buf.readUInt32LE(o + 42);
  const name = buf.subarray(o + 46, o + 46 + nameLen).toString('utf8');
  o += 46 + nameLen + extraLen + commentLen;
  entries.push({ name, method, csize, lo });
}

function readEntry(e) {
  const l1 = buf.readUInt16LE(e.lo + 26);
  const l2 = buf.readUInt16LE(e.lo + 28);
  const start = e.lo + 30 + l1 + l2;
  const raw = buf.subarray(start, start + e.csize);
  return e.method === 0 ? raw : zlib.inflateRawSync(raw);
}

console.log(`  APK: ${path.basename(APK)}`);
console.log(`  找关键字: ${KEYS.join(', ')}`);
console.log('');

// ── dex 里找（原生类名）──
const dexes = entries.filter((x) => x.name.endsWith('.dex'));
let dexText = '';
for (const d of dexes) {
  try {
    dexText += readEntry(d).toString('utf8');
  } catch {
    /* 单个 dex 解压失败不影响其他 */
  }
}

// ── JS bundle 里找（JS 侧引用）──
const bundleEntry = entries.find((x) => x.name.includes('index.android.bundle'));
let bundleText = '';
if (bundleEntry) {
  try {
    const raw = readEntry(bundleEntry);
    bundleText = `${raw.toString('utf8')}\n${raw.toString('utf16le')}`;
  } catch {
    /* 忽略 */
  }
}

let pass = 0;
let fail = 0;
for (const k of KEYS) {
  const inDex = dexText.includes(k);
  const inBundle = bundleText.includes(k);
  const where = [inDex ? 'dex' : null, inBundle ? 'bundle' : null].filter(Boolean).join(' + ');
  if (inDex || inBundle) {
    pass += 1;
    console.log(`  √ ${k}   （出现在 ${where}）`);
  } else {
    fail += 1;
    console.log(`  × ${k}   —— 没找到！模块可能没被链接`);
  }
}

console.log('');
console.log(`  dex 文件 ${dexes.length} 个，bundle ${bundleEntry ? '有' : '无'}`);
console.log(`  SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
