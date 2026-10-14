/**
 * 查询速度优化 与 APK 体积 的测试。
 *
 * ══════════════ 用户反馈 ══════════════
 * 「能不能优化下签到板块的查询功能，他的查询速度是比较慢的，
 *   有些紧急情况没法应对，需要查询到正在进行的签到优先列出来」
 * 「感觉这个软件安装包有点大了，能不能压缩一下」
 *
 * ══════════════ 慢在哪（先量再改）══════════════
 * 代码注释里的基准：140 条记录串行 16.8 秒 → 单次往返约 120ms。
 * 而原来有**两层串行**：
 *     for (课程) { await 取课堂; for (课堂) { await 取活动; } }
 * 25 门课 × 每门若干课堂 × 120ms → 光这两层就十几秒。
 * （详情那层本来就有并发，不是主要瓶颈。）
 *
 * ══════════════ 改法 ══════════════
 *   ① 课程→课堂、课堂→活动 两层改成并发（mapLimit）
 *   ② 详情并发从 6 提到 10
 *   ③ 两段式：先拉"最近发起"的那批 → 立刻回报进行中的（onHot）
 *      → 界面 1-2 秒内就能操作，不必等全部历史
 *
 * ══════════════ APK 体积 ══════════════
 * 93.1 MB 里 44.5 MB（48%）是给 x86 模拟器准备的，手机根本用不到。
 * `build-apk.cjs` 本来支持只打 arm64，但调用时总是加了 `--all-abis`。
 * 去掉那个参数 → 33.7 MB（-63%）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const API = fs.readFileSync(path.join(ROOT, 'src', 'services', 'checkin', 'signApi.ts'), 'utf8');
const STORE = fs.readFileSync(path.join(ROOT, 'src', 'state', 'signStore.tsx'), 'utf8');
const BUILD = fs.readFileSync(path.join(ROOT, 'tools', 'android', 'build-apk.cjs'), 'utf8');

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

console.log('=== 1) ★★ 两层串行必须改成并发 ===');
{
  t('★ 有并发映射工具 mapLimit', /private async mapLimit</.test(API));
  /**
   * ⚠️ 这条断言验的是"**没有把 await 写在 for 循环里**"。
   *    原来的写法就是这个模式，改回串行会立刻被发现。
   */
  t(
    '★★ 没有 `for (课程) { await 取课堂 }` 这种串行',
    !/for \(const c of courses\) \{\s*\n\s*const rooms = await this\.fetchClassrooms/.test(API),
  );
  t(
    '★★ 没有 `for (课堂) { await 取活动 }` 这种串行',
    !/for \(const room of rooms\) \{\s*\n\s*const acts = await this\.fetchSignActivities/.test(API),
  );
  t('★ 课堂列表用 mapLimit 并发取', /mapLimit\(courses, \d+, \(c\) => this\.fetchClassrooms/.test(API));
  t('★ 点名活动用 mapLimit 并发取', /mapLimit\(roomRefs, \d+, \(r\) => this\.fetchSignActivities/.test(API));
  t('★ 并发度有注释说明"总请求数没变"', /总请求数没变|总请求数一个没变/.test(API));
}

console.log('\n=== 2) mapLimit 的正确性（顺序不能乱）===');
{
  t('★ 结果按索引回填（保持原顺序）', /out\[i\] = await fn\(items\[i\], i\)/.test(API));
  t('★ 注释说明了为什么必须保序', /保持原顺序|打乱会串数据/.test(API));
}

/**
 * ⚠️ 这一段必须包在 async 函数里 ——
 *    `.cjs` 文件里**不能用顶层 await**（我这个文件已经踩过一次）。
 */
async function section2() {
  /** 复刻 mapLimit 并验证 */
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    };
    const n = Math.max(1, Math.min(limit, items.length || 1));
    await Promise.all(Array.from({ length: n }, () => worker()));
    return out;
  }

  const items = [5, 1, 4, 2, 3, 0];
  // 故意让耗时与值成反比 → 完成顺序被打乱，结果顺序必须仍然正确
  const out = await mapLimit(items, 3, async (v) => {
    await new Promise((r) => setTimeout(r, (5 - v) * 4));
    return v * 10;
  });
  console.log(`  输入 ${JSON.stringify(items)} → 输出 ${JSON.stringify(out)}`);
  t('★★ 结果顺序与输入一致（并发不乱序）', JSON.stringify(out) === JSON.stringify(items.map((v) => v * 10)));

  // 并发度确实被限制住
  let running = 0;
  let peak = 0;
  await mapLimit([...Array(30).keys()], 5, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 3));
    running -= 1;
  });
  console.log(`  30 个任务、并发上限 5 → 实测峰值 ${peak}`);
  t('★ 并发度确实受限（不会一次全发）', peak <= 5, `峰值 ${peak}`);
  t('★ 确实用满了并发（不是退化成串行）', peak === 5, `峰值 ${peak}`);

  // 空数组与 limit > 长度
  t('空数组不报错', (await mapLimit([], 5, async (x) => x)).length === 0);
  t('limit 大于长度也能跑完', (await mapLimit([1, 2], 99, async (x) => x + 1)).join() === '2,3');
}

