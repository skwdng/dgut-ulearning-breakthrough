/**
 * 找出优学院前端各个 axios 实例的 baseURL —— 也就是接口真正挂在哪个主机。
 *
 * ══════════════ 为什么这一步是必须的 ══════════════
 *
 * 上一步挖出了 210 个接口，包括做「加减分 / 点不中」要用的：
 *   POST   /selectperson/giveMark
 *   DELETE /selectperson/deleteSelectedPerson
 *   POST   /classscore/markByStudent
 *
 * 但**光有路径没用** —— 必须知道挂在哪个主机、哪个前缀上。
 *
 * 已经踩过的坑：
 *   · 猜 `lms.dgut.edu.cn/appapi/classroomapi/...` → 全 404
 *   · `classroomapi.dgut.edu.cn` 等子域返回的是 SPA 的 index.html
 *     （说明那些子域是**页面**主机，不是接口）
 *
 * 所以要从代码里找 axios 实例的 baseURL 配置。
 *
 * 用法: node tools/find-youxue-baseurl.cjs
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

/**
 * ★ 先看 config.js —— 前端配置里定义了一堆 `XXX_API_SERVER_HOST`，
 *   那是"哪个业务走哪个子域"的唯一权威来源。
 */
console.log('');
console.log('═'.repeat(76));
console.log('  config.js 里的全部 *_HOST 定义');
console.log('═'.repeat(76));

for (const f of files) {
  if (path.basename(f) !== 'config.js') continue;
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/var\s+([A-Z_]*HOST[A-Z_]*)\s*=\s*([^;]+);/g)) {
    console.log(`  ${m[1].padEnd(32)} = ${m[2].trim().slice(0, 120)}`);
  }
}

/**
 * ★ 再找 axios 实例的 baseURL 配置。
 *   常见形态：`baseURL: xxxx` 或 `axios.create({baseURL: ...})`
 */
console.log('');
console.log('═'.repeat(76));
console.log('  axios 的 baseURL 配置');
console.log('═'.repeat(76));

const seen = new Set();
for (const f of files) {
  let s = '';
  try {
    s = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const m of s.matchAll(/baseURL\s*:\s*([^,;}]{1,160})/g)) {
    const v = m[1].trim();
    const key = v.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${path.basename(f).padEnd(34)} baseURL: ${v}`);
  }
  // 另一种形态：`axios.create({...})` 里带 `baseURL`
  for (const m of s.matchAll(/create\(\s*\{[^}]{0,400}?baseURL\s*:\s*([^,}]{1,160})/g)) {
    const v = m[1].trim();
    const key = 'CREATE:' + v.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${path.basename(f).padEnd(34)} create baseURL: ${v}`);
  }
}

/**
 * ★ 最后：selectperson / classscore 这些接口所在文件里，
 *   它们用的是哪个 axios 变量？把那个变量的定义也找出来。
 */
console.log('');
console.log('═'.repeat(76));
console.log('  selectperson / classscore 接口定义所在的上下文');
console.log('═'.repeat(76));

for (const f of files) {
  let s = '';
  try {
    s = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const needle of ['/selectperson/giveMark', '/selectperson/deleteSelectedPerson', '/classscore/markByStudent']) {
    const i = s.indexOf(needle);
    if (i < 0) continue;
    console.log('');
    console.log(`  【${needle}】 ${path.basename(f)}`);
    console.log('  ' + s.slice(Math.max(0, i - 500), i + 250).replace(/\s+/g, ' '));
  }
}
console.log('');
