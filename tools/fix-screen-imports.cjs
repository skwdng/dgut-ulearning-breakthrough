// 迁移收尾：补齐页面里对路由 hook 的 import。
//
// 背景：迁移脚本删掉了 `import { useRouter } from 'expo-router'`，
// 但页面里还在调用 useRouter / useLocalSearchParams。这里补上新的来源。
//
// 顶层页面特殊：它们由 NavigationShell 通过 props 传 router，不调用 useRouter()，
// 所以要把调用语句整行删掉。
const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..');
const DIR = path.join(WS, 'src', 'screens');

const TAB_FILES = new Set(['tab-index.tsx', 'tab-youxue.tsx', 'tab-food.tsx', 'tab-ai.tsx']);

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.tsx'));
const log = [];

for (const f of files) {
  const p = path.join(DIR, f);
  let src = fs.readFileSync(p, 'utf8');
  const before = src;
  const isTab = TAB_FILES.has(f);

  const needsRouter = /\buseRouter\s*\(/.test(src);
  const needsParams = /\buseLocalSearchParams\b/.test(src);

  if (isTab && needsRouter) {
    // 顶层页面：删掉 useRouter 调用，改用 props 里的 router
    src = src.replace(/^\s*const router = useRouter\(\);\s*$/m, '');
    log.push(`  · ${f.padEnd(24)} 删除 useRouter() 调用（改用 props.router）`);
  } else if (needsRouter || needsParams) {
    const names = [needsRouter ? 'useRouter' : null, needsParams ? 'useLocalSearchParams' : null].filter(Boolean);
    const imp = `import { ${names.join(', ')} } from '../nav/router';`;

    // 插到最后一个 import 之后，保持 import 区整洁
    const lines = src.split('\n');
    let lastImport = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^import\s/.test(lines[i])) lastImport = i;
    }
    if (lastImport >= 0) {
      lines.splice(lastImport + 1, 0, imp);
      src = lines.join('\n');
      log.push(`  √ ${f.padEnd(24)} 补 ${names.join(' + ')} import`);
    }
  } else {
    log.push(`  · ${f.padEnd(24)} 无需处理`);
  }

  if (src !== before) fs.writeFileSync(p, src, 'utf8');
}

console.log(log.join('\n'));
