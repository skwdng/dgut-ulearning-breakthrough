// 迁移收尾 2：
// 1. 给顶层页面加 router / isActive props（由 NavigationShell 传入）
// 2. 修 license.tsx 里因目录变化而错掉的相对路径
const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..');
const DIR = path.join(WS, 'src', 'screens');

const log = [];

// ── 1) 顶层页面签名 ──
const TABS = [
  ['tab-index.tsx', 'HomeScreen'],
  ['tab-youxue.tsx', 'YouxueTabScreen'],
  ['tab-food.tsx', 'FoodScreen'],
  ['tab-ai.tsx', 'AiScreen'],
];

for (const [file, fn] of TABS) {
  const p = path.join(DIR, file);
  let src = fs.readFileSync(p, 'utf8');

  if (src.includes('TabScreenProps')) {
    log.push(`  · ${file.padEnd(20)} 已处理`);
    continue;
  }

  // 改函数签名
  const sigRe = new RegExp(`export function ${fn}\\(\\)\\s*\\{`);
  if (!sigRe.test(src)) {
    log.push(`  × ${file.padEnd(20)} 找不到 export function ${fn}()`);
    continue;
  }
  src = src.replace(sigRe, `export function ${fn}({ router }: TabScreenProps) {`);

  // 插入类型 import（放在最后一个 import 之后）
  const lines = src.split('\n');
  let lastImport = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^import\s/.test(lines[i])) lastImport = i;
  }
  lines.splice(lastImport + 1, 0, "import type { TabScreenProps } from '../nav/tabs';");
  src = lines.join('\n');

  fs.writeFileSync(p, src, 'utf8');
  log.push(`  √ ${file.padEnd(20)} 加 props 与类型 import`);
}

// ── 2) license.tsx 路径 ──
{
  const p = path.join(DIR, 'license.tsx');
  let src = fs.readFileSync(p, 'utf8');
  if (src.includes("'../src/components/LicenseGate'")) {
    src = src.replace("'../src/components/LicenseGate'", "'../components/LicenseGate'");
    fs.writeFileSync(p, src, 'utf8');
    log.push('  √ license.tsx          修 LicenseGate 路径');
  } else {
    log.push('  · license.tsx          路径无需修');
  }
}

// ── 3) 全局扫一遍有没有残留的 '../src/' 路径 ──
console.log(log.join('\n'));
console.log('\n检查残留的 ../src/ 路径：');
let found = 0;
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.tsx'))) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  if (src.includes("'../src/")) {
    console.log(`  ⚠️ ${f}`);
    found += 1;
  }
}
if (found === 0) console.log('  ✅ 没有');
