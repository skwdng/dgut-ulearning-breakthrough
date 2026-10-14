/**
 * 一键发布：把当前 app.json 的版本打包并推到 VPS。
 *
 * ══════════════ 用户的需求 ══════════════
 * 「下次每次改完之后新版本直接上传，我在手机上直接更新」
 *
 * 所以这个脚本把整条链串起来：
 *   ① 读 app.json 的 version / versionCode（确认确实是新版本）
 *   ② 打包 APK（arm64，33 MB 左右）
 *   ③ 发布到 server/apk/（写 version.json）
 *   ④ 上传到 VPS
 *   ⑤ 验证 /api/version 返回正确
 *
 * ⚠️ 为什么不用 Gradle 直接打包而要走 build-apk.cjs：
 *    那个脚本还负责 prebuild 后接线原生模块（wire-native），
 *    以及把 versionCode 写进 build.gradle。绕开它会打出错的包。
 *
 * 用法:
 *   node tools/release.cjs "这次改了什么"
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NOTE = process.argv[2] ?? '';
/**
 * ★★★ 是否为"对外发布版"。
 *
 * 用法：node tools/release.cjs "说明" --dist
 *   → 剥离包里的明文便利万能码（见 src/domain/licenseCode.ts 的注释）
 *   → 自用版（不带 --dist）保持原样，内置万能码能用
 */
const DIST = process.argv.includes('--dist');

/**
 * ══════════════ ★★★ 正式通道冻结（用户指示，2026-10）══════════════
 *
 * 用户原话：
 *   「这个正式版就是我现在发布的版本，不要动那个了，
 *     以后我要改所有都改到测试板上，我说可以再改到正式版上」
 *   「现在开始我说可以改正式版和自用版才可以改，其他默认改测试版」
 *
 * ⚠️ 也就是说：
 *   · 正式通道（lifekit-latest.apk）**已经发给别人了**，不能随便覆盖
 *   · 自用通道（lifekit-self.apk）**含明文万能码**，上传后可被下载
 *   · 所有改动**默认只发测试通道**（`--test`）
 *   · 只有用户**明确说可以**了，才动正式版 / 自用版
 *
 * 所以这里加一道闸：**动正式/自用必须显式批准** ——
 *   要求额外带 `--approved`，否则直接退出，
 *   并在提示里说清"默认应该发测试版"。
 *
 * 这样我（或用户）手滑跑错参数时，**不会静默把已发布的版本顶掉**。
 *
 * ⚠️ `--allow-official` 是历史名字，一并接受（免得老习惯的命令突然失效）。
 */
const ALLOW_OFFICIAL =
  process.argv.includes('--allow-official') || process.argv.includes('--approved');

/**
 * ★★★ 是否为"测试版"（独立通道）。
 *
 * 需求（用户 2026-10）：
 *   「帮我新开一个测试版，用于测试，完成后再向正式版更新，
 *     上面的安装包我已经发出去，不要动那个」
 *
 * 用法：node tools/release.cjs "说明" --dist --test
 *   → 打包时设 `EXPO_PUBLIC_CHANNEL=test`
 *     → App 检查更新时带 `?ch=test`
 *   → 发布到 **lifekit-test.apk / version-test.json**（独立文件）
 *   → **绝不覆盖**正式通道的 lifekit-latest.apk
 *
 * ⚠️ 测试版也剥离万能码（--dist），因为它同样可能被发给别人。
 *
 * ⚠️ 用 `let` 而不是 `const` —— 下面有一段"未指定版本时默认走测试版"
 *    的逻辑要把它改成 true（用户指示：「其他默认改测试版」）。
 */
let TEST = process.argv.includes('--test');

/**
 * ★★★ 自用版（含便利万能码，独立包名）。
 *
 * 用户需求（原话）：
 *   「好，自用版可以用万能码，对外版和测试版不可用」
 *
 * ⚠️ 三者的区别只有两点：
 *   · 万能码：自用版**保留**，对外版/测试版**剥离**
 *   · 包名：com.lifekit.app / .test / .self（为了三个能同时装）
 *
 * ⚠️ 自用版现在也**上传云端**了（用户要求应用内更新），走自用通道。
 */
