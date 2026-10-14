// 扫描 src 下的 ts/tsx 与 tools 下的 cjs，找出：
//   1. UTF-8 BOM（PowerShell Set-Content -Encoding utf8 会加）
//   2. GBK 乱码（UTF-8 被当 ANSI 读再写回）
const fs = require('fs');
const path = require('path');

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'android' || e.name === '.git' || e.name === 'tmp') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const roots = [__dirname + '/src', __dirname + '/tools'];
const files = [];
for (const r of roots) walk(r, files);

const targets = files.filter((f) => /\.(ts|tsx|cjs)$/.test(f));
let bom = 0;
let garbled = 0;

for (const f of targets) {
  const b = fs.readFileSync(f);
  const rel = f.replace(__dirname + '/', '');
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    console.log(`  BOM   ${rel}`);
    bom += 1;
  }
  const s = b.toString('utf8');
  // 乱码特征：UTF-8 被按 GBK 解读再写回会产生一批**固定的**汉字组合。
  // 这里用码点写，避免检测脚本自己命中自己。
  const GARBLE = ['\u951B', '\u9225', '\u93C2', '\u9428', '\u6D93', '\u934A', '\u94F9'];
  if (GARBLE.some((g) => s.includes(g))) {
    console.log(`  乱码  ${rel}`);
    garbled += 1;
  }
}

console.log('');
console.log(`  扫描 ${targets.length} 个文件：BOM ${bom} 个，乱码 ${garbled} 个`);
console.log(bom === 0 && garbled === 0 ? '  ✅ 全部正常' : '  ❌ 有文件损坏，需要修复');
process.exit(bom === 0 && garbled === 0 ? 0 : 1);
