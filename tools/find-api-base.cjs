/**
 * 深挖优学院前端里 **HTTP 客户端的 baseURL** —— 这是找接口主机的唯一权威来源。
 *
 * ══════════════ 为什么要这么执着 ══════════════
 *
 * 已经从打包代码里挖出了真实接口名（`/selectperson/*`、`/classscore/*`、
 * `/wisdomClassroom/*`），但**不知道挂在哪个主机/前缀**：
 *
 *   lms.dgut.edu.cn                      → 404 (nginx)
 *   application.dgut.edu.cn/appapi       → 404 (Tomcat)
 *   classroomapi.dgut.edu.cn             → 返回前端页面（HTML）
 *   app.dgut.edu.cn                      → 返回前端页面（HTML）
 *
 * `config.js` 里定义了 `CLASSROOM_SERVER_HOST = classroomapi + hostDomain` 之类，
 * 但那只是**页面地址**。真正决定接口去哪儿的是 axios 实例的 `baseURL`。
 *
 * 这个脚本把所有 js 里跟 baseURL / axios 实例 / 请求前缀有关的片段翻出来。
 *
 * ⚠️ 只读本地已抓取的文件，不发起网络请求。
 *
 * 用法: node tools/find-api-base.cjs
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
console.log(`  扫描 ${files.length} 个 js 文件`);

/**
 * 要找的模式。按"离答案最近"排序。
 *
 * ⚠️ 打包后的代码里 axios 实例通常是
 *     `X.create({baseURL: Y})` 或 `{baseURL:Y,timeout:...}`
 *    也可能被拆成 `{ baseURL: Y }` 赋给某个变量。
 */
const PATTERNS = [
  { name: 'baseURL 赋值', re: /baseURL\s*[:=]\s*([^,;}]{1,120})/g },
  { name: 'axios.create', re: /\.create\(\s*\{[^{}]{0,400}/g },
  { name: 'API_SERVER_HOST 用法', re: /[A-Z_]*SERVER_HOST[A-Z_]*\s*[:,=]\s*([^,;}]{1,120})/g },
  {
    name: 'classroomapi / courseapi / api 路径拼接',
    /** ⚠️ 字符类里的 `/` 必须转义，否则在正则字面量里会被当成结束符（踩过） */
    re: /["'`][^"'`]{0,20}(?:classroomapi|courseapi|\/api)[^"'`]{0,60}["'`]/g,
  },
];

for (const { name, re } of PATTERNS) {
  const hits = [];
  for (const f of files) {
    let s = '';
    try {
      s = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const m of s.matchAll(re)) {
      const v = (m[1] ?? m[0]).replace(/\s+/g, ' ').trim().slice(0, 140);
      if (!v) continue;
      hits.push({ f: path.basename(f), v });
      if (hits.length > 500) break;
    }
    if (hits.length > 500) break;
  }

  console.log('');
  console.log('═'.repeat(76));
  console.log(`  【${name}】${hits.length} 处`);
  console.log('═'.repeat(76));
  const seen = new Set();
  let shown = 0;
  for (const h of hits) {
    if (seen.has(h.v)) continue;
    seen.add(h.v);
    shown += 1;
    if (shown > 25) break;
    console.log(`  ${h.f.padEnd(34)} ${h.v}`);
  }
  if (shown === 0) console.log('  （没有）');
}

/**
 * ★ 最后一步：找 **request/axios 实例被创建** 的那个模块。
 *   特征是同时出现 `interceptors` 或 `timeout` 与 baseURL。
 */
console.log('');
console.log('═'.repeat(76));
console.log('  【可能创建了 axios 实例的模块】');
console.log('═'.repeat(76));
for (const f of files) {
  let s = '';
  try {
    s = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (!/baseURL/.test(s)) continue;
  const idx = s.indexOf('baseURL');
  console.log('');
  console.log(`  ── ${path.basename(f)} （baseURL 在偏移 ${idx}）──`);
  console.log('  ' + s.slice(Math.max(0, idx - 700), idx + 500).replace(/\s+/g, ' '));
}
console.log('');
