// 功能模块（插件）框架的回归测试。
//
// 重点验证三条设计规则：
//   1. 按平台能力自动过滤（iOS 上外卖模块应隐藏）
//   2. 用户选择优先于平台能力（用户主动开的即使不支持也要显示）
//   3. 模块自己声明所需权限（缺权限要能被算出来）
//
// 用法: node tools/verify-modules.cjs

// ===== 与被测逻辑保持一致（改动 src/domain/modules.ts 后请同步） =====
//
// ══════════════ ★★ 这个"内联复刻"曾经悄悄过期过 ══════════════
// 2026-10 把「签到」模块改成「小操作」、又把它降级成优学院下的二级页时，
// 这份复刻里还留着旧的 `checkin` 模块 —— 于是**测试在测一个不存在的东西**，
// 而且全部 PASS，看不出问题。
//
// 所以文件末尾加了一道**守卫**（第 7 节）：直接读 src/domain/modules.ts，
// 把里面的 `key:` 逐个抠出来和这份复刻比对。不一致就 FAIL。
// 这样"忘了同步"会立刻暴露，而不是假通过。
const MODULES = [
  {
    key: 'youxue',
    label: '优学院',
    platforms: ['android', 'ios'],
    permissions: [],
    defaultEnabled: false,
    // ⚠️ 故意**没有** requiresLicense ——
    //    门槛只落在「小操作」这个二级页上（见 src/screens/xiaocao.tsx），
    //    挂到模块上会把「任务查询」也拦住。
  },
  { key: 'delivery', label: '外卖', platforms: ['android'], permissions: ['notificationAccess'], defaultEnabled: true, fallbackHint: 'iOS 不允许读通知' },
  { key: 'course', label: '课程', platforms: ['android', 'ios'], permissions: [], defaultEnabled: true },
  { key: 'schedule', label: '日程', platforms: ['android', 'ios'], permissions: [], defaultEnabled: true },
  { key: 'todo', label: '待办', platforms: ['android', 'ios'], permissions: [], defaultEnabled: true },
  { key: 'stats', label: '统计', platforms: ['android', 'ios'], permissions: [], defaultEnabled: true },
  { key: 'qr-tool', label: '二维码', platforms: ['android', 'ios'], permissions: ['camera'], defaultEnabled: false },
  { key: 'exam', label: '考试', platforms: ['android', 'ios'], permissions: ['notification'], defaultEnabled: false },
];

function isPlatformSupported(def, platform) {
  return def.platforms.includes(platform);
}
function missingPerms(def, granted) {
  return def.permissions.filter((p) => !granted[p]);
}
function computeModuleRuntime(def, cfg, granted = {}, platform = 'android') {
  const platformSupported = isPlatformSupported(def, platform);
  const explicitlyEnabled = cfg.enabled.includes(def.key);
  const explicitlyDisabled = cfg.disabled.includes(def.key);
  const userEnabled = explicitlyEnabled ? true : explicitlyDisabled ? false : def.defaultEnabled;
  const missing = missingPerms(def, granted);
  return {
    def,
    platformSupported,
    userEnabled,
    missing,
    visible: userEnabled && (platformSupported || explicitlyEnabled),
    usable: userEnabled && platformSupported,
  };
}
function computeAllModules(cfg, granted = {}, platform = 'android') {
  return MODULES.map((d) => computeModuleRuntime(d, cfg, granted, platform));
}

// ===== 测试 =====
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

const EMPTY = { enabled: [], disabled: [] };
const byKey = (list) => Object.fromEntries(list.map((r) => [r.def.key, r]));

// ---- 1) Android 默认状态 ----
{
  const all = computeAllModules(EMPTY, {}, 'android');
  const m = byKey(all);
  check('Android: 外卖模块可见', m.delivery.visible === true);
  check('Android: 外卖平台受支持', m.delivery.platformSupported === true);
  check('Android: 优学院模块默认关闭 → 不可见', m.youxue.visible === false);
  check('Android: 默认关闭的二维码工具不可见', m['qr-tool'].visible === false);
  check('Android: 默认关闭的考试模块不可见', m.exam.visible === false);
  check('Android: 可见模块数 = 5', all.filter((r) => r.visible).length === 5, `实际 ${all.filter((r) => r.visible).length}`);
}

// ---- 2) iOS 平台过滤（规则 1） ----
{
  const all = computeAllModules(EMPTY, {}, 'ios');
  const m = byKey(all);
  check('iOS: 外卖模块被自动隐藏', m.delivery.visible === false);
  check('iOS: 外卖平台标记为不支持', m.delivery.platformSupported === false);
  check('iOS: 外卖即使被用户开启也不可用', byKey(computeAllModules({ enabled: ['delivery'], disabled: [] }, {}, 'ios')).delivery.usable === false);
}

