// 把迁移过来的页面里的 `export default function XxxScreen()`
// 改成 `export function XxxScreen()`（具名导出），
// 这样注册表可以静态 import。
//
// 幂等：已经是具名导出的文件不会被改。
const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..');
const DIR = path.join(WS, 'src', 'screens');

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.tsx'));
let changed = 0;

for (const f of files) {
  const p = path.join(DIR, f);
  let src = fs.readFileSync(p, 'utf8');
  const before = src;

  // export default function Name(  →  export function Name(
  src = src.replace(/export\s+default\s+function\s+(\w+)/g, 'export function $1');

  if (src !== before) {
    fs.writeFileSync(p, src, 'utf8');
    changed += 1;
    const m = src.match(/export function (\w+)/);
    console.log(`  √ ${f.padEnd(26)} → export function ${m ? m[1] : '?'}`);
  } else {
    console.log(`  · ${f.padEnd(26)} 无需修改`);
  }
}

console.log(`\n改动 ${changed} 个文件`);
