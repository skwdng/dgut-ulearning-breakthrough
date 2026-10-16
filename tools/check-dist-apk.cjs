/**
 * 对照检查：确认**便利万能码真的被剥离了**。
 *
 * ══════════════ ⚠️ 2026-10：自用版已删除，本脚本的"对照"前提没了 ══════════════
 *
 * 用户要求「把自用版删除吧」—— 自用版是**唯一保留内置万能码**的通道，
 * 所以原来那个"自用版 vs 对外版"的对照不再成立：
 * **现在没有任何版本会带明文万能码**（见 tools/release.cjs 的 STRIP_MASTER）。
 *
 * → 所以本脚本改成：
 *   · 两个 APK 都在 → 照旧做对照（保留能力，以后万一要实证）
 *   · **任一个不存在 → 优雅跳过**（打印说明、退出 0），而不是 ENOENT 崩溃
 *
 * ⚠️ 为什么不能直接删掉这个脚本：
 *    "万能码有没有被剥离"是**安全关键**的检查（那种码能改任何人的签到）。
 *    现在剥离逻辑由 `verify-master-strip-scope.cjs` 做源码级静态检查覆盖；
 *    这个脚本保留着做**产物级实证**的能力 —— 需要时
 *    `EXPO_PUBLIC_MASTER_CODE=你的码 node tools/check-dist-apk.cjs <apk> <参考apk>`
 *    跑一次就能确认包里到底有没有。
 *
 * ══════════════ 🚨 为什么必须验证（不能"我以为剥离了"）══════════════
 *
 * 便利万能码（内置码，由 `EXPO_PUBLIC_MASTER_CODE` 决定）权限是 `scope: 'all'`
 * —— **能改任何人**的签到状态。
 * 用户要「往外投，每人一个授权码」，所以外发的包里**绝不能有它**。
 *
 * ══════════════ ⚠️ 前两版检查都错了（留档，别再踩）══════════════
 *
 * 第 1 版：`bundle.includes('<那个码>')`
 *   → 对外版**误报"没剥离"**。
 *   → 因为 RN 的 bundle 里有一大片**原生模块字符串表**，
 *     碰巧出现 `…T47686450%<那个码>Height…`（两个不相干字符串相邻）。
 *
 * 第 2 版：搜 `CONVENIENCE_MASTER_CODE` 的赋值
 *   → 找不到（0 处）。
 *   → 因为 release 包是 **Hermes 字节码**，不是可读 JS ——
 *     变量名会被 mangle/消除，源码里的标识符在包里**根本不存在**。
 *
 * 第 3 版（本文件）：**对照法**。
 *   · 参考包（不剥离）→ 那个码应该出现**很多次**（常量 + 相关逻辑）
 *   · 目标包（剥离）  → 只剩原生字符串表里那 **1 次**巧合
 *
 *   → 判据：`目标包出现次数` 必须 **明显少于** `参考包`，
 *     且目标包 ≤ 2（允许那 1~2 次巧合）。
 *
 * ⚠️ 公开仓库版（2026-10）：要搜的码改成从 `EXPO_PUBLIC_MASTER_CODE` 取，
 *    没设就跳过这项对比（不是失败）—— 详见下面 NEEDLE 那段注释。
 *
 * 用法: node tools/check-dist-apk.cjs [目标APK] [参考APK]
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIST = path.join(ROOT, 'LifeKit-v1.0.0-DIST-arm64.apk');
/**
 * ⚠️ 参考包原来是"自用版"（唯一保留万能码的版本）。
 *    自用版已删除（2026-10），所以这个默认路径**大概率不存在** ——
 *    下面会检测并优雅跳过，而不是抛 ENOENT。
 */
const DEFAULT_SELF = path.join(ROOT, 'LifeKit-v1.0.0-SELF-arm64.apk');

const DIST_APK = process.argv[2] || DEFAULT_DIST;
const REF_APK = process.argv[3] || DEFAULT_SELF;

