// 找 signByTea 在业务代码里的**调用处**，看 users 传的是什么结构。
const fs = require('fs');
const path = require('path');

function walk(d, out) {
  let es;
  try {
    es = fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(__dirname + '/.recon', []).filter((f) => /\.js$/.test(f));
let found = 0;

for (const f of files) {
  let s = '';
  try {
    s = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (!s.includes('signByTea')) continue;

  // 找所有 signByTea 出现处，打印上下文
  let i = -1;
  while ((i = s.indexOf('signByTea', i + 1)) !== -1) {
    const ctx = s.slice(Math.max(0, i - 400), i + 400);
    // 跳过函数定义本身
    if (/post\(\s*["']\/newAttendance\/signByTea/.test(ctx)) continue;
    console.log(`  ★ ${f.replace(__dirname + '/', '')}`);
    console.log('    ' + ctx.replace(/\s+/g, ' '));
    console.log('');
    found += 1;
    if (found > 6) break;
  }
  if (found > 6) break;
}

// 再找 signByTea 作为模块成员被引用的地方（形如 .I( 或 ["I"]()
console.log(`  调用处命中 ${found}`);
