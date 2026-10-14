// 一次性迁移脚本：把 expo-router 路由文件转成纯组件页面。
//
// 背景：鸿蒙上 react-native-screens 原生栈会白屏，必须彻底移除导航原生依赖。
// 这个脚本把 app/ 下的页面搬到 src/screens/，并去掉 expo-router 的 import。
// 跑完之后 app/ 只剩 expo-router 需要的入口壳（_layout.tsx + index.tsx）。
//
// 幂等：重复跑会覆盖 src/screens/ 里的文件，但结果一致。
const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..');
const APP = path.join(WS, 'app');
const OUT = path.join(WS, 'src', 'screens');

fs.mkdirSync(OUT, { recursive: true });

/** 二级页面：从 app/*.tsx 搬过来 */
const SECONDARY = [
  'settings',
  'profile',
  'schedule',
  'todo',
  'youxue-bind',
  'checkin',
  'checkin-manual',
  'checkin-log',
  'modules',
  'license',
  'crash-log',
];

/** 顶层页面：从 app/(tabs)/*.tsx 搬过来 */
const TABS = ['index', 'youxue', 'food', 'ai'];

/** 把 `@/x` / `@/x` 别名和相对路径统一成从 src/screens/ 出发的相对路径 */
function rewriteImports(src, fromDepth) {
  const up = fromDepth === 1 ? '../' : '../'; // src/screens/x.tsx 都在同一层
  let out = src;

  // @/xxx  →  ../xxx
  out = out.replace(/(['"])@\/([^'"]+)\1/g, (_m, q, rest) => `${q}${up}${rest}${q}`);
  return out;
}

/** 删掉 expo-router 的 import 行 */
function stripRouterImports(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*import\s+\{[^}]*\}\s+from\s+['"]expo-router['"];?\s*$/.test(line))
    .join('\n');
}

const report = [];

function migrate(name, srcPath, outName) {
  if (!fs.existsSync(srcPath)) {
    report.push(`  × 找不到 ${srcPath}`);
    return;
  }
  let src = fs.readFileSync(srcPath, 'utf8');
  src = stripRouterImports(src);
  src = rewriteImports(src, 1);

  const header =
    `/**\n` +
    ` * 由 app/${name}.tsx 迁移而来（tools/migrate-screens.cjs）。\n` +
    ` * 已移除 expo-router 依赖 —— 见 src/nav/router.tsx 的说明。\n` +
    ` */\n`;
  src = header + src;

  const outPath = path.join(OUT, `${outName}.tsx`);
  fs.writeFileSync(outPath, src, 'utf8');
  report.push(`  √ ${name} → src/screens/${outName}.tsx  (${src.split('\n').length} 行)`);
}

console.log('迁移二级页面：');
for (const n of SECONDARY) migrate(n, path.join(APP, `${n}.tsx`), n);

console.log('\n迁移顶层页面：');
for (const n of TABS) migrate(path.join('(tabs)', n), path.join(APP, '(tabs)', `${n}.tsx`), `tab-${n}`);

console.log('\n' + report.join('\n'));
console.log(`\n共 ${report.filter((r) => r.startsWith('  √')).length} 个文件`);