let SELF = process.argv.includes('--self');

/**
 * ⚠️ `--test` 和 `--self` 互斥 —— 它们要的是**不同的包名和不同的万能码策略**，
 *    同时给会产出一个语义混乱的包。直接拒掉。
 */
if (TEST && SELF) {
  console.error('');
  console.error('  XX  --test 和 --self 不能同时用');
  console.error('      测试版 = 剥离万能码 + 包名 .test + 走测试通道');
  console.error('      自用版 = 保留万能码 + 包名 .self + 只出包不发云端');
  console.error('      两者目标不同，请分开打。');
  console.error('');
  process.exit(2);
}

/**
 * ══════════════ ★★★ 默认走测试通道（用户指示，2026-10）══════════════
 *
 * 用户原话：
 *   「现在开始我说可以改正式版和自用版才可以改，其他默认改测试版」
 *
 * → 所以：**既没给 `--test` 也没给 `--self`、又没批准**时，
 *   不要报错拦下，而是**直接按测试版跑**。
 *
 * ⚠️ 这样"顺手跑一下发布脚本"永远不会碰到正式版/自用版 ——
 *    这正是用户要的默认行为。
 * ⚠️ 批准过（`--approved`）时**不做这个替换** —— 那说明确实要动正式版。
 */
if (!TEST && !SELF && !ALLOW_OFFICIAL) {
  TEST = true;
  console.log('');
  console.log('  ℹ️ 未指定版本 → **默认按测试版处理**');
  console.log('     （用户指示：「其他默认改测试版」）');
  console.log('     要动正式版/自用版请显式加 --approved');
}

/**
 * ══════════════ 正式 / 自用 的批准闸门 ══════════════
 *
 * 用户指示（原话，2026-10）：
 *   「现在开始我说可以改正式版和自用版才可以改，其他默认改测试版」
 *
 * 意思：
 *   · **默认**（不带参数）→ 上面已自动切到测试版
 *   · 正式版 / 自用版 → **必须用户明确说"可以"**，且调用时带 `--approved`
 *
 * ⚠️ 为什么要 `--approved` 这个显式参数：
 *    正式版**已经发给别人**，覆盖它会直接影响所有人（而且现在开着 force）；
 *    自用版含明文万能码，上传后服务器上可被下载。
 *    两者都不该在"顺手跑一下发布脚本"时被无意改掉。
 *
 * ⚠️ 一定要在**打包之前**拦 —— 否则会白打一个包，
 *    还可能顺手覆盖本地存档（lifekit-latest.apk / lifekit-self.apk）。
 */
const APPROVED = process.argv.includes('--approved');

/** 这次要动的是不是"需要批准"的通道 */
const NEEDS_APPROVAL = !TEST;

if (NEEDS_APPROVAL && !APPROVED) {
  const which = SELF ? '自用版' : '正式版';
  console.log('');
  console.log('  ' + '─'.repeat(58));
  console.log(`  ⛔ ${which}已冻结，本次操作已取消`);
  console.log('  ' + '─'.repeat(58));
  console.log('');
  console.log('  用户指示：「现在开始我说可以改正式版和自用版才可以改，');
  console.log('             其他默认改测试版」');
  console.log('');
  console.log('  ✅ 默认发测试版（什么都不用加）：');
  console.log('       node tools\\release.cjs "说明" --dist --test');
  console.log('');
  console.log(`  ⚠️ 确实要动${which}（用户已明确说"可以"）时，再加 --approved：`);
  console.log(
    SELF
      ? '       node tools\\release.cjs "说明" --dist --self --approved'
      : '       node tools\\release.cjs "说明" --dist --approved --force',
  );
  console.log('');
  process.exit(2);
}

function step(n, title) {
  console.log('');
  console.log('═'.repeat(62));
  console.log(`  ${n}. ${title}`);
  console.log('═'.repeat(62));
}

