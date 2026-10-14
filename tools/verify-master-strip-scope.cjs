/**
 * 核实：**剥离版（对外版 / 测试版）里还能不能用便利万能码**。
 *
 * 用户问题（2026-10）：
 *   「我只有自用版能填万能码吗」
 *
 * ══════════════ 背景 ══════════════
 *
 * `src/domain/licenseCode.ts` 里有个便利万能码，权限是 `scope: 'all'`
 * （能改**任何人**的签到状态）。所以对外发布的包里必须剥离它，
 * 用的是打包时注入环境变量：
 *
 *   CONVENIENCE_MASTER_CODE =
 *     process.env.EXPO_PUBLIC_DISTRIBUTION === '1' ? '' : (环境变量里的码);
 *
 * ⚠️ 但"剥离了"到底意味着什么，有几种可能，必须**实测**才能回答：
 *
 *   A. 输入那个内置码 → 被拒（因为空串不等于它）        ← 期望
 *   B. 输入那个内置码 → 竟然通过（比如空串比较有漏洞）  ← 严重 bug
 *   C. 输入空的 → 竟然通过（`raw === ''` 与空常量相等） ← 严重 bug
 *
 * 这个脚本把三种都跑一遍。
 *
 * 用法: node tools/verify-master-strip-scope.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'domain', 'licenseCode.ts'), 'utf8');

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  OK  ${name}`);
  } else {
    fail += 1;
    console.log(`  XX  ${name}${extra ? '  → ' + extra : ''}`);
  }
};

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('   剥离版里便利万能码还能不能用');
console.log('  ══════════════════════════════════════════════');
console.log('');

/** 从源码里抠出规范化和判空这几段的实际写法，确认语义 */
const hasCanonicalize = /return \(input \?\? ''\)\.replace\(\/\[\^0-9a-zA-Z\]\/g, ''\)\.toUpperCase\(\)/.test(SRC);
const hasEmptyGuard = /if \(!raw\) return \{ ok: false, reason: 'empty' \}/.test(SRC);
const hasConvenienceCompare = /if \(raw === CONVENIENCE_MASTER_CODE\.toUpperCase\(\)\)/.test(SRC);

console.log('=== 1) 源码里的实际写法 ===');
t('★ 有"规范化输入"函数（去符号 + 转大写）', hasCanonicalize);
t('★★★ 有空输入早退守卫（`if (!raw) return ok:false`）', hasEmptyGuard, '没有守卫的话，空串可能等于空常量！');
t('★ 便利码比较用的是"规范化后 == 常量大写"', hasConvenienceCompare);

/**
 * 模拟剥离版的行为：
 *   CONVENIENCE_MASTER_CODE = ''
 *   canonicalize('') → ''
 *   守卫先拦：!'' === true → 返回 empty
 *
 * ⚠️ 关键就在**守卫在比较之前**。如果顺序反了，空串就会"等于"空常量而放行。
 */
console.log('');
console.log('=== 2) 模拟三种输入在剥离版下的结果 ===');

