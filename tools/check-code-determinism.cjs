/**
 * 验证：`generateLicenseCode` 对同一学号是否**确定性**输出。
 *
 * ══════════════ 为什么这个验证很关键 ══════════════
 *
 * 用户踩的坑（2026-10）：
 *   「我用的桌面上的这个给他生成的」
 *   → 他在**本地服务器**给 4 个同学生成了授权码
 *   → 但同学的手机连的是**云端** → 云端没有这些码 → 全被拦住
 *
 * 补救有两条路：
 *   A. 让云端也生成 → 如果算法**确定性**，生成的码和本地**完全一样**，
 *      同学**不用换码**（体验最好）
 *   B. 如果算法带随机数 → 码不同 → 必须把**云端新码**重新发给同学
 *
 * 所以先跑这个，再决定怎么补救。
 *
 * 用法: node tools/check-code-determinism.cjs
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { generateLicenseCode } = require(path.join(ROOT, 'server', 'licenseCode.cjs'));

/**
 * ⚠️ 公开仓库版（2026-10）：这里原先写死了**一位真实同学**的学号和他的授权码
 *    （`LOCAL_CODE`），用来验证"云端重新签发后同学不用换码"。
 *    那属于他人个人信息，不进公开仓库。
 *
 *    改成：**从本地 data.json 里读**那条记录（本地调试数据，不入库）；
 *    读不到就只验"算法是确定性的"这一条，不误报失败。
 */
const SID = '2099000000127';
let LOCAL_CODE = '';
let LOCAL_EXPIRES = null;
try {
  const db = JSON.parse(
    require('node:fs').readFileSync(path.join(ROOT, 'server', 'data.json'), 'utf8'),
  );
  const rec = db.users?.[SID];
  if (rec?.code) {
    LOCAL_CODE = rec.code;
    LOCAL_EXPIRES = rec.expiresAt ?? null;
  }
} catch {
  /* 没有本地数据文件 → 跳过"对得上"那一条 */
}

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  √ ${name}`);
  } else {
    fail += 1;
    console.log(`  × ${name}${extra ? '  → ' + extra : ''}`);
  }
};

console.log('');
console.log('  同一学号连续生成 3 次，看是否一样：');
console.log('');
const a = generateLicenseCode(SID);
const b = generateLicenseCode(SID);
const c = generateLicenseCode(SID);
console.log(`    1) ${a}`);
console.log(`    2) ${b}`);
console.log(`    3) ${c}`);
console.log('');

const deterministic = a === b && b === c;
t('★★★ 算法是确定性的（同输入 → 同输出）', deterministic, deterministic ? '' : '输出不一样，说明带随机数');

console.log('');
if (LOCAL_CODE) {
  console.log(`  本地那份码：${LOCAL_CODE}`);
  console.log(`  这里生成的：${a}`);
  console.log('');
  t(
    '★★★ 能和本地那份码对上（对上 = 同学不用换码）',
    a === LOCAL_CODE,
    a === LOCAL_CODE ? '' : '对不上 → 必须把云端新码重新发给他',
  );
} else {
  console.log('  （跳过"与本地那份码对上"：本地 data.json 里没有这条记录）');
}

console.log('');
console.log('  ══════════════════════════════════════════════');
if (!deterministic) {
  console.log('  ❌ 结论：算法带随机数');
  console.log('     → 云端重新签发会产生**不同**的码');
  console.log('     → 必须把云端新码重新发给同学');
} else if (!LOCAL_CODE) {
  console.log('  ✅ 结论：算法是确定性的（本地无对照记录，未做逐码比对）');
} else if (a === LOCAL_CODE) {
  console.log('  ✅ 结论：码是确定性的，且与本地一致');
  console.log('     → 让云端重新签发，**同学不用换码**');
} else {
  console.log('  ⚠️ 结论：算法确定性，但与本地那份**不一致**');
  console.log('     → 差异可能来自**有效期**（本地永久 / 云端带了到期日）');
  console.log(`     → 本地那条记录的 codeExpiresAt = ${LOCAL_EXPIRES}`);
}
console.log('  ══════════════════════════════════════════════');
console.log('');

process.exit(fail === 0 ? 0 : 1);
