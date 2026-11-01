/**
 * 修正上一步 `_rewrite-host-concat.cjs` 的 bug。
 *
 * ══════════════ 出了什么事 ══════════════
 *
 * 上一步想把
 *     `${this.host}${path}`
 * 改成
 *     this.url(path)
 *
 * 但正则只替换了**模板字符串内部**，外面的反引号还在，于是变成：
 *     `this.url(path)`          ← 这是个**字符串字面量**，不是函数调用！
 *
 * 后果：请求地址会变成字面量 `this.url(path)`，运行时报"无效 URL"。
 * ⚠️ 这类错误 tsc **不一定**能抓到（字符串合法），所以必须显式修。
 *
 * 现在把 `` `this.url(X)` `` → `this.url(X)`。
 *
 * 用法: node tools/_fix-url-template.cjs [--apply]
 */
const fs = require('node:fs');
const path = require('node:path');

const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(__dirname, '..');

const FILES = [
  'src/services/checkin/signApi.ts',
  'src/services/checkin/youxueCourseApi.ts',
];

/** 整段模板字符串只含 this.url(...) 的情况 */
const RE = /`this\.url\((.+)\)`/g;

let total = 0;

for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  let n = 0;
  const out = lines.map((line) => {
    if (!RE.test(line)) return line;
    RE.lastIndex = 0;
    n += 1;
    const fixed = line.replace(RE, (_m, expr) => `this.url(${expr})`);
    console.log(`  ${rel}:`);
    console.log(`    旧：${line.trim().slice(0, 96)}`);
    console.log(`    新：${fixed.trim().slice(0, 96)}`);
    return fixed;
  });
  console.log('');
  if (APPLY && n > 0) fs.writeFileSync(file, out.join('\n'), 'utf8');
  total += n;
}

console.log(APPLY ? `  ✅ 已修正 ${total} 处` : `  预览：将修正 ${total} 处（加 --apply 才真改）`);
console.log('');