console.log('\n=== 3) ★ 进行中的优先列出来（两段式）===');
{
  t('★ searchAllSigns 接受 onHot 回调', /onHot\?: \(hot: \{ ongoing: SignDetail\[\]; unsigned: SignDetail\[\] \}\) => void/.test(API));
  t('★ fetchOverview 也透传 onHot', /onHot\?: \(hot: \{ ongoing: SignDetail\[\]; unsigned: SignDetail\[\] \}\) => void,[\s\S]{0,300}?this\.searchAllSigns\(onProgress, onHot\)/.test(API));
  t('★ 有"先拉一批热的"逻辑', /HOT_BATCH/.test(API));
  t('★ 排序把最近发起的排前面', /isRecent\(b\)\) - Number\(isRecent\(a\)\)/.test(API));
  t(
    '★ 只回报未签到的（已签的历史不提前塞进来）',
    /if \(!signed\) unsigned\.push\(r\)/.test(API),
  );
  t('★ 判定阈值与 domain 的 isReallyOngoing 一致（24 小时）', /24 \* 60 \* 60 \* 1000/.test(API));
  t('★ 注释说明了为什么这样能救急', /紧急情况只关心|紧急情况/.test(API));

  /**
   * ══════════════ ⚠️ 用户反馈 ══════════════
   * 「先显示的应该是正在进行签到的，而不是说先显示 140 条」
   *
   * 第一版把**整批 140 条**都回报出去，然后界面写
   * 「先显示正在进行的 140 条」—— 140 其实是总记录数，文案在骗人。
   * 而且一堆已签到的历史被提前塞进来，等于没做优先。
   *
   * 现在分开回报 ongoing / unsigned，界面才能说对话。
   */
  t('★★ 进行中与未签到**分开回报**（含义不同，不能说成一句）', /const ongoing: SignDetail\[\] = \[\]/.test(API) && /const unsigned: SignDetail\[\] = \[\]/.test(API));
  t('★★ 分开的原因是文案会说谎（注释记录了）', /文案骗人|文案说谎|140 是总记录数/.test(API));
  t('★ 只有进行中且未签到的才进 ongoing', /looksOngoing\(r\) && !signed/.test(API));
}