/** 用 PowerShell 的 Expand-Archive 解出 bundle（不依赖 unzip / .NET 静态调用） */
function extractBundle(apk) {
  const tmp = path.join(os.tmpdir(), `lk-apkcheck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, 'a.zip');
  fs.copyFileSync(apk, zip);
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${path.join(tmp, 'x')}' -Force`,
    ],
    { stdio: 'ignore' },
  );
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.bundle')) found.push(p);
    }
  };
  walk(path.join(tmp, 'x'));
  return { bundle: found[0], cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/** 数一个串在文件里出现几次 */
function countIn(file, needle) {
  const txt = fs.readFileSync(file, 'latin1'); // 字节码里有二进制，用 latin1 保证不丢字符
  let n = 0;
  let i = -1;
  while ((i = txt.indexOf(needle, i + 1)) >= 0) n += 1;
  return n;
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
console.log('  对照检查：目标包 vs 参考包（万能码剥离实证）');
console.log('');

/**
 * ⚠️ 任一 APK 不存在 → **跳过而不是崩溃**。
 *
 *    原来这里直接 `extractBundle()` → `fs.copyFileSync` 找不到文件就抛
 *    ENOENT 退出码 1。自用版删除后参考包**必然不存在**，
 *    于是这个脚本每次都"失败" —— 而**一直失败的检查等于没有检查**，
 *    真出问题那天没人会去看这堆已知噪音。
 *
 *    所以：文件不在就打印怎么补，然后退出 0（跳过 ≠ 通过，但也不该算失败）。
 */
const missing = [
  ['目标包', DIST_APK],
  ['参考包', REF_APK],
].filter(([, p]) => !fs.existsSync(p));

if (missing.length) {
  for (const [label, p] of missing) {
    console.log(`  · ${label}不存在：${path.basename(p)}`);
  }
  console.log('');
  console.log('  ⏭️  跳过对照检查（不影响其它校验）');
  console.log('');
  console.log('  说明：');
  console.log('    · 自用版已删除（2026-10），**现在没有任何版本带明文万能码**');
  console.log('    · 剥离逻辑由 tools/verify-master-strip-scope.cjs 做源码级检查');
  console.log('    · 要**产物级实证**时，自己指定两个 APK：');
  console.log('        EXPO_PUBLIC_MASTER_CODE=你的码 node tools/check-dist-apk.cjs <目标.apk> <参考.apk>');
  console.log('');
  process.exit(0);
}

const dist = extractBundle(DIST_APK);
const self = extractBundle(REF_APK);

try {
  if (!dist.bundle || !self.bundle) {
    console.error('  × 有 APK 里找不到 .bundle');
    process.exit(1);
  }

  /**
   * ★ 要搜的码从环境变量取 —— 公开仓库里没有真实内置码。
   *
   * ⚠️ 没设就**跳过**这项对比（不是失败）：剥离逻辑本身由
   *    `verify-master-strip-scope.cjs` 用源码静态检查覆盖，
   *    这里只是对**具体产物**做一次实证。
   *    要实证：EXPO_PUBLIC_MASTER_CODE=你的码 node tools/check-dist-apk.cjs
   */
  const NEEDLE = process.env.EXPO_PUBLIC_MASTER_CODE || '';
  if (!NEEDLE) {
    console.log('  （跳过万能码出现次数对比：没设 EXPO_PUBLIC_MASTER_CODE）');
  } else {
  const nDist = countIn(dist.bundle, NEEDLE);
  const nSelf = countIn(self.bundle, NEEDLE);

  console.log(`  自用版 ${path.basename(SELF_APK)}：出现 ${nSelf} 次`);
  console.log(`  对外版 ${path.basename(DIST_APK)}：出现 ${nDist} 次`);
  console.log('');

  t('★ 自用版里万能码出现多次（说明常量确实在包里）', nSelf >= 3, `实际 ${nSelf} 次`);
  t(
    '★★★ 对外版出现次数**明显少于**自用版（剥离生效）',
    nDist < nSelf,
    `对外 ${nDist} vs 自用 ${nSelf}`,
  );
  /**
   * ⚠️ 允许 ≤2 次：RN 原生字符串表里那处巧合（实测存在）。
   *    如果 >2，说明剥离没干净。
   */
  t(
    '★★★ 对外版 ≤2 次（只剩原生字符串表的巧合）',
    nDist <= 2,
    `实际 ${nDist} 次 —— 超过 2 次说明没剥离干净`,
  );
  /** ★ 差异要够大，否则说明"剥离"只是巧合变小 */
  t(
    '★★ 剥离幅度够大（自用版至少是对外版的 3 倍）',
    nSelf >= nDist * 3,
    `自用 ${nSelf} / 对外 ${nDist}`,
  );
  }

  console.log('');
  console.log('=== 其它敏感串 ===');
  /**
   * ⚠️ 公开仓库版（2026-10）：这里原先**写死了真实管理口令和真实服务器 IP** 去搜包。
   *    公开仓库不能出现这些字面量，所以改成：
   *      · 管理口令：从环境变量取（设了才检查）
   *      · 服务器地址：检查"包里有没有硬编码一个 http(s)://<IP>:<端口>"这种模式，
   *        而不是检查某一个具体 IP
   */
  const ADMIN_PW = process.env.LIFEKIT_ADMIN_PASSWORD || '';
  if (ADMIN_PW) {
    const has = countIn(dist.bundle, ADMIN_PW) > 0;
    t(`管理口令：${has ? '出现' : '没有'}`, !has, has ? '⚠️ 泄漏' : '');
  } else {
    console.log('  （跳过管理口令检查：没设 LIFEKIT_ADMIN_PASSWORD）');
  }
  t(
    '万能码签名密钥（解析 LKM- 码必需）：出现',
    countIn(dist.bundle, 'LifeKit::master::v1::2026') > 0,
  );
  /**
   * 服务器地址：默认值已经改成从 `EXPO_PUBLIC_SERVER_BASE` 注入，
   * 所以这里检查的是"有没有把某个具体 IP 硬编码进包"。
   * 自建者自己填地址是允许的，所以只报告、不算失败。
   */
  const hardIp = /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/.exec(
    dist.bundle.toString('latin1'),
  );
  console.log(
    `  ${hardIp ? 'ℹ️' : '√'} 包内硬编码 IP 地址：${hardIp ? hardIp[0] : '没有'}`,
  );
} finally {
  dist.cleanup();
  self.cleanup();
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
