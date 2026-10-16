/**
 * 发布安装包（给"应用内更新"用）。
 *
 * ══════════════ 它做什么 ══════════════
 *   ① 把打好的 APK 复制到 `server/apk/lifekit-latest.apk`
 *   ② 写一个 `server/apk/version.json` 描述版本号
 *      （服务端的 /api/version 会读它）
 *   ③ 打印要在服务器上执行的更新命令
 *
 * ══════════════ 为什么还要手写 version.json ══════════════
 * Node 没有内置解析 APK 的能力，为了拿版本号引一个库不值当。
 * 而这个信息在 `app.json` 里本来就有，发布时顺手写过去最省事。
 *
 * ⚠️ 顺序很重要：**必须先更新服务器的服务端代码，再发布 APK**。
 *    否则老服务器没有 /api/version，App 检查更新永远"没反应"。
 *
 * 用法:
 *   node tools/publish-apk.cjs                    # 用最新的 arm64 包
 *   node tools/publish-apk.cjs <apk路径> [说明]    # 指定包与更新说明
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_APK_DIR = path.join(ROOT, 'server', 'apk');

/**
 * ══════════════ ★★★ 版本通道（正式 / 测试）══════════════
 *
 * 需求（用户 2026-10）：
 *   「帮我新开一个测试版，用于测试，完成后再向正式版更新，
 *     上面的安装包我已经发出去，不要动那个」
 *
 * ⚠️ 所以两条通道**文件名必须不同** —— 测试包绝不能覆盖正式包
 *    （正式包已经发给别人了，覆盖会让他们的应用内更新拿到测试版）。
 *
 *   正式：lifekit-latest.apk  + version.json
 *   测试：lifekit-test.apk    + version-test.json
 *
 * 用法：node tools/publish-apk.cjs <apk> "说明" [--test]
 */
const IS_TEST = process.argv.includes('--test');
/**
 * ══════════════ ★★★ 2026-10：自用通道已删除 ══════════════
 *
 * 用户要求「把自用版删除吧」（三个版太麻烦，只留正式版和测试版）。
 *
 * 原来这里有个 `--self` 开关，对应 `lifekit-self.apk` + `version-self.json`。
 * 现在**只剩两条通道**：
 *   · 正式通道 → lifekit-latest.apk + version.json
 *   · 测试通道 → lifekit-test.apk   + version-test.json
 *
 * ⚠️ 传 `--self` 会怎样：**被当成正式通道** —— 于是会撞上下面那道冻结闸
 *    （没有 `--allow-official` 就直接拒绝）。这是**故意**的安全默认：
 *    与其静默产出一个"自用通道"的存档，不如让命令明确失败。
 *
 * ⚠️ 顺带的好处：以前自用版的 APK 含明文万能码且上传到云端（可被下载），
 *    现在**云端不再有任何含万能码的安装包**。
 */
/**
 * ══════════════ ★★★ 强制更新（--force）══════════════
 *
 * 用户需求（原话）：
 *   「这次更新要设置为强制更新，有人要用我的诊断工具」
 *
 * 加了它 → `version.json` 里写 `force: true`
 *        → `/api/version` 回 `force: true`
 *        → App 的更新弹窗**关不掉**，必须更新才能继续用。
 *
 * ⚠️ 默认不开 —— 免得"忘了设"变成"把所有人锁死"。
 * ⚠️ 只对**已发出去、需要收回**的版本用（比如包里带了不该有的排查工具）。
 */
const FORCE = process.argv.includes('--force');
/**
 * ══════════════ 正式通道冻结（用户指示，2026-10）══════════════
 *
 * 用户原话：「这个正式版就是我现在发布的版本，不要动那个了，
 *           以后我要改所有都改到测试板上，我说可以再改到正式版上」
 *
 * ⚠️ 这里防的是"**本地存档被覆盖**"：
 *    `server/apk/lifekit-latest.apk` 是**已发布那版的本地副本**，
 *    它跟云端那份哈希一致。一旦被新版覆盖，就再也对不出"已发布的到底是哪个包"。
 *
 *    所以非测试通道发布时，必须显式给 `--allow-official`，
 *    否则**拒绝写入**（连同 version.json 一起不写）。
 */
const ALLOW_OFFICIAL = process.argv.includes('--allow-official');
/**
 * ⚠️ 冻结闸只管**正式通道**：测试通道有自己的文件，不会碰正式存档。
 */
