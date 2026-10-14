/**
 * 深挖「选人 / 分数」相关的接口上下文。
 *
 * 目的：为「加减分」和「点不中」找出确切的
 *   · 接口路径
 *   · 请求方法（GET/POST）
 *   · 请求体字段
 *
 * 用法: node tools/extract-youxue-detail.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const RECON = path.join(__dirname, '..', '.recon');

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(RECON);
const hits = [];

/** 这些关键字最可能出现在我们要找的代码附近 */
const KEYS = [
  'getStudentScoreForClassroom',
  'startActivity',
  'relationType',
  'selectable',
  'callName',
  'randomCall',
  'selectUser',
  'updateScore',
];

for (const f of files) {
  let s = '';
  try {
    s = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const k of KEYS) {
    let i = -1;
    while ((i = s.indexOf(k, i + 1)) >= 0) {
      hits.push({ k, f: path.basename(f), ctx: s.slice(Math.max(0, i - 400), i + 500) });
      if (hits.length > 400) break;
    }
    if (hits.length > 400) break;
  }
  if (hits.length > 400) break;
}

/** 按关键字分组打印，每组只取前几处不重复的 */
for (const k of KEYS) {
  const group = hits.filter((h) => h.k === k);
  if (!group.length) {
    console.log('');
    console.log(`  【${k}】没找到`);
    continue;
  }
  console.log('');
  console.log('═'.repeat(72));
  console.log(`  【${k}】共 ${group.length} 处`);
  console.log('═'.repeat(72));
  const seen = new Set();
  let shown = 0;
  for (const h of group) {
    const key = h.ctx.replace(/\s+/g, ' ').slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    shown += 1;
    if (shown > 3) break;
    console.log('');
    console.log(`  [${shown}] ${h.f}`);
    console.log('  ' + h.ctx.replace(/\s+/g, ' ').trim().slice(0, 700));
  }
}
console.log('');
