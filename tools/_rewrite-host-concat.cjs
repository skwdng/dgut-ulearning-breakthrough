/**
 * 一次性脚本：把 signApi.ts / youxueCourseApi.ts 里
 * 「`${this.host}${xxx}`」的直接拼接改成走 `this.url(xxx)`。
 *
 * ══════════════ 为什么要改 ══════════════
 *
 * 多站点改造（支持优学院中国站）的核心是：请求地址不能再靠
 * "单个 host + 路径"拼，而要走 `resolvePath(当前站点, 路径)` ——
 * 因为中国站是**子域名模式**：
 *     /apps/user/... → https://apps.ulearning.cn/user/...
 *                       （`/apps` 段要去掉）
 *
 * 只要还有一处直接拼 host，那一处就永远只支持东莞理工。
 *
 * ⚠️ 必须**排除** Referer 那一行（它是 `${this.host}/umobile/...`，
 *    形态不同，本来就不该被替换）。
 *
 * 用法: node tools/_rewrite-host-concat.cjs [--apply]
 */
const fs = require('node:fs');
const path = require('node:path');

const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(__dirname, '..');

const FILES = [
  'src/services/checkin/signApi.ts',
  'src/services/checkin/youxueCourseApi.ts',
];

/** `${this.host}${EXPR}` → this.url(EXPR) */
const RE = /\$\{this\.host\}\$\{([^}]+)\}/g;

let total = 0;

for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.log(`  - 跳过（不存在）：${rel}`);
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  let n = 0;
  const out = lines.map((line) => {
    /** ⚠️ Referer 那行形态是 `${this.host}/umobile/...`，不会被 RE 匹配，安全 */
    if (!RE.test(line)) return line;
    RE.lastIndex = 0;
    n += 1;
    return line.replace(RE, (_m, expr) => `this.url(${expr})`);
  });
  console.log(`  ${n > 0 ? '√' : '·'} ${rel.padEnd(44)} ${n} 处`);
  if (APPLY && n > 0) {
    fs.writeFileSync(file, out.join('\n'), 'utf8');
  }
  total += n;
}

console.log('');
console.log(
  APPLY ? `  ✅ 已改写 ${total} 处` : `  预览：将改写 ${total} 处（加 --apply 才真改）`,
);
console.log('');
