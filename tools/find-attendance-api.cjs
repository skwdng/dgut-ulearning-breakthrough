// 在所有 .recon 的 js 里，把含 attendance / sign 的**引号字符串**都列出来。
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
const hits = new Map();

for (const f of files) {
  let s = '';
  try {
    s = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  // 抓所有引号里的、含 attendan 或 ign（sign）的片段
  const re = /["'`]([^"'`\n]{4,120})["'`]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const v = m[1];
    if (!/attendan|sign|Sign|Attendance/i.test(v)) continue;
    if (!/[/.]/.test(v)) continue; // 要像路径或 URL
    if (!hits.has(v)) hits.set(v, f.replace(__dirname + '/', ''));
  }
}

const sorted = [...hits.keys()].sort();
console.log(`  === 含 attendance/sign 的字符串 ${sorted.length} 个 ===`);
for (const v of sorted) {
  console.log(`    ${v}`);
}
