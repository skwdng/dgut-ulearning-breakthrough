/**
 * 回归测试：**改动默认只发测试版；正式版必须显式批准**。
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
  /**
   * ⚠️ 2026-10：条件从 `!TEST && !SELF && !ALLOW_OFFICIAL`
   *    变成 `!TEST && !ALLOW_OFFICIAL`（自用版删除后没有 SELF 了）。
   *    断言跟着改 —— 否则测试会一直失败，而**失败的测试等于没有测试**。
   */
  /if \(!TEST && !ALLOW_OFFICIAL\) \{\s*TEST = true;/.test(RELEASE),
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
  '★★ 未批准且非 test → 拒绝覆盖正式存档',
  /if \(!IS_TEST && !ALLOW_OFFICIAL\)[\s\S]{0,700}?process\.exit\(2\)/.test(PUBLISH),
);
t(
  '★★ 两条通道文件名独立定义（自用通道已删）',
  /lifekit-test\.apk/.test(PUBLISH) && /lifekit-latest\.apk/.test(PUBLISH),
);
/**
 * ⚠️ 2026-10：自用版删除后，`lifekit-self.apk` 这个**文件名**不应该再被使用。
 *    留着的话说明某处还能产出"含明文万能码"的存档 —— 那是安全回退。
 *
 * ⚠️ 必须**先剥掉注释再判** —— 我自己在注释里写了"原来叫 lifekit-self.apk"
 *    这类历史说明，直接搜文本会把注释算成失败（第一版就踩了这个）。
 *    这也是本项目反复出现的坑：判据要针对**代码**，不是**文本**。
 */
const PUBLISH_CODE = PUBLISH.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
t('★★ 自用通道文件已彻底移除（只看代码）', !/lifekit-self|version-self/.test(PUBLISH_CODE));
t('★★ release 不再有 --self 开关', !/\bSELF\b/.test(RELEASE.replace(/\/\*[\s\S]*?\*\//g, '')));

console.log('');
console.log('=== 4) ★★ 万能码一律剥离（自用版删除后不再有例外）===');
t('★★ STRIP_MASTER 恒为 true', /const STRIP_MASTER = true;/.test(RELEASE));
t('★★ 有"一律剥离"的提示', /万能码已一律剥离/.test(RELEASE));

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  想动正式版时，命令长这样：');
console.log('    正式：node tools\\release.cjs "说明" --dist --approved');
console.log('  其他情况（默认）：');
console.log('    node tools\\release.cjs "说明" --dist        ← 自动走测试版');
console.log('    node tools\\release.cjs "说明" --dist --test ← 同上');
console.log('  ⚠️ 自用版已删除（2026-10），不再有 --self 通道');
console.log('  ══════════════════════════════════════════════');
console.log('');

console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
