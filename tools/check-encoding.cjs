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

/**
 * ⚠️ 这两个根路径曾经是 `__dirname + '/src'` —— **错的**。
 *
 * `__dirname` 是 `…\tools`，于是拼出 `tools/src` 和 `tools/tools`，
 * 两个都不存在；而 `walk()` 把 readdir 的错误 catch 掉了，
 * 于是返回空数组 → 打印「扫描 0 个文件 ✅ 全部正常」。
 *
 * ⚠️ 这是个**静默失效**：检查看起来通过了，实际上一个文件都没检查。
 *    我现在把 git 里 `src/` 的真实位置修正为上一级目录，
 *    并且**加了断言**：扫到的文件数太少就直接报错，
 *    不允许再出现"0 个文件也算通过"。
 */
const ROOT = path.join(__dirname, '..');
const roots = [path.join(ROOT, 'src'), path.join(ROOT, 'tools')];
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

/**
 * ★ 防"静默失效"：路径写错时 targets 会是 0，而 0 个文件"全部正常"。
 *   这个项目文件有几百个，少于 100 就说明**路径又错了**，必须报错。
 */
const MIN_EXPECTED = 100;
if (targets.length < MIN_EXPECTED) {
  console.log(`  ❌ 只扫到 ${targets.length} 个文件（应当 >${MIN_EXPECTED}）`);
  console.log('     多半是根路径写错了 —— 这次检查**不算通过**。');
  console.log(`     根路径：${roots.join(' , ')}`);
  process.exit(1);
}

console.log(bom === 0 && garbled === 0 ? '  ✅ 全部正常' : '  ❌ 有文件损坏，需要修复');
process.exit(bom === 0 && garbled === 0 ? 0 : 1);
