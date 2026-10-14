/**
 * 从优学院打包后的前端代码里挖出「智慧课堂」的真实接口路径。
 *
 * ══════════════ 为什么要这么干 ══════════════
 *
 * 为了做「加减分」和「点不中」，需要两个接口：
 *   · 改自己的分数（选人活动里的 `score`）
 *   · 改"可被选中"（`selectable`）
 *
 * 优学院没有公开文档，只能实测。之前我一直在猜路径
 * （`/appapi/classroomapi/classroomActivity2` 之类），**全是 404**。
 *
 * 后来从前端配置 `config.js` 里挖到了关键信息：
 *   CLASSROOM_API_SERVER_HOST = protocol + "classroomapi" + hostDomain
 * 但那些子域返回的都是 SPA 的 index.html —— 说明它们是**页面**主机，
 * 接口路径还得从打包代码里找。
 *
 * 这个脚本就干这件事：在抓下来的 JS 里搜出 `/wisdomClassroom/...` 全部路径。
 *
 * ⚠️ 只读本地已抓取的文件，**不发起任何网络请求**。
 *
 * 用法: node tools/extract-youxue-paths.cjs
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
console.log('');
console.log(`  扫描 ${files.length} 个 js 文件（${RECON}）`);

/** 收集所有形如 /wisdomClassroom/xxx 的路径 */
const paths = new Map();
/** 也收一份 /api/ 风格的，可能有别的命名空间 */
const others = new Map();

for (const f of files) {
  let s = '';
  try {
    s = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const m of s.matchAll(/["'`](\/wisdomClassroom\/[A-Za-z0-9_/\-{}$.]+)/g)) {
    const p = m[1].split('?')[0];
    if (!paths.has(p)) paths.set(p, path.basename(f));
  }
  for (const m of s.matchAll(/["'`](\/classroomapi\/[A-Za-z0-9_/\-{}$.]+)/g)) {
    const p = m[1].split('?')[0];
    if (!others.has(p)) others.set(p, path.basename(f));
  }
}

console.log('');
console.log('═'.repeat(72));
console.log(`  /wisdomClassroom/ 下的接口（${paths.size} 个）`);
console.log('═'.repeat(72));
for (const [p, src] of [...paths.entries()].sort()) {
  console.log(`  ${p}`);
  console.log(`      （首次出现在 ${src}）`);
}

if (others.size) {
  console.log('');
  console.log('═'.repeat(72));
  console.log(`  /classroomapi/ 下的接口（${others.size} 个）`);
  console.log('═'.repeat(72));
  for (const [p, src] of [...others.entries()].sort()) {
    console.log(`  ${p}`);
    console.log(`      （首次出现在 ${src}）`);
  }
}

/**
 * ★ 重点找"选人 / 分数 / 可选中"相关的接口 —— 那正是加减分与点不中要用的。
 */
const INTEREST = /(call|random|select|score|point|integral|choose|pick|vote)/i;
const interesting = [...paths.keys()].filter((p) => INTEREST.test(p));

console.log('');
console.log('═'.repeat(72));
console.log(`  ★ 与「选人 / 分数」相关的候选（${interesting.length} 个）`);
console.log('═'.repeat(72));
if (interesting.length === 0) {
  console.log('  （没找到 —— 可能在没抓到的 chunk 里，或用了别的命名）');
} else {
  for (const p of interesting) console.log(`  ${p}`);
}
console.log('');