function runNode(script, extraArgs = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', script), ...extraArgs], {
    stdio: 'inherit',
    cwd: ROOT,
    /**
     * ★★★ 对外发布版：把环境变量传下去，让 Expo 在打包时内联进去。
     *
     * `EXPO_PUBLIC_DISTRIBUTION=1` 会让 `CONVENIENCE_MASTER_CODE` 变成空串
     *   → 包里**没有明文万能码**（反编译也搜不到）
     *   → 你自己改用服务器生成的 `LKM-` 签名万能码
     *
     * ⚠️ 必须走 `env` 传给子进程 —— 只在本进程设 process.env 不够，
     *    因为真正打包的是 build-apk.cjs 那个子进程。
     */
    env: { ...process.env, ...extraEnv },
  });
  return r.status ?? 1;
}

const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const version = appJson.expo?.version ?? '';
const versionCode = appJson.expo?.android?.versionCode ?? 0;

step(0, '当前版本');
console.log(`  ${version}（versionCode ${versionCode}）`);
if (!version) {
  console.error('  × app.json 里读不到版本号');
  process.exit(1);
}

step(1, '打包 APK');
/**
 * ★★★ 对外发布版（`--dist`）：
 *   把 `EXPO_PUBLIC_DISTRIBUTION=1` 传给打包脚本
 *   → `CONVENIENCE_MASTER_CODE` 变成空串
 *   → 包里**搜不到**内置万能码明文
 *
 * ⚠️ 用户要"往外投，每人一个授权码"，所以外发的包必须是剥离过的 ——
 *    否则任何人反编译就能拿到万能码，而它的权限是"能改任何人"。
 */
/**
 * ★★★ 万能码策略 —— 用户明确要求：
 *   「好，自用版可以用万能码，对外版和测试版不可用」
 *
 *   → 只有**自用版**保留内置万能码
 *   → 对外版、测试版一律剥离
 *
 * ⚠️ 所以不能再看 `--dist` 这个开关来决定剥不剥离，
 *    而要看**这次打的是哪个版本**（自用版例外）。
 */
const STRIP_MASTER = !SELF;

if (SELF) {
  console.log('  ✅ 自用版：**保留**内置便利万能码（EXPO_PUBLIC_MASTER_CODE 可用）');
  console.log('     包名 com.lifekit.app.self（与正式版/测试版都不冲突）');
  console.log('     走**自用通道**（lifekit-self.apk）→ 支持应用内更新');
} else if (DIST) {
  console.log('  ⚠️ 对外发布版：剥离内置便利万能码（包里不会有明文）');
}
if (TEST) {
  console.log('  ⚠️ 测试版：走**测试通道**（lifekit-test.apk），不会动正式版');
}
if (SELF) {
  console.log('  ⚠️ 自用版的 APK 会**上传到云端**（为了应用内更新）——');
  console.log('     它含有明文万能码，服务器上可被下载。别外传这个地址。');
}

/**
 * 本次打包要传下去的环境变量。
 *
 * ⚠️ 无论哪个版本都要设 `EXPO_PUBLIC_CHANNEL` —— 它决定**包名和显示名**
 *    （见 app.config.js）。不设就是对外版配置。
 */
const buildEnv = {
  ...(STRIP_MASTER ? { EXPO_PUBLIC_DISTRIBUTION: '1' } : {}),
  ...(TEST ? { EXPO_PUBLIC_CHANNEL: 'test' } : {}),
  ...(SELF ? { EXPO_PUBLIC_CHANNEL: 'self' } : {}),
  /**
   * ⚠️ 换包名/换剥离开关时**必须强制重打 bundle** ——
   *    否则 Gradle 会因"输入没变"跳过重新打 bundle，
   *    环境变量根本没机会内联，打出来的包和上一个**字节完全相同**
   *    （踩过：自用版和对外版 sha256 一样）。
   */
  LIFEKIT_FORCE_REBUNDLE: '1',
};

if (runNode('android/build-apk.cjs', [], buildEnv) !== 0) {
  console.error('  × 打包失败');
  process.exit(1);
}
const built = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
/**
 * ⚠️ 文件名要区分版本 —— 否则会覆盖别的版本的本地存档。
 */
