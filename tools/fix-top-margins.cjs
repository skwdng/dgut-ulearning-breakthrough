// 去掉各顶层页面**首个** Section 上的 marginTop。
//
// 原因：顶部留白现在由 nav shell 统一提供（useTopInset + spacing.base）；
// 各页面再自己加 marginTop 就变成重复叠加，导致"有的页面留白多、有的少"。
const fs = require('fs');
const path = require('path');

const files = ['tab-ai.tsx', 'tab-food.tsx', 'tab-index.tsx', 'tab-youxue.tsx'];
const OLD = '<Section style={{ marginTop: spacing.sm }}>';
const NEW = '<Section>';

for (const f of files) {
  /** ⚠️ 用 `__dirname` 定位：别人 clone 到别的目录也能跑（原来写死本机绝对路径） */
  const p = path.join(__dirname, '..', 'src', 'screens', f);
  let s = fs.readFileSync(p, 'utf8');
  const idx = s.indexOf(OLD);
  if (idx < 0) {
    console.log(`  · ${f} 无需修改`);
    continue;
  }
  s = s.slice(0, idx) + NEW + s.slice(idx + OLD.length);
  fs.writeFileSync(p, s, 'utf8');
  console.log(`  √ ${f} 去掉首个 Section 的 marginTop`);
}