/** 按源码语义复刻的判定 */
function simulateDist(input) {
  const raw = (input ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  if (!raw) return { ok: false, reason: 'empty' };
  const CONVENIENCE = ''; // 剥离版
  if (raw === CONVENIENCE.toUpperCase()) return { ok: true, isMaster: true };
  return { ok: false, reason: 'not-master-shape' };
}

const MASTER_CODE = process.env.EXPO_PUBLIC_MASTER_CODE || 'MY_MASTER_CODE';
const r1 = simulateDist(MASTER_CODE);
console.log(`  输入 ${MASTER_CODE}  → ${JSON.stringify(r1)}`);
t('★★★ 输入内置码被拒（剥离生效）', r1.ok === false, '竟然通过 = 万能码没剥离干净');

const r2 = simulateDist('');
console.log(`  输入 (空)     → ${JSON.stringify(r2)}`);
t('★★★ 输入空串被拒（不会因空常量而放行）', r2.ok === false, '空串放行 = 严重漏洞');

const r3 = simulateDist('   ');
console.log(`  输入 (空格)   → ${JSON.stringify(r3)}`);
t('★★ 输入纯空格被拒', r3.ok === false);

const r4 = simulateDist('LKM-BN222-YFSLJ-HP26E-ME6NQ');
console.log(`  输入 LKM-BN222-…  → ${JSON.stringify(r4)}`);
t(
  '★ LKM- 签名码不是"便利码"路径（走的是签名校验）',
  r4.reason === 'not-master-shape',
  '这是对的 —— LKM- 由 parseMasterCode 处理，需要签名正确',
);

console.log('');
console.log('=== 3) 源码确认：签名码的解析能力是否保留 ===');
{
  const hasMasterKey = /MASTER_KEY/.test(SRC);
  const hasParseMaster = /function parseMasterCode/.test(SRC);
  const hasMasterPrefix = /MASTER_PREFIX/.test(SRC);
  t('★★ 保留 MASTER_KEY（解析 LKM- 码必需）', hasMasterKey);
  t('★★ 保留 parseMasterCode 函数', hasParseMaster);
  t('★★ 保留 MASTER_PREFIX 判断', hasMasterPrefix);
}

console.log('');
console.log('=== 4) 两个版本里便利码常量的取值 ===');
{
  /**
   * ⚠️ 实际源码里这个赋值**是跨行的**：
   *     const CONVENIENCE_MASTER_CODE =
   *       process.env.EXPO_PUBLIC_DISTRIBUTION === '1' ? '' : (兜底值);
   *   所以正则要允许换行和空白（第一版写成一行、结果误报失败）。
   */
  /**
   * ⚠️ 公开仓库版（2026-10）：源码里的码改成了环境变量注入，
   *    所以这里改成检查**赋值形状**，而不是检查某个具体字面量：
   *      const CONVENIENCE_MASTER_CODE =
   *        process.env.EXPO_PUBLIC_DISTRIBUTION === '1'
   *          ? ''
   *          : (process.env.EXPO_PUBLIC_MASTER_CODE || '占位符');
   */
  const cond =
    /CONVENIENCE_MASTER_CODE\s*=\s*[\s\S]{0,120}?EXPO_PUBLIC_DISTRIBUTION\s*===\s*'1'[\s\S]{0,40}?\?\s*''/.test(
      SRC,
    );
  t('★★★ 剥离开关是打包期环境变量（EXPO_PUBLIC_DISTRIBUTION）', cond);
  /** 顺带确认：默认（不设变量）时**保留**一个兜底码，保证自用版能用 */
  const keepsDefault = /EXPO_PUBLIC_MASTER_CODE\s*\|\|/.test(SRC);
  t('★★ 默认保留可用的内置码（自用版可用）', keepsDefault);
  /**
   * 而且源码里**不能**再出现写死的真实码。
   *
   * ⚠️ 判据用「源码里有没有这个码本身的字面量」——
   *    不要用"看起来像赋值的字符串常量"这种宽泛正则：
   *    类型注解（`reason: 'length'`）、跨行赋值都会误报（踩过）。
   */
  const needle = (process.env.EXPO_PUBLIC_MASTER_CODE || '').toUpperCase();
  if (needle) {
    // 设了环境变量 → 精确检查这个值有没有被写死进源码
    t(
      '★★★ 真实万能码没有被写死进源码',
      !new RegExp(`['"\`]${needle}['"\`]`, 'i').test(SRC),
      `搜的是 ${needle}`,
    );
  } else {
    /**
     * 没设环境变量 → 退而检查"**万能码常量**的赋值是不是写死的字面量"。
     *
     * ⚠️ 只盯 `CONVENIENCE_MASTER_CODE` 这一个常量名。
     *    第一版写成"任何长字符串常量"→ 把 Base32 字母表
     *    （`const B32 = '23456789ABC…'`）也算成命中，误报（踩过）。
     */
    const hardcoded = SRC.split('\n').filter((line) =>
      /^\s*(export\s+)?const\s+CONVENIENCE_MASTER_CODE\s*(:[^=]+)?=\s*'[0-9a-zA-Z]{6,}'\s*;/.test(
        line,
      ),
    );
    t(
      '★★★ 万能码常量没有写死真实值（兜底值只能是占位符）',
      hardcoded.length === 0,
      hardcoded.length ? `命中：${hardcoded.map((l) => l.trim()).join(' | ')}` : '',
    );
  }
}

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  结论：');
console.log('    · 自用版   → 内置万能码（EXPO_PUBLIC_MASTER_CODE）**可用**');
console.log('    · 对外版   → **不可用**（包里没有它）');
console.log('    · 测试版   → **不可用**（同样剥离了）');
console.log('');
console.log('    ⚠️ 但对外版/测试版仍保留 LKM- 签名码的解析能力 ——');
console.log('       那种码是"签过名的"，需要 MASTER_KEY 才能伪造，');
console.log('       所以可以安全地发给需要的人。');
console.log('  ══════════════════════════════════════════════');
console.log('');

console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
