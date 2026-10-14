/**
 * 回归测试：**配额校验送的码不能是"可能过期的个人码"**。
 *
 * ══════════════ 🚨 这个 bug 是用户截图报出来的（2026-10）══════════════
 *
 * 现象：
 *   改签到状态 → 横幅「改成『已签到』没有成功 / 这个授权码不属于当前学号」
 *   而设置页明明显示有权（横幅写着「个人授权码权限 · 只能改自己的」）。
 *
 * 复现（打云端 `/api/consume` 实测，三条都验过）：
 *   · 云端记的个人码 `LK1-…222MY-…`          → allow=true  可以使用
 *   · 万能码（内置码 / LKM- 签名码）          → allow=true  可以使用
 *   · **旧**个人码 `LK1-…2MLVF-…`            → allow=**false**
 *                                              reason=code_mismatch
 *                                              message=「这个授权码不属于当前学号」
 *
 * 根因：
 *   `stored.personalCode` 是当初从服务器换来的，**服务器换过码之后它就作废了**。
 *   而"万能码被管理员改掉 → 降级用个人码"这条降级路径会把它送上去 →
 *   服务器不认 → 用户被拦死，而且**报错信息完全看不出真正原因**。
 *
 * 修法：
 *   新增 `quotaCode` —— **手里是万能码就优先送万能码**（服务器认它、
 *   不绑学号），只有确实没万能码时才退回个人码。
 *   signStore 的配额调用从 `code` 改成 `quotaCode`。
 *
 * 用法: node tools/verify-quota-code.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const UNLOCK = fs.readFileSync(path.join(ROOT, 'src', 'state', 'unlockStore.tsx'), 'utf8');
const SIGN = fs.readFileSync(path.join(ROOT, 'src', 'state', 'signStore.tsx'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'server.cjs'), 'utf8');

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
console.log('   配额码（quotaCode）：不能送过期的个人码');
console.log('  ══════════════════════════════════════════════');
console.log('');

console.log('=== 1) 客户端：选码规则 ===');
t('★★★ unlockStore 暴露了 quotaCode', /quotaCode: string \| null/.test(UNLOCK));
t(
  '★★★ 是万能码时**优先送万能码**（不送可能过期的个人码）',
  /if \(isMaster\) return stored\.code;/.test(UNLOCK),
);
t(
  '★ 没有万能码时才退回个人码',
  /return stored\.personalCode \|\| stored\.code;/.test(UNLOCK),
);
t(
  '★★★ signStore 的配额调用用的是 quotaCode（不是 code）',
  /quotaCode: unlockCode \} = useUnlock\(\)/.test(SIGN) &&
    /consumeQuota\(base, \{ studentId: sid, code: unlockCode/.test(SIGN),
);
t(
  '★★ 不再直接解构 code 当配额码用（否则降级时又会送旧码）',
  !/scope, code: unlockCode \} = useUnlock\(\)/.test(SIGN),
);

console.log('');
console.log('=== 2) 注释留档（说明为什么不能用旧个人码）===');
/**
 * ⚠️ 这条断言的写法要跟注释实际用词一致 ——
 *    第一版写成 /服务器换码后它就作废/，而源码里是「服务器换码后**就作废**了」，
 *    差一个"就"的位置就报假红。所以两边都允许。
 */
t(
  '★★ 说明了"个人码换过就作废"',
  /服务器换码后就作废|换过码之后就作废|换码后.{0,6}作废/.test(UNLOCK),
);
t('★★ 引用了用户看到的报错原文', /这个授权码不属于当前学号/.test(UNLOCK));

console.log('');
console.log('=== 3) 服务端：万能码必须能被认（这条修复也要在）===');
t(
  '★★★ /api/consume 先判万能码再比个人码',
  /const isMaster = verifyMasterCode\(db, code\);[\s\S]{0,220}?if \(!isMaster\)/.test(SERVER),
);
/**
 * ⚠️ 这两条**改过一次**：原先把报错文案钉成
 *      `message: '这个授权码不属于当前学号'`
 *    后来我把文案改**清楚**了（因为原话完全指不出原因，连我自己都查了半天）：
 *      现在会告诉用户"是旧的、已作废的码；去清除后重填；推荐万能码"。
 *    → 老断言匹配不到，报假红。
 *
 *    现在钉两件事：
 *      ① 只有**非万能码**才会走 code_mismatch（万能码必须先放行）
 *      ② 报错文案里**必须给出可执行的下一步**（这是改文案的目的）
 */
t(
  '★★ 只有非万能码才走 code_mismatch 分支',
  /**
   * ⚠️ 窗口从 `const isMaster = …` 开始算 —— 中间隔着一段解释性注释，
   *    从 `if (!isMaster)` 起算会不够（第一版给了 300 字符，报假红）。
   */
  /const isMaster = verifyMasterCode\(db, code\);[\s\S]{0,900}?reason: 'code_mismatch'/.test(SERVER),
);
t(
  '★★★ 报错文案给出了可执行的下一步（不是干巴巴一句"不属于"）',
  /reason: 'code_mismatch'[\s\S]{0,600}?清除/.test(SERVER) &&
    /reason: 'code_mismatch'[\s\S]{0,900}?万能码/.test(SERVER),
);
t('★★ 保留了用户看到过的那句原文（便于对照排查）', /不属于当前学号/.test(SERVER));

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  为什么这条测试值得留着：');
console.log('    这个 bug **报错信息和真正原因完全无关** ——');
console.log('    表面是"码不属于这个学号"，实际是"客户端送了一份过期个人码"。');
console.log('    没有这条钉子，以后改降级逻辑很容易又踩回去。');
console.log('  ══════════════════════════════════════════════');
console.log('');

console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
