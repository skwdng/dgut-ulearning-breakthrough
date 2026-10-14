/**
 * 死代码检查：未使用的变量 / 导入。
 *
 * ══════════════ 为什么要单独做这个 ══════════════
 *
 * 项目的 `tsconfig.json` 没开 `noUnusedLocals` / `noUnusedParameters`
 * （大概是历史代码里有不少），所以 `tsc --noEmit` 查不出死代码。
 *
 * 结果就是：**我改完代码留下的未用导入没人发现**。
 * 这次改绑定页时，`tsc` 报了 0 错误，但严格模式下有 5 个未用导入
 * （ActivityIndicator / Badge / Field / getServerBase / reportUserQueued）——
 * 全是删除密码表单后的残留。
 *
 * 死代码本身不会让 App 崩，但它会：
 *   · 让以后读代码的人以为那些东西还在用
 *   · 掩盖"某个功能是不是真的接上了"（比如 reportUserQueued 未用 = 上报断了）
 *
 * ⚠️ 最后那条是真事：`reportUserQueued` 变成未用导入，
 *    正是"网页登录没有上报"这个 bug 的**症状**。
 *    所以这个检查不只是洁癖，它能抓到功能断线。
 *
 * ══════════════ 基线策略 ══════════════
 * 历史遗留的未用变量（二十来处）不在这次范围内 ——
 * 一次性全清风险大且与需求无关。所以：
 *   · 维护一个**基线**（已知的历史遗留）
 *   · 只对**基线之外的新增**报错
 * 这样既不会淹没在历史问题里，又能拦住新产生的死代码。
 *
 * 用法:
 *   node tools/check-dead-code.cjs            # 检查（新增就报错）
 *   node tools/check-dead-code.cjs --list     # 只列出全部，不判定
 *   node tools/check-dead-code.cjs --update   # 把当前状态记为新基线
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_FILE = path.join(__dirname, 'dead-code-baseline.json');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const LIST_ONLY = process.argv.includes('--list');
const UPDATE = process.argv.includes('--update');

/** 跑严格模式 tsc，解析出 "文件(行,列): error TS6133/TS6192: 'x' is declared but..." */
function collect() {
  const r = spawnSync(process.execPath, [TSC, '--noEmit', '--noUnusedLocals', '--noUnusedParameters'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const items = [];
  const re = /^(.+?)\((\d+),(\d+)\): error TS(6133|6192): (.+)$/gm;
  let m;
  while ((m = re.exec(out))) {
    items.push({
      file: m[1].replace(/\\/g, '/'),
      line: Number(m[2]),
      code: `TS${m[4]}`,
      // 只留标识符，去掉行号位置 —— 行号会随编辑漂移
      symbol: (/'([^']+)'/.exec(m[5]) ?? [, m[5]])[1],
    });
  }
  return items;
}

/** 基线用 file::symbol 作为键（不含行号，避免编辑后误报） */
const keyOf = (i) => `${i.file}::${i.symbol}`;

const items = collect();
console.log('');
console.log(`  严格模式未使用变量：${items.length} 处`);

if (LIST_ONLY) {
  const byFile = new Map();
  for (const i of items) {
    if (!byFile.has(i.file)) byFile.set(i.file, []);
    byFile.get(i.file).push(i.symbol);
  }
  console.log('');
  for (const [f, syms] of [...byFile.entries()].sort()) {
    console.log(`  ${f}`);
    console.log(`     ${[...new Set(syms)].join(', ')}`);
  }
  console.log('');
  process.exit(0);
}

if (UPDATE) {
  const keys = [...new Set(items.map(keyOf))].sort();
  fs.writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify({ note: '已知的历史遗留未使用变量；新增的会被 check-dead-code.cjs 拦下', keys }, null, 2)}\n`,
    'utf8',
  );
  console.log(`  √ 基线已更新：${keys.length} 项 → ${path.basename(BASELINE_FILE)}`);
  process.exit(0);
}

let baseline = [];
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).keys ?? [];
} catch {
  console.log('  ⚠️ 没有基线文件（先跑 --update 生成）');
}

const baseSet = new Set(baseline);
const currentKeys = new Set(items.map(keyOf));

/** 新增：当前有、基线没有 */
const added = items.filter((i) => !baseSet.has(keyOf(i)));
/** 已修掉：基线有、当前没有（好事，提示一下） */
const fixed = baseline.filter((k) => !currentKeys.has(k));

console.log(`  基线里：${baseline.length} 处`);
console.log('');

if (fixed.length) {
  console.log(`  √ 比基线少了 ${fixed.length} 处（已清理）：`);
  for (const k of fixed.slice(0, 20)) console.log(`     · ${k}`);
  console.log('');
}

if (added.length) {
  console.log(`  × 新增 ${added.length} 处未使用变量：`);
  for (const i of added) console.log(`     · ${i.file}(${i.line})  '${i.symbol}'  ${i.code}`);
  console.log('');
  console.log('  ⚠️ 死代码不只是洁癖问题 ——');
  console.log('     某个 import 变成"未使用"，往往说明**功能接断了**');
  console.log('     （真事：reportUserQueued 未用 = 网页登录没有上报）。');
  console.log('');
  console.log('  修掉之后重跑；如果确认是合理的历史遗留，跑：');
  console.log('     node tools/check-dead-code.cjs --update');
  process.exit(1);
}

console.log(`  ✅ 没有新增死代码（基线 ${baseline.length} 处历史遗留不在本次范围）`);
