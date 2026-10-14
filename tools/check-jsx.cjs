/**
 * JSX 合法性静态检查 —— 挡住"在 <Txt> 里写了 HTML 标签"这类错误。
 *
 * ⚠️ 真实踩过的坑：
 *   在 <Txt> 里写了 `<br />`，React Native 把 `br` 当成组件名去查，
 *   找不到就抛：
 *     Invariant Violation: View config getter callback for component `br`
 *     must be a function (received `undefined`).
 *     Make sure to start component names with a capital letter.
 *   → **整个页面白屏**（红屏报错页），而且错误信息不指向源码行。
 *
 * RN 里换行要用 `{'\n'}`，不能用 <br>。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'src');
const SKIP_DIRS = new Set(['node_modules', 'android', '.git']);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** HTML 里常见、但 RN 里不存在的标签 */
const HTML_TAGS = [
  'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'p', 'div', 'span',
  'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'a', 'img', 'h1', 'h2', 'h3',
];

const files = walk(ROOT, []).filter((f) => /\.(tsx?|jsx?)$/.test(f));
const problems = [];

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.split('\n');

  // 先剥掉注释行与字符串字面量里的误报（粗略但够用）
  lines.forEach((rawLine, idx) => {
    const line = rawLine;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

    for (const tag of HTML_TAGS) {
      // 匹配 <br> <br/> <br /> </br> 以及 <b> </b> 等
      const re = new RegExp(`</?${tag}\\s*/?>`, 'i');
      if (re.test(line)) {
        problems.push({
          file: f.replace(path.resolve(__dirname, '..') + path.sep, ''),
          line: idx + 1,
          tag,
          text: trimmed.slice(0, 100),
        });
      }
    }
  });
}

console.log(`  扫描 ${files.length} 个 tsx/ts 文件`);
console.log('');

if (problems.length === 0) {
  console.log('  ✅ 没有在 JSX 里误用 HTML 标签');
  console.log('     （换行请用 {\'\\n\'}，不要用 <br>）');
  process.exit(0);
}

console.log(`  ❌ 发现 ${problems.length} 处 HTML 标签 —— React Native 里不能用：`);
for (const p of problems) {
  console.log(`    ${p.file}:${p.line}  <${p.tag}>`);
  console.log(`        ${p.text}`);
}
console.log('');
console.log('  改法：把 <br> / <br /> 换成 {\'\\n\'}；其他标签用 <Txt> 嵌套或独立组件。');
process.exit(1);
