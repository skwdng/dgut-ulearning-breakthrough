/**
 * 检查「块注释被提前闭合」这类手滑。
 *
 * 这个坑已经踩了三次：
 *   1. src/services/checkin/probeActivityApi.ts
 *      在块注释里用「星号包词 + 紧跟斜杠」的写法强调路径，
 *      那串字符的后两个正好是块注释的结束符 → 注释断在那里，
 *      后面几十行普通文字变成代码 → 报 44 个语法错误，
 *      而且报错位置与真正错因完全无关。
 *   2. tools/android/wire-native.cjs
 *      同样的强调写法 → 报在「第 52 行的模板字符串」上，
 *      看起来像模板字符串写错了，其实是注释提前闭合。
 *   3. 就是这个检查脚本本身 —— 说明里又写了一遍那种强调。
 *
 * 规矩：块注释里不要用「星号包词」强调，要强调就用方括号或引号。
 *
 * ────────────────────────────────────────────────────────────
 *
 * ⚠️ 重要：这个脚本**不自己写 JS 解析器**。
 *
 * 第一版试图用「逐行跟踪注释状态」的启发式来判断，
 * 结果对 13 个**语法完全正常**的文件误报 —— 因为字符串/正则里
 * 也会出现注释标记，启发式分不清。
 *
 * 正确的分工：
 *   · 语法对不对 → 交给 `node --check`（它就是 JS 解析器，权威）
 *   · 只是想知道「哪儿可疑」→ 才用启发式，且**只在该文件确实
 *     语法失败时**才把它当线索报出来
 *
 * 用法: node tools/check-comment-traps.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/** 注释标记拆开拼 —— 本文件自己不出现那两个字符的相邻组合 */
const OPEN = '/' + '*';
const CLOSE = '*' + '/';

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 只检查 `.js/.cjs/.mjs` —— 因为 `node --check` 只能验这些。
 * （`.ts/.tsx` 要 tsc，那个由 npm 的 typecheck 负责。）
 */
const files = [
  ...walk(path.join(ROOT, 'tools')),
  ...walk(path.join(ROOT, 'server')),
];

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  OK  ${name}`);
  } else {
    fail += 1;
    console.log(`  XX  ${name}${extra ? '\n      ' + extra : ''}`);
  }
};

console.log('');
console.log(`  用 node --check 逐个解析 ${files.length} 个 .js/.cjs 文件`);
console.log('');

/** 语法失败的文件 */
const broken = [];
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    const first = (r.stderr || '').split('\n').find((l) => /SyntaxError/.test(l)) ?? '(未知)';
    broken.push({ file, err: first.trim() });
  }
}

t(
  '所有 .js/.cjs 文件都能被 node 解析',
  broken.length === 0,
  broken.map((x) => `${path.relative(ROOT, x.file)}\n      ${x.err}`).join('\n      '),
);

/**
 * 如果有语法失败的文件，再用启发式给出「可疑行」当线索。
 * ⚠️ 只在**确实失败**时才输出 —— 否则就是对正常文件误报（第一版的错）。
 */
if (broken.length) {
  console.log('');
  console.log('  可疑位置（启发式，仅供参考）：');
  for (const b of broken) {
    let text = '';
    try {
      text = fs.readFileSync(b.file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    let inBlock = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (inBlock) {
        const closeAt = line.indexOf(CLOSE);
        if (closeAt >= 0) {
          const before = line.slice(0, closeAt);
          const after = line.slice(closeAt + CLOSE.length).trim();
          if (/^\s*\*/.test(line) && before.trimEnd().endsWith('*') && after) {
            console.log(`    ${path.relative(ROOT, b.file)}:${i + 1}`);
            console.log(`      ${line.trim().slice(0, 96)}`);
          }
          inBlock = false;
        }
      } else {
        const openAt = line.indexOf(OPEN);
        if (openAt >= 0 && line.indexOf(CLOSE, openAt + 2) < 0) inBlock = true;
      }
    }
  }
}

console.log('');
console.log('  规矩：块注释里不要用「星号包词」强调，要强调用方括号或引号。');
console.log('  踩过三次：probeActivityApi.ts、wire-native.cjs、以及本文件自己。');
console.log('');

console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
