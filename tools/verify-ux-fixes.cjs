/**
 * 三项体验问题的修复 测试。
 *
 * ══════════════ 用户提的三个问题 ══════════════
 *
 * ① 「不能全部复制，太多了」
 *    → 探测结果几十条、每条带正文，手机上根本选不全。
 *
 * ② 「每次更新完再进去都会闪退，要隔一阵子才能进入」
 *    → 注意措辞：**不是真崩，是卡住要等**。
 *      但卡在哪一步？启动时有 7 层 Provider 依次 hydrate + 若干网络请求，
 *      光看代码猜不出来 → 加启动计时，超阈值写进日志。
 *
 * ③ 「每次登录要等的时间都太久了」
 *    → 根因：登录时 `await fetchCourses()`，而它会**遍历全部课程**
 *      （每门课取课堂 → 每个课堂取活动 → 部分还要取详情），
 *      约 25 门课、几十次网络往返，而且**账号要等它完成才落地**。
 *
 * 用法: node tools/verify-ux-fixes.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROBE = fs.readFileSync(path.join(ROOT, 'src', 'services', 'checkin', 'probeActivityApi.ts'), 'utf8');
const SCREEN = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'SignRecordList.tsx'), 'utf8');
const STORE = fs.readFileSync(path.join(ROOT, 'src', 'state', 'checkinStore.tsx'), 'utf8');
const TIMING = fs.readFileSync(path.join(ROOT, 'src', 'services', 'startupTiming.ts'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');

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

console.log('=== ① 探测结果：精简 / 详细 两种复制 ===');
{
  t('★★★ formatProbeReport 支持 compact 参数（默认精简）', /export function formatProbeReport\(results: ProbeResult\[\], compact = true\)/.test(PROBE));
  t('★★ 精简模式折叠 404 条目', /if \(compact && !interesting\)/.test(PROBE));
  t('★★★ 反面对照**永远保留**（它是判断规则的对照物）', /const isControl = r\.group\.includes\('反面对照'\)/.test(PROBE));
  t('★★ 被折叠的条目会汇总成一行（不是无痕丢弃）', /另有 \$\{skipped\.length\} 条 404 已省略/.test(PROBE));
  t('★★ 精简模式不附完整正文（那正是"太长"的来源）', /if \(!compact && r\.full/.test(PROBE));
  t('★ 精简模式末尾提示怎么拿详细版', /用「复制全部（详细）」/.test(PROBE));
  /** ⚠️ 反面对照必须"哪怕它不存在也留" —— BOM bug 就是靠它发现的 */
  t('★★ 注释说明了为什么反面对照要留', /BOM bug 就是靠它发现的/.test(PROBE));

  /** 界面：两个复制按钮 */
  /**
   * ══════════════ ⚠️ 这一组原本断言"界面上有探测结果与复制按钮" ══════════════
   *
   * 2026-10 用户要求：「把……签到功能里的接口测试删掉」
   * → 签到页那整块「接口探测」卡片（含复制精简版/详细版、看精简/看详细）已删。
   *
   * 所以这里**整体反转**：断言界面上不再有这些东西。
   * 而 formatProbeReport 本身的断言（上面那一组，读的是 PROBE 文件）**照旧保留** ——
   * 底层能力没删，只是不给界面入口了。
   */
  t('★★ 签到页已不再存探测原始结果（那块界面已删）', !/const \[probeRows/.test(SCREEN));
  t('★★ 签到页没有「复制精简版」按钮了', !/复制精简版（发我）/.test(SCREEN));
  t('★★ 签到页没有「复制详细版」入口了', !/复制详细版（含每条完整返回/.test(SCREEN));
  t('★★ 签到页没有「看精简 / 看详细」切换了', !/probeDetail \? '看精简' : '看详细'/.test(SCREEN));
  t('★★ 签到页不再调用 formatProbeReport（界面侧已摘掉）', !/formatProbeReport\(probeRows/.test(SCREEN));
  /**
   * ⚠️ 这里原本还有 5 条**正向**断言（「有复制精简版按钮」「有复制详细版入口」
   *    「能切换看精简/看详细」「复制时才算格式」「注释记录了用户原话」），
   *    与上面那组方向相反。
   *
   *    2026-10 用户要求「把……签到功能里的接口测试删掉」后，这些**全部失效**，
   *    所以直接删掉 —— 留着会一直报红，
   *    而"一直报红的测试"比没有测试更糟（会掩盖真正的回归）。
   *
   *    ⚠️ 那句用户原话「不能全部复制，太多了」仍保留在
   *       `probeActivityApi.ts` 的注释里（底层能力没删），
   *       上面的 PROBE 断言组已经覆盖。
   */
}

console.log('\n=== ② 启动计时：卡在哪一步要能查到 ===');
{
  t('★★★ 新建了 startupTiming 模块', TIMING.length > 0);
  t('★★ 有 markStart / mark / markReady', /export function markStart/.test(TIMING) && /export function mark\(/.test(TIMING) && /export function markReady/.test(TIMING));
  t('★★★ 只在**超过阈值**时记日志', /if \(sinceLast >= SLOW_MS\)/.test(TIMING));
  t('★★ 阈值是 1500ms（冷启动本身可能几百毫秒，别太敏感）', /const SLOW_MS = 1500/.test(TIMING));
  /** ⚠️ 这条很重要：否则每次启动写一条，会把 30 条窗口占满（踩过） */
  t('★★★ 注释说明了为什么只在超阈值时记（避免噪音挤掉真崩溃）', /把真崩溃挤出|会占满|窗口/.test(TIMING));
  t('★★ 有防重复打点（同一个点只记一次）', /if \(marks\.has\(name\)\) return/.test(TIMING));

  /** App.tsx 接线 */
  t('★★★ App 里 markStart 在 installCrashLogger 之后', /installCrashLogger\('root'\)[\s\S]{0,400}?markStart\(\)/.test(APP));
  t('★★ 首帧渲染后打点', /mark\('first-render'\)/.test(APP));
  t('★ 账号读取完成打点', /mark\('checkin-hydrate-account'\)/.test(STORE));
  t('★★ 注释记录了用户原话（是"卡住要等"不是"真崩"）', /不是真的崩了|隔一阵子能进/.test(TIMING));
}

console.log('\n=== ③ 登录提速：账号先落地，课程后台拉 ===');
{
  /**
   * ⚠️ 必须先剥掉注释 —— 我在注释里**引用了旧写法**做说明，
   *    直接搜原文会匹配到注释，导致误判（这次就踩了）。
   */
  const STORE_CODE = STORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /**
   * ⚠️ 核心断言：`SET_ACCOUNT` **不能**排在 `await fetchCourses` 之后。
   *    原来就是那样，所以账号要等几十次网络往返才落地。
   */
  t('★★★ bindWithSession 里 SET_ACCOUNT 在 fetchCourses 之前', (() => {
    const seg = STORE_CODE.slice(
      STORE_CODE.indexOf('async bindWithSession'),
      STORE_CODE.indexOf('async submitMfaCode'),
    );
    const iAccount = seg.indexOf("dispatch({ type: 'SET_ACCOUNT'");
    const iFetch = seg.indexOf('adapter.fetchCourses');
    return iAccount > 0 && iFetch > 0 && iAccount < iFetch;
  })());
  t('★★★ 课程是**后台**拉的（void 而不是 await）', /void \(async \(\) => \{[\s\S]{0,300}?fetchCourses/.test(STORE_CODE));
  t('★★★ 后台回来时**校验账号没变**（防止盖到别人头上）', /if \(stateRef\.current\.account\?\.id !== acc\.id\) return;/.test(STORE_CODE));
  t('★★ 后台失败不影响登录（自己 try/catch）', /后台加载课程失败（不影响签到）/.test(STORE_CODE));
  t('★ 注释记录了根因（几十次网络往返）', /几十次网络往返/.test(STORE));
  t('★ 注释记录了用户原话', /每次登录要等的时间都太久了/.test(STORE));

  /** 三条登录路径都要改（漏一条就等于没改） */
  const binds = STORE_CODE.match(/dispatch\(\{ type: 'SET_ACCOUNT', account: acc \}\)/g) ?? [];
  t('★★★ 三条登录路径都改了（密码 / 会话 / 短信）', binds.length === 3, `实际 ${binds.length} 条`);
  t('★★★ 代码里不再有 await safe(...fetchCourses)', !/await safe\(/.test(STORE_CODE));
  t('★ 已删除的 safe 辅助在注释里留了说明', /原来的 `safe\(fn, fallback\)` 辅助\*\*已删除\*\*/.test(STORE));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