// ---- 3) 用户选择优先于平台能力（规则 2） ----
{
  const cfg = { enabled: ['delivery'], disabled: [] };
  const all = computeAllModules(cfg, {}, 'ios');
  const m = byKey(all);
  check('iOS + 用户主动开启外卖 → 仍显示（便于解释原因）', m.delivery.visible === true);
  check('iOS + 用户主动开启外卖 → 仍标记为不可用', m.delivery.usable === false);
  check('iOS + 用户主动开启外卖 → 给出原因', typeof m.delivery.def.fallbackHint === 'string');

  /** ⚠️ 优学院默认关闭，用"用户主动开启"来验可见性 */
  const cfg2 = { enabled: ['youxue'], disabled: [] };
  const m2 = byKey(computeAllModules(cfg2, {}, 'android'));
  check('Android + 用户开启优学院 → 显示', m2.youxue.visible === true);
  check('Android + 用户开启优学院 → 可用', m2.youxue.usable === true);

  const cfg3 = { enabled: [], disabled: ['youxue'] };
  const m3 = byKey(computeAllModules(cfg3, {}, 'android'));
  check('Android + 用户关闭优学院 → 不显示', m3.youxue.visible === false);
  check('Android + 用户关闭优学院 → 用户选择被尊重（userEnabled=false）', m3.youxue.userEnabled === false);
}

// ---- 4) 权限声明（规则 3） ----
{
  const all = computeAllModules(EMPTY, {}, 'android');
  const m = byKey(all);
  check('外卖模块缺通知使用权', m.delivery.missing.includes('notificationAccess'));
  check('课程模块不缺权限', m.course.missing.length === 0);
  check('二维码工具缺相机权限', m['qr-tool'].missing.includes('camera'));
  /**
   * ★★ 优学院模块**不该声明任何权限**（尤其不该要 notification/location）——
   *    那是签到功能需要的，而签到已经不在这个模块下了
   *    （授权门槛与权限都跟着「小操作」二级页走）。
   */
  check('★★ 优学院模块不声明权限（签到权限已随功能搬走）', m.youxue.missing.length === 0, JSON.stringify(m.youxue.missing));

  // 授予后应清零
  const granted = { notification: true, location: true, notificationAccess: true, camera: false };
  const m2 = byKey(computeAllModules(EMPTY, granted, 'android'));
  check('授予后外卖模块无缺失权限', m2.delivery.missing.length === 0);
}

// ---- 5) 启用/停用/恢复默认的优先级 ----
{
  // 用户开启一个默认关闭的模块
  const cfg = { enabled: ['qr-tool'], disabled: [] };
  const m = byKey(computeAllModules(cfg, {}, 'android'));
  check('用户开启默认关闭的二维码工具 → 可见', m['qr-tool'].visible === true);

  // 用户关闭一个默认开启的模块
  const cfg2 = { enabled: [], disabled: ['todo'] };
  const m2 = byKey(computeAllModules(cfg2, {}, 'android'));
  check('用户关闭默认开启的待办 → 不可见', m2.todo.visible === false);

  // 恢复默认（两个列表都不含）→ 回到 defaultEnabled
  const m3 = byKey(computeAllModules(EMPTY, {}, 'android'));
  check('恢复默认后待办回到可见', m3.todo.visible === true);
}

// ---- 6) 未知模块 key 不炸 ----
{
  let threw = false;
  try {
    computeAllModules({ enabled: ['not-exist'], disabled: ['also-not-exist'] }, {}, 'android');
  } catch {
    threw = true;
  }
  check('配置里有未知 key 时不抛异常', threw === false);
}

/**
 * ══════════════ ★★ 7) 守卫：这份复刻必须与真实现一致 ══════════════
 *
 * 为什么要它：上面那份 MODULES 是**内联复刻**的，改了 src 忘了同步
 * 就会"测一个不存在的东西"而且全 PASS —— 真发生过
 * （把「签到」模块改成「小操作」又降级成二级页时，这里还留着旧的 checkin）。
 *
 * 所以直接读真源码，把模块 key 抠出来逐个比对。
 */
{
  const fs = require('node:fs');
  const path = require('node:path');
  const SRC = path.resolve(__dirname, '..', 'src', 'domain', 'modules.ts');
  let realKeys = [];
  try {
    const text = fs.readFileSync(SRC, 'utf8');
    // 只取 MODULES 数组里的 key（MODULES 之前的 ModuleKey 类型也有 key 字样，但形如 | 'x'）
    const start = text.indexOf('export const MODULES');
    const seg = start >= 0 ? text.slice(start) : text;
    realKeys = [...seg.matchAll(/\bkey:\s*'([^']+)'/g)].map((m) => m[1]);
  } catch (e) {
    check('能读到 src/domain/modules.ts', false, e.message);
  }

  const mirrorKeys = MODULES.map((d) => d.key);
  console.log('');
  console.log(`  真实现模块 key：${realKeys.join(', ')}`);
  console.log(`  复刻模块 key：  ${mirrorKeys.join(', ')}`);

  check('★★ 复刻的模块 key 与真实现完全一致', JSON.stringify(realKeys) === JSON.stringify(mirrorKeys),
    `真 ${realKeys.length} 个 / 复刻 ${mirrorKeys.length} 个`);
  check('★★ 真实现里没有已删除的 checkin 模块', !realKeys.includes('checkin'));
  /**
   * ★★ 优学院模块**不该**带 requiresLicense ——
   *    它是整模块生效的，挂上去会连「任务查询」一起拦住。
   *    门槛只该落在「小操作」二级页上。
   */
  {
    const text = fs.readFileSync(SRC, 'utf8');
    const start = text.indexOf("key: 'youxue'");
    const seg = start >= 0 ? text.slice(start, start + 1200) : '';
    check('★★ 优学院模块没有 requiresLicense（否则任务查询也被拦）', !/requiresLicense:\s*true/.test(seg));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
