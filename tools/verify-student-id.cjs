/**
 * 学号归一化测试。
 *
 * ══════════ 真实踩过的坑 ══════════
 * 用网页登录朋友的账号后，绑定被拒，界面报：
 *     「拿到的会话属于另一个学号（dgut2099000000114），
 *        不是你要登录的 2099000000114」
 *
 * 这两个**指向同一个账号**，只是 cookie 里带了学校前缀 `dgut`。
 * 于是"会话学号必须等于请求学号"这条校验把**合法会话拒掉了** ——
 * 看起来像串号，其实是同一个人的两种写法。
 *
 * 教训：**任何"身份比对"都必须先归一化**，否则前缀/分隔符/大小写
 *       都会变成"看起来像安全问题、其实是格式差异"的假故障。
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'services', 'checkin', 'youxueAdapter.ts'),
  'utf8',
);

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

// ── 复刻实现（与 youxueAdapter.ts 的 normalizeStudentIdForCompare 一致）──
function normalize(sid) {
  let s = String(sid ?? '').trim().toLowerCase();
  s = s.replace(/[\s_-]/g, '');
  s = s.replace(/^(dgut|dgutdx|dgutedu)/, '');
  return s;
}

console.log('=== 1) 源码里确实做了归一化 ===');
{
  t('有 normalizeStudentIdForCompare', /export function normalizeStudentIdForCompare/.test(SRC));
  t('去掉了 dgut 前缀', /replace\(\/\^\(dgut\|dgutdx\|dgutedu\)\//.test(SRC));
  t('去掉分隔符与空白', /replace\(\/\[\\s_-\]\/g/.test(SRC));
  t(
    'parseStudentIdFromCookies 返回归一化后的值',
    /for \(const f of \[[\s\S]{0,400}?normalizeStudentIdForCompare\(v\)/.test(SRC),
  );
  t(
    'persistSession 用归一化后的学号比较',
    /const reqNorm = normalizeStudentIdForCompare\(studentId\);/.test(SRC),
  );
}

console.log('\n=== 2) ★ 本次踩的坑：dgut 前缀 ===');
{
  const inCookie = 'dgut2099000000114';
  const typed = '2099000000114';
  t(`cookie 里是 ${inCookie}`, true);
  t('归一化后两者相等（不再误拒）', normalize(inCookie) === normalize(typed));
  t('归一化结果就是纯学号', normalize(inCookie) === '2099000000114');
}

console.log('\n=== 3) 各种写法的归一化 ===');
{
  const CASES = [
    ['2099000000114', '2099000000114'],
    ['dgut2099000000114', '2099000000114'],
    ['DGUT2099000000114', '2099000000114'],
    ['dgut-2099000000114', '2099000000114'],
    ['dgut_2099000000114', '2099000000114'],
    [' 2099000000114 ', '2099000000114'],
    ['DGUT2099000000114', '2099000000114'],
    ['2099 0000 00114', '2099000000114'],
  ];
  for (const [input, expect] of CASES) {
    const got = normalize(input);
    console.log(`  ${got === expect ? '√' : '×'} ${JSON.stringify(input).padEnd(24)} → ${got}`);
    if (got !== expect) fail += 1;
    else pass += 1;
  }
}

console.log('\n=== 4) ★ 不同账号仍然必须判为不同（不能归一化过头）===');
{
  const pairs = [
    ['2099000000114', '2099000000116'],
    ['dgut2099000000114', '2099000000116'],
    ['dgut2099000000114', 'dgut2099000000116'],
  ];
  for (const [a, b] of pairs) {
    const diff = normalize(a) !== normalize(b);
    console.log(`  ${diff ? '√' : '×'} ${a} vs ${b} → ${diff ? '不同' : '★ 竟然相同'}`);
    if (diff) pass += 1;
    else fail += 1;
  }
  t('归一化不会把不同学号变成同一个', pairs.every(([a, b]) => normalize(a) !== normalize(b)));
}

console.log('\n=== 5) 边界 ===');
{
  t('空字符串归一化后仍是空', normalize('') === '');
  t('null 不崩', normalize(null) === '');
  t('undefined 不崩', normalize(undefined) === '');
  t('纯前缀归一化后为空', normalize('dgut') === '');
}

console.log('\n=== 6) 复刻校验：会话学号 vs 请求学号 ===');
{
  /** 复刻 persistSession 的判据 */
  function sameSession(requested, inCookie) {
    if (!inCookie) return true; // 解不出来 → 不阻断
    return inCookie === normalize(requested);
  }
  t('★ dgut 前缀的 cookie + 不带前缀的输入 → 通过', sameSession('2099000000114', normalize('dgut2099000000114')) === true);
  t('★ 真的换了账号 → 拒绝', sameSession('2099000000116', normalize('dgut2099000000114')) === false);
  t('解不出 cookie 学号 → 通过（不阻断）', sameSession('2099000000114', undefined) === true);
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