if (!IS_TEST && !ALLOW_OFFICIAL) {
  console.error('');
  console.error('  ⛔ 拒绝覆盖正式通道的本地存档（lifekit-latest.apk / version.json）');
  console.error('     那是**已发布版本**的副本，覆盖后就无法核对"发出去的到底是哪个包"。');
  console.error('');
  console.error('     ✅ 发测试通道：node tools/publish-apk.cjs <apk> "说明" --test');
  console.error('     ⚠️ 经用户批准升正式版：再加 --allow-official');
  console.error('');
  process.exit(2);
}

/**
 * ★ 两条通道 → 两组文件名（互不覆盖）。
 * ⚠️ 2026-10：自用通道（lifekit-self.apk / version-self.json）已删除。
 */
const CHANNEL_FILES = IS_TEST
  ? { apk: 'lifekit-test.apk', meta: 'version-test.json' }
  : { apk: 'lifekit-latest.apk', meta: 'version.json' };

const LATEST = path.join(SERVER_APK_DIR, CHANNEL_FILES.apk);
const META = path.join(SERVER_APK_DIR, CHANNEL_FILES.meta);

const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const version = String(appJson.expo?.version ?? '');
const versionCode = Number(appJson.expo?.android?.versionCode ?? 0);

if (!version || !versionCode) {
  console.error('  × app.json 里读不到 version / versionCode');
  process.exit(1);
}

/** 找要发布的 APK：优先命令行给，否则找 workspace 里最新的 LifeKit-*.apk */
function pickApk() {
  const arg = process.argv[2];
  if (arg) {
    const p = path.resolve(arg);
    if (!fs.existsSync(p)) {
      console.error(`  × 找不到 APK：${p}`);
      process.exit(1);
    }
    return p;
  }
  const candidates = fs
    .readdirSync(ROOT)
    .filter((f) => /^LifeKit-.*\.apk$/.test(f))
    .map((f) => ({ f, p: path.join(ROOT, f), m: fs.statSync(path.join(ROOT, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!candidates.length) {
    console.error('  × workspace 里没有 LifeKit-*.apk，先把包打出来或显式传路径');
    process.exit(1);
  }
  return candidates[0].p;
}

const apk = pickApk();
const note = process.argv[3] ?? '';

fs.mkdirSync(SERVER_APK_DIR, { recursive: true });
fs.copyFileSync(apk, LATEST);

const stat = fs.statSync(LATEST);
fs.writeFileSync(
  META,
  `${JSON.stringify(
    {
      version,
      versionCode,
      note,
      /**
       * ★ 强制更新标记（见文件顶部 FORCE 的说明）。
       * ⚠️ 一律显式写出（false 也写），这样运维时一眼能看出当前是不是强制的 ——
       *    省略字段会让人分不清"没开"和"忘了配"。
       */
      force: FORCE,
      sizeBytes: stat.size,
      publishedAt: new Date().toISOString(),
      source: path.basename(apk),
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const mb = (stat.size / 1048576).toFixed(1);

console.log('');
console.log('  √ 已发布到 server/apk/');
console.log(`     源文件：  ${path.basename(apk)}`);
console.log(`     版本：    ${version}（versionCode ${versionCode}）`);
console.log(`     体积：    ${mb} MB`);
console.log(`     说明：    ${note || '（无）'}`);
console.log('');
console.log('  ─────────────────────────────────────────────');
console.log('  ★ 接下来要把这两样送到服务器上（顺序别反）：');
console.log('  ─────────────────────────────────────────────');
console.log('');
console.log('    ① 先更新服务端代码（含 /api/version 接口）：');
console.log('       用 桌面\\LifeKit管理后台\\update-vps.sh');
console.log('       （它会把最新的 server.cjs 写上去并重启服务）');
console.log('');
console.log('    ② 再上传安装包（约 ' + mb + ' MB）：');
console.log('       把 server/apk/ 里的两个文件');
console.log('       传到服务器的 /opt/lifekit/apk/ 目录：');
console.log('         · lifekit-latest.apk');
console.log('         · version.json');
console.log('');
console.log('       服务器上先建目录：');
console.log('         sudo mkdir -p /opt/lifekit/apk');
console.log('');
console.log('    ③ 验证（应返回 available:true 与版本号）：');
console.log('         curl -s http://127.0.0.1:8787/api/version');
console.log('');
console.log('  ⚠️ 上传 30+ MB 的文件，Workbench 的粘贴方式不合适；');
console.log('     建议用云服务商控制台的「文件上传」功能，或用 scp。');
console.log('');
