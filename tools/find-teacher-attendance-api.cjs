// 找 PC 版（courseweb / ulearning）里"修改考勤状态"的接口调用。
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

// 只看 PC / course 相关的 js（排除 umobile 与第三方 app 的）
const files = walk(__dirname + '/.recon', []).filter(
  (f) => /\.js$/.test(f) && /files|ulearning|courseweb|course/i.test(f.replace(/\\/g, '/')),
);

console.log(`  扫描 ${files.length} 个 PC 侧 js`);

// 找形如 "/xxx/yyy" 且有 attendance/sign 的 **接口路径**（排除 vue 模板噪音）
const paths = new Map();
for (const f of files) {
  let s = '';
  try {
    s = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  // url: "/a/b"  或  post("/a/b"  或  get("/a/b"
  const re = /(?:url\s*:\s*|\.(?:get|post|put|delete)\s*\(\s*)["'`](\/[A-Za-z0-9_\-/{}.:$]{3,90})["'`]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const p = m[1];
    if (!/attendan|sign|Sign|Attendance|status|Status/i.test(p)) continue;
    if (!paths.has(p)) paths.set(p, f.replace(__dirname + '/', ''));
  }
}

const sorted = [...paths.keys()].sort();
console.log(`\n  === 含 attendance/sign/status 的接口路径 ${sorted.length} 个 ===`);
for (const p of sorted) {
  console.log(`    ${p}`);
  console.log(`        ${paths.get(p)}`);
}