const target = path.join(
  ROOT,
  SELF
    ? `LifeKit-v${version}-SELF2-arm64.apk`
    : TEST
      ? `LifeKit-v${version}-TEST-arm64.apk`
      : `LifeKit-v${version}-arm64.apk`,
);
fs.copyFileSync(built, target);
console.log(`  √ ${path.basename(target)}（${(fs.statSync(target).size / 1048576).toFixed(1)} MB）`);

/**
 * ══════════════ ★★★ 自用版也走云端（用户要求，2026-10）══════════════
 *
 * 用户原话：「直接把自用的上传云端啊，我在应用内更新」
 *
 * → 所以自用版**不再提前退出**，它会和测试版一样继续走
 *   "发布到 server/apk/ → 部署到云端" 这两步，
 *   只是落到**自用通道**（lifekit-self.apk / version-self.json）。
 *
 * ⚠️ 三条通道文件独立，所以自用版不会碰正式版。
 * ⚠️ 但自用版**含明文万能码**，上传后服务器上可被下载 ——
 *    靠"文件名不公开"降低暴露面，不等于安全。
 */

step(
  2,
  SELF
    ? '发布到 server/apk/（自用通道）'
    : TEST
      ? '发布到 server/apk/（测试通道）'
      : '发布到 server/apk/（正式通道）',
);
/**
 * ⚠️ 必须把 `--allow-official` **继续传给 publish-apk.cjs**。
 *
 *    publish-apk 自己也有一道冻结闸（防的是"本地存档被覆盖"）。
 *    第一版我忘了传 → release 这层放行了，publish 那层又拦下来：
 *      "⛔ 拒绝覆盖正式通道的本地存档" → 整个发布失败。
 */
if (
  runNode('publish-apk.cjs', [
    target,
    NOTE,
    ...(TEST ? ['--test'] : []),
    /** ★ 自用通道（用户要求自用版也能应用内更新） */
    ...(SELF ? ['--self'] : []),
    ...(!TEST && !SELF && ALLOW_OFFICIAL ? ['--allow-official'] : []),
    /**
     * ★ 强制更新（用户 2026-10：「这次更新要设置为强制更新，
     *   有人要用我的诊断工具」）。
     *   加了 `--force` 才会写进 version.json，App 那边弹窗就关不掉。
     */
    ...(process.argv.includes('--force') ? ['--force'] : []),
  ]) !== 0
) {
  console.error('  × 发布失败');
  process.exit(1);
}

step(3, '部署到云端（服务端代码 + APK + 重启）');
/**
 * ══════════════ ★ 这里换成了 deploy-all.cjs ══════════════
 *
 * 原先调的是 `deploy-to-vps.cjs`，它**只传 APK 和 version.json**。
 * 而"App 内置更新"依赖 `/api/version` 这个**接口** ——
 * 那个接口在新版 `server.cjs` 里。于是出现：
 *   · 本地服务器能更新（新代码在跑）
 *   · **云端 404**（还是旧代码）
 *   · 出门用流量就更新不了
 *
 * `deploy-all.cjs` 会把服务端代码一起传上去、语法检查、备份、
 * 替换、重启、验证，并且有白名单守卫**绝不碰 data.json**。
 */
const deploy = runNode('deploy-all.cjs', TEST ? ['--test'] : SELF ? ['--self'] : []);
if (deploy !== 0) {
  console.log('');
  console.log('  ⚠️ 云端部署没成功（上面有原因）。');
  console.log('     包已经打好并放在 server/apk/，可以单独补传：');
  console.log('       node tools/deploy-all.cjs --check   # 先看现状');
  console.log('       node tools/deploy-all.cjs           # 再部署');
  process.exit(deploy);
}

step(4, '完成');
console.log(`  ✅ ${version} 已上线：`);
console.log('     · 云端已更新，用户**用流量**打开 App 就能看到更新提示');
console.log('     · 桌面的 LifeKit管理后台\\apk\\ 也已同步（供手动上传用）');
