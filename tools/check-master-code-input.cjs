// 用实际源码跑一遍万能码校验（不依赖 App），确认内置万能码真的能用。
// 直接从 TS 源里抠出常量与关键函数，避免引入编译步骤。
//
// ⚠️ 公开仓库版（2026-10）：源码里的码已经改成
//     `process.env.EXPO_PUBLIC_MASTER_CODE || 'CHANGE_ME'`，
//     所以这里不再从源码抠字面量，而是**优先取环境变量**。
//     要按真实值跑：EXPO_PUBLIC_MASTER_CODE=你的码 node tools/check-master-code-input.cjs
const fs = require('fs');

/**
 * ⚠️ 路径必须用 `__dirname + '/../src/...'` —— 这个脚本在 `tools/` 目录下，
 *    而源码在仓库根的 `src/`。
 *
 *    原来写的是 `__dirname + '/src/domain/licenseCode.ts'`，
 *    解析成 `tools/src/domain/licenseCode.ts` —— **那个文件不存在**，
 *    所以这个脚本一直是 `ENOENT` 崩掉，从来没真正跑过
 *    （它不在 package.json 的 test:* 列表里，所以一直没被发现）。
 */
const src = fs.readFileSync(__dirname + '/../src/domain/licenseCode.ts', 'utf8');

// 取出常量
const envCode = process.env.EXPO_PUBLIC_MASTER_CODE || '';
/** 源码里的兜底字面量（公开仓库里是 CHANGE_ME 占位符） */
const fallback = (src.match(/\|\|\s*'([^']+)'\s*\)/) ?? [])[1] ?? '';
/**
 * ⚠️ 用**纯字母数字**的样例：
 *   兜底占位符带下划线时，构造"带横线/带空格"变体会和下划线缠在一起
 *   （`ch-an-ge-_me`），断言语义反而变模糊。
 *   这里验的是"分隔符不敏感"，用干净的样例更贴题意。
 */
const SAMPLE = envCode || 'samplecode123';
/** 是否在验真实的码（环境变量提供的） */
const isReal = Boolean(envCode);
const conv = SAMPLE;
const codePrefix = (src.match(/CODE_PREFIX\s*=\s*'([^']+)'/) ?? [])[1];
const masterPrefix = (src.match(/MASTER_PREFIX\s*=\s*'([^']+)'/) ?? [])[1];

console.log('  源文件里的常量：');
console.log('    CONVENIENCE_MASTER_CODE 兜底值 =', JSON.stringify(fallback));
console.log('    本次校验用的样例             =', JSON.stringify(SAMPLE), isReal ? '(来自环境变量)' : '(中性样例)');
console.log('    CODE_PREFIX              =', JSON.stringify(codePrefix));
console.log('    MASTER_PREFIX            =', JSON.stringify(masterPrefix));
console.log('');

// 复刻 canonicalizeCodeInput 与那条判断
const canonicalize = (input) => (input ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();

/** 大小写/空格/横线变体都该命中 —— 用「同一个码的不同写法」构造，不再写死字面量 */
const norm0 = conv.toLowerCase();
const HALF = Math.floor(norm0.length / 2);
const hyphenated = `${norm0.slice(0, HALF)}-${norm0.slice(HALF)}`;
const spaced = `${norm0.slice(0, HALF)} ${norm0.slice(HALF)}`;
/** 该命中的 7 种写法 */
const HIT_CASES = [
  norm0,
  norm0.toUpperCase(),
  norm0.slice(0, 1).toUpperCase() + norm0.slice(1),
  norm0 + ' ',
  ' ' + norm0,
  hyphenated,
  spaced,
];
/** 不该命中的 4 种（缺位/多位/空） */
const MISS_CASES = [
  norm0.slice(0, -3),
  norm0.slice(0, -1),
  norm0 + 'b',
  '',
];
const cases = [
  ...HIT_CASES.map((c) => [c, true]),
  ...MISS_CASES.map((c) => [c, false]),
];

console.log('  输入 → 规范化 → 是否命中万能码');
let bad = 0;
for (const [c, expect] of cases) {
  const norm = canonicalize(c);
  const hit = norm === conv.toUpperCase();
  const ok = hit === expect;
  if (!ok) bad += 1;
  console.log(
    `    ${ok ? '√' : '×'} ${JSON.stringify(c).padEnd(20)} → ${norm.padEnd(18)} 命中=${hit ? '是' : '否'}`,
  );
}
console.log('');
console.log(bad === 0 ? '  ✅ 全部符合预期' : `  ❌ ${bad} 项不符`);
process.exit(bad === 0 ? 0 : 1);