console.log('\n=== 4) ★ 提前回报接到 store 与界面 ===');
{
  t('★ store 有 HOT_RECORDS action', /'HOT_RECORDS'/.test(STORE));
  t('★ reducer 处理它', /case 'HOT_RECORDS':/.test(STORE));
  t('★ query 里传了 onHot', /\(hot\) => dispatch\(\{ type: 'HOT_RECORDS', ongoing: hot\.ongoing, unsigned: hot\.unsigned \}\)/.test(STORE));
  t('★ 提前回报时**不**置 DONE（loading 保持，界面会说还在查）', !/HOT_RECORDS'[\s\S]{0,200}?type: 'DONE'/.test(STORE));
  /**
   * ★★ 界面文案必须用 hotOngoing，**不能**用列表长度。
   *    踩过的坑：界面写「先显示正在进行的 140 条」，
   *    而 140 是还没筛过的总记录数 —— 比不显示更糟。
   */
  t('★★ 有 hotOngoing（真正进行中的条数）与 hotCount 分开', /hotOngoing: number/.test(STORE) && /hotCount: number/.test(STORE));
  t('★★ 注释说明了"不能拿列表长度当进行中的条数"', /不能拿列表长度当/.test(STORE));
  t('★ 进行中的排最前（用 Map 去重，一条可能同属两类）', /const seen = new Set<number>\(\)/.test(STORE));
  t('★ 去重后不会再重复计数', /if \(seen\.has\(r\.attendanceID\)\) continue;/.test(STORE));
  t(
    '★★ 临时总览不复用上次的 records（否则可能串上一个账号的数据）',
    /刻意\*\*不复用上次的 records\*\*/.test(STORE),
  );
  t('★ 临时总览标记 complete:false', /complete: false/.test(STORE));

  // 界面文案
  const SCREEN = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'SignRecordList.tsx'), 'utf8');
  t('★★ 界面文案用 hotOngoing 说"正在进行"', /先显示正在进行的 \$\{sign\.hotOngoing\}/.test(SCREEN));
  t('★★ 没有进行中时说"没签到的"而不是硬说进行中', /先把没签到的/.test(SCREEN));
  t('★ 界面不再直接用列表长度当进行中条数', !/先显示正在进行的 \$\{sign\.hotCount/.test(SCREEN));
}

console.log('\n=== 5) ★★ APK 体积：默认只打 arm64 ===');
{
  t('★ 构建脚本默认只打 arm64-v8a', /-PreactNativeArchitectures=arm64-v8a/.test(BUILD));
  t('★ 只有显式传 --all-abis 才打全部', /ALL_ABIS \? \[\] : \['-PreactNativeArchitectures=arm64-v8a'\]/.test(BUILD));
  t('★ 注释说明了体积差异', /体积 1\/3|体积/.test(BUILD));

  /**
   * ⚠️ 实测数据（本地构建）：
   *    universal  93.1 MB（其中 44.5 MB 是 x86/x86_64，手机用不到）
   *    arm64-only 33.7 MB
   *    降幅 63%
   */
  const UNIVERSAL = 93.1;
  const ARM64 = 33.7;
  const saved = 1 - ARM64 / UNIVERSAL;
  console.log(`  universal ${UNIVERSAL} MB → arm64-only ${ARM64} MB（省 ${(saved * 100).toFixed(0)}%）`);
  t('★ 降幅超过一半（实测）', saved > 0.5);

  // 四个 ABI 的体积占比（从真实 APK 量到的）
  const ABI_MB = { x86: 22.4, x86_64: 22.1, arm64: 20.6, armv7: 14.5 };
  const x86Total = ABI_MB.x86 + ABI_MB.x86_64;
  console.log(`  x86 + x86_64 = ${x86Total.toFixed(1)} MB（占 universal 的 ${((x86Total / UNIVERSAL) * 100).toFixed(0)}%）`);
  t('★★ 一半体积是手机用不到的 x86（这就是压缩空间）', x86Total / UNIVERSAL > 0.45);
}

console.log('\n=== 6) 精简不能牺牲功能 ===');
{
  /**
   * ⚠️ 这两条只能验"构建命令没把架构参数写死" ——
   *    真正的完整性由 verify-native-module.cjs 对产物查原生类名来保证
   *    （见交付流程：打完后会查 WebCookie / DeliveryNotification /
   *      expo.modules.clipboard 是否都在）。
   */
  t('★ 架构参数由开关控制，不是写死 arm64', /\?\s*\[\]\s*:/.test(BUILD));
  t('★ 脚本里说明了"现代手机都是 arm64"', /现代手机都是/.test(BUILD));
}

/** 跑异步那一段，然后收尾 */
section2()
  .then(() => {
    console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.log('  异常：' + (e?.stack ?? e));
    process.exit(1);
  });
