/**
 * 把抓下来的优学院前端 JS 里**所有** API 路径挖出来，并找出"写"接口。
 *
 * ══════════════ 要解决的问题 ══════════════
 *
 * 做「加减分」「点不中」需要两个**写**接口（POST/PUT/DELETE）：
 *   · 改自己在一个选人活动里的分数
 *   · 改自己"可被选中"的状态
 *
 * 已经找到 35 个 `/wisdomClassroom/` 接口，但都是读接口或与活动无关的。
 * 说明写接口在**别的 chunk** 里（前端按路由懒加载）。
 *
 * 这个脚本把全部路径扫出来，按"读/写"分类，重点列出写接口。
 *
 * ⚠️ 只读本地已抓取的文件，不发起任何网络请求。
 *
 * 用法: node tools/extract-youxue-all-apis.cjs
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
 * 匹配 `.get("/xxx")` / `.post("/xxx")` / `.put(...)` / `.delete(...)`。
 *
 * ⚠️ 路径里可能有模板变量（`"+e.classroomId+"`），
 *    统一截到 `"` 或 `?` 为止，只留静态前缀 —— 够用来判断接口存在与否。
 */
const RE = /\.(get|post|put|delete|patch)\(\s*["'`]([^"'`]+)["'`]/g;

/** 每个路径记下：方法集合、出现文件 */
const api = new Map();

for (const f of files) {
  let s = '';
  try {
    s = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const m of s.matchAll(RE)) {
    const method = m[1].toUpperCase();
    let p = m[2];
    // 去掉 query 与模板拼接部分
    p = p.split('?')[0].split('"+')[0].replace(/\/+$/, '');
    if (!p.startsWith('/')) continue;
    // 过滤明显的非接口（静态资源）
    if (/\.(js|css|png|jpg|svg|json|woff2?|html)$/i.test(p)) continue;
    if (p.length > 90) continue;

    const key = p;
    if (!api.has(key)) api.set(key, { methods: new Set(), file: path.basename(f) });
    api.get(key).methods.add(method);
  }
}

const all = [...api.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const writes = all.filter(([, v]) => [...v.methods].some((m) => m !== 'GET'));

console.log(`  共 ${all.length} 个接口，其中含写方法的 ${writes.length} 个`);

/**
 * ★ 重点：与"分数 / 选人"相关的写接口 —— 那正是加减分要用的
 */
const SCORE_RX = /(score|point|integral|mark|grade|call|select|choose|pick|random|vote|activity)/i;

console.log('');
console.log('═'.repeat(76));
console.log('  ★★★ 与分数/选人相关的接口（读+写）');
console.log('═'.repeat(76));
for (const [p, v] of all) {
  if (!SCORE_RX.test(p)) continue;
  const ms = [...v.methods].join('/');
  const flag = [...v.methods].some((m) => m !== 'GET') ? '  ← 【写】' : '';
  console.log(`  ${ms.padEnd(12)} ${p}${flag}`);
}

console.log('');
console.log('═'.repeat(76));
console.log('  全部"写"接口（POST/PUT/DELETE）');
console.log('═'.repeat(76));
for (const [p, v] of writes) {
  const ms = [...v.methods].join('/');
  console.log(`  ${ms.padEnd(12)} ${p}`);
}
console.log('');
