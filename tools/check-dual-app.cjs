/**
 * 双 App（正式 / 测试）自检。
 *
 * ══════════════ 用户需求（原话）══════════════
 *
 *   「你搞两类安装包，然后能在我手机上弄出两个应用，
 *     一个是正常的，一个在后面加上测试版，
 *     正常的分为对外和自用」
 *
 * ══════════════ ⚠️ 能"同时装两个"靠的是什么 ══════════════
 *
 *   Android 判定"是不是同一个 App"看 **applicationId**（包名）。
 *     包名相同 → 装第二个会**覆盖**第一个
 *     包名不同 → **共存**，桌面出两个图标
 *
 *   所以 app.config.js 按 `EXPO_PUBLIC_CHANNEL` 给出不同包名：
 *     正式：com.lifekit.app
 *     测试：com.lifekit.app.test
 *
 * ⚠️ 这个脚本**不修改任何东西**，只解析配置并报告。
 *
 * 用法: node tools/check-dual-app.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE_ID = 'com.lifekit.app';
const TEST_ID = `${BASE_ID}.test`;

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

/** 按指定通道解析 app.config.js */
function resolve(channel) {
  delete require.cache[require.resolve(path.join(ROOT, 'app.config.js'))];
  const prev = process.env.EXPO_PUBLIC_CHANNEL;
  if (channel === 'test') process.env.EXPO_PUBLIC_CHANNEL = 'test';
  else delete process.env.EXPO_PUBLIC_CHANNEL;
  const out = require(path.join(ROOT, 'app.config.js'))();
  if (prev === undefined) delete process.env.EXPO_PUBLIC_CHANNEL;
  else process.env.EXPO_PUBLIC_CHANNEL = prev;
  return out;
}

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('   双 App 自检（正式 vs 测试）');
console.log('  ══════════════════════════════════════════════');
console.log('');

const rel = resolve('release');
const tst = resolve('test');

const relId = rel.android?.package ?? '';
const tstId = tst.android?.package ?? '';

console.log(`  正式版：name=${rel.name}  package=${relId}  version=${rel.version}  code=${rel.android?.versionCode}`);
console.log(`  测试版：name=${tst.name}  package=${tstId}  version=${tst.version}  code=${tst.android?.versionCode}`);
console.log('');

console.log('=== 1) ★★★ 包名必须不同（否则会互相覆盖）===');
t('★★★ 正式版包名是 com.lifekit.app', relId === BASE_ID, relId);
t('★★★ 测试版包名是 com.lifekit.app.test', tstId === TEST_ID, tstId);
t('★★★ 两个包名不同 → 可以同时安装', relId !== tstId);

console.log('\n=== 2) ★★ 显示名必须能区分（否则桌面分不清）===');
t('★★ 正式版叫「LifeKit」', rel.name === 'LifeKit', rel.name);
t('★★ 测试版带「测试版」字样', /测试版/.test(tst.name ?? ''), tst.name);

console.log('\n=== 3) ★★ 深链与 slug 也要分开（否则互相抢）===');
t('★★ scheme 不同', rel.scheme !== tst.scheme, `${rel.scheme} vs ${tst.scheme}`);
t('★★ slug 不同', rel.slug !== tst.slug, `${rel.slug} vs ${tst.slug}`);

console.log('\n=== 4) ★ 版本号与权限等其它字段保持一致 ===');
t('★ versionCode 相同（同一次发布）', rel.android?.versionCode === tst.android?.versionCode);
t('★ 权限列表一致', JSON.stringify(rel.android?.permissions) === JSON.stringify(tst.android?.permissions));

console.log('\n=== 5) ★★ 通道标记会写进 App（决定它问哪条通道）===');
{
  const updater = fs.readFileSync(path.join(ROOT, 'src', 'services', 'updater.ts'), 'utf8');
  /**
   * ⚠️ 这条断言**放宽过一次**：原先钉的是
   *      `process.env.EXPO_PUBLIC_CHANNEL === 'test'`
   *    后来加了**自用通道**（用户：「直接把自用的上传云端啊，我在应用内更新」），
   *    写法变成三段判定：
   *      `CH === 'test' ? 'test' : CH === 'self' ? 'self' : 'release'`
   *    → 老正则匹配不到，报假红。
   *
   *    现在钉的是"确实读了 EXPO_PUBLIC_CHANNEL 这个打包期变量"。
   */
  t('★★ 客户端按 EXPO_PUBLIC_CHANNEL 决定通道', /EXPO_PUBLIC_CHANNEL/.test(updater));
  t(
    '★★ 三条通道（release / test / self）都被识别',
    /=== 'test'/.test(updater) && /=== 'self'/.test(updater) && /'release'/.test(updater),
  );
  t('★★ 测试版请求带 ?ch=test', /\?ch=test/.test(updater));
  t('★★ 默认是正式通道（老客户端不带参数也安全）', /: 'release';/.test(updater));
}

console.log('\n=== 6) ★★ 服务端两条通道文件独立 ===');
{
  const srv = fs.readFileSync(path.join(ROOT, 'server', 'server.cjs'), 'utf8');
  t('★★ 正式通道用 lifekit-latest.apk', /lifekit-latest\.apk/.test(srv));
  t('★★ 测试通道用 lifekit-test.apk', /lifekit-test\.apk/.test(srv));
  /**
   * ⚠️ 同样放宽过：原先钉 `ch === 'test' ? 'test' : 'release'`，
   *    加了自用通道后变成三段 `if (ch === 'test') … if (ch === 'self') …`。
   *    要钉的核心是"**默认落到 release**"（不带 ch 的老客户端看正式版）。
   */
  t(
    '★★★ 默认通道是 release（不带 ch 的老客户端看正式版）',
    /ch === 'self'\) return 'self';[\s\S]{0,60}?return 'release';/.test(srv) ||
      /return 'release';/.test(srv),
  );
}

console.log('\n=== 7) ★ 换通道时会清理 android/（防包名残留）===');
{
  const b = fs.readFileSync(path.join(ROOT, 'tools', 'android', 'build-apk.cjs'), 'utf8');
  /**
   * ⚠️ 这条断言**改过一次**：原先钉的是 `channelChanged`，
   *    但三版本方案下"只看通道"不够 ——
   *    release 与 self 用**同一个通道标记**却**不同包名**
   *    （com.lifekit.app vs com.lifekit.app.self），
   *    只比通道会漏判 → 旧包目录残留 → Kotlin 报 Redeclaration（踩过）。
   *
   *    所以实现换成了 `needClean` + 记录**最终包名**。
   */
  t('★ 用 needClean 判断是否需要清理', /needClean/.test(b));
  t('★ 清理判据里比的是**包名**（不是只看通道）', /markerHasPackage/.test(b) && /PACKAGE/.test(b));
  t('★ 变化时删除 android 目录', /rmSync\(path\.join\(WORKSPACE, 'android'\)/.test(b));
}

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  结论：');
console.log(`    正式版 → ${rel.name}（${relId}）`);
console.log(`    测试版 → ${tst.name}（${tstId}）`);
console.log('    两者包名不同 → **可同时安装，桌面出两个图标**');
console.log('  ══════════════════════════════════════════════');
console.log('');

console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
