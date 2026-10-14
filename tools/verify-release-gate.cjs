/**
 * 回归测试：**改动默认只发测试版；正式版/自用版必须显式批准**。
 *
 * ══════════════ 用户指示（原话）══════════════
 *
 *   「这个正式版就是我现在发布的版本，不要动那个了，
 *     以后我要改所有都改到测试板上，我说可以再改到正式版上」
 *
 *   「现在开始我说可以改正式版和自用版才可以改，其他默认改测试版」
 *
 * ══════════════ 为什么这条规矩要钉死 ══════════════
 *
 *   · 正式版**已经发给同学**了，覆盖它会直接影响所有人（而且现在开着 force）
 *   · 自用版**含明文万能码**（能改任何人的签到状态），上传后服务器上可被下载
 *
 *   两者都不该在"顺手跑一下发布脚本"时被无意改掉。
 *   ⚠️ 这个项目已经出现过一次真实事故：
 *      直接调 build-apk.cjs 绕过了剥离逻辑，打出了**带万能码的对外版**。
 *      那次是靠事后解包搜字符串才发现的。所以必须由测试盯着。
 *
 * 用法: node tools/verify-release-gate.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = fs.readFileSync(path.join(ROOT, 'tools', 'release.cjs'), 'utf8');
const PUBLISH = fs.readFileSync(path.join(ROOT, 'tools', 'publish-apk.cjs'), 'utf8');

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
console.log('   发布闸门：默认只改测试版');
console.log('  ══════════════════════════════════════════════');
console.log('');

console.log('=== 1) ★★★ 正式 / 自用 必须显式批准 ===');
t('★★★ 定义了 APPROVED（--approved）', /const APPROVED = process\.argv\.includes\('--approved'\)/.test(RELEASE));
t(
  '★★★ 未批准且不是测试版 → 退出（码 2）',
  /if \(NEEDS_APPROVAL && !APPROVED\)[\s\S]{0,900}?process\.exit\(2\)/.test(RELEASE),
);
t(
  '★★ 提示里写明"默认发测试版"',
  /默认发测试版/.test(RELEASE),
);
t(
  '★★ 提示里引用用户原话',
  /其他默认改测试版/.test(RELEASE),
);
t(
  '★★ 兼容历史参数 --allow-official（免得老命令突然失效）',
  /--allow-official/.test(RELEASE),
);

console.log('');
console.log('=== 2) ★★★ 未指定版本时**默认按测试版跑** ===');
t(
  '★★★ 有"默认切测试版"的逻辑',
  /if \(!TEST && !SELF && !ALLOW_OFFICIAL\) \{\s*TEST = true;/.test(RELEASE),
);
t(
  '★★ TEST 必须是 let（要能被改）',
  /let TEST = process\.argv\.includes\('--test'\)/.test(RELEASE),
  '写成 const 会在运行时抛 "Assignment to constant variable"（踩过）',
);
t(
  '★★ 打印说明（让操作者知道走的是测试版）',
  /默认按测试版处理/.test(RELEASE),
);

console.log('');
console.log('=== 3) ★★ publish 那一层也有冻结闸（双保险）===');
t(
  '★★ 未批准且非 test/self → 拒绝覆盖正式存档',
  /if \(!IS_TEST && !IS_SELF && !ALLOW_OFFICIAL\)[\s\S]{0,700}?process\.exit\(2\)/.test(PUBLISH),
);
t('★★ 三条通道文件名独立定义', /lifekit-self\.apk/.test(PUBLISH) && /lifekit-test\.apk/.test(PUBLISH) && /lifekit-latest\.apk/.test(PUBLISH));

console.log('');
console.log('=== 4) ★★ 自用版走自己的通道（用户要的应用内更新）===');
t('★★ release 会把 --self 传给 publish', /SELF \? \['--self'\]/.test(RELEASE));
t('★★ release 会把 --self 传给 deploy', /SELF \? \['--self'\]/.test(RELEASE));
t('★★ 自用版**不再**提前退出（要上传）', !/自用版已打好（未上传、未部署）/.test(RELEASE));

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  想动正式版/自用时，命令长这样：');
console.log('    正式：node tools\\release.cjs "说明" --dist --approved');
console.log('    自用：node tools\\release.cjs "说明" --dist --self --approved');
console.log('  其他情况（默认）：');
console.log('    node tools\\release.cjs "说明" --dist        ← 自动走测试版');
console.log('    node tools\\release.cjs "说明" --dist --test ← 同上');
console.log('  ══════════════════════════════════════════════');
console.log('');

console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
