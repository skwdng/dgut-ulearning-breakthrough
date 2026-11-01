/**
 * 在本地抓包存档里挖「投票 / 答题」的后端接口与字段。
 *
 * 依据（AGENTS.md：不猜，先找证据）：
 *   · 用户要求做「补投票 / 改投票」，但接口结构未知
 *   · `.recon/umobile` 是优学院移动端 H5（含学生端投票/答题页面）
 *   · `.recon/ulearning`、`.recon/courseweb` 是学生 PC 端
 *
 * 做法：扫全部 .js，抽出含 vote/answer/interlocution/option 的**字符串字面量**，
 * 再按"像接口路径"的（含 / 或 upload/activity 等关键字）分组打印。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['.recon', '.health'];
const OUT = path.join(ROOT, '.health', 'vote-recon.txt');

function walk(dir, out = []) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|json)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)));
console.log(`  扫描 ${files.length} 个文件`);

const KW = /(vote|Vote|VOTE|answerQue|interlocution|ballot|optionId|voteId|activityId)/;
/** 像接口/字段的形态：含斜杠，或像驼峰参数名 */
const INTERESTING = /[/]|Id$|_id|Type$|type$|List$|list$|Detail$|detail$|Submit|submit|Activity|activity|Option|option|Count|count/;

const hits = new Map(); // literal → {files:Set, count}

for (const f of files) {
  let s = '';
  try {
    s = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const m of s.matchAll(/["'`]([^"'`\n]{2,120})["'`]/g)) {
    const v = m[1];
    if (!KW.test(v)) continue;
    if (!INTERESTING.test(v)) continue;
    /** 排除明显是 i18n 文案（含空格的中文/长句） */
    if (/\s{2,}/.test(v) || v.length > 60) continue;
    const rec = hits.get(v) ?? { files: new Set(), count: 0 };
    rec.files.add(path.relative(ROOT, f));
    rec.count += 1;
    hits.set(v, rec);
  }
}

const rows = [...hits.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`  命中 ${rows.length} 个字面量`);

const lines = [];
lines.push(`# 投票/答题 相关字符串（${rows.length} 条）`);
for (const [v, rec] of rows.slice(0, 200)) {
  lines.push(`${String(rec.count).padStart(3)}  ${v}`);
  lines.push(`     来源: ${[...rec.files].slice(0, 3).join(', ')}`);
}
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

console.log(`  已写入 ${path.relative(ROOT, OUT)}`);
console.log('');
console.log('  ── 前 60 条 ──');
for (const [v, rec] of rows.slice(0, 60)) {
  console.log(`  ${String(rec.count).padStart(3)}  ${v}`);
}
