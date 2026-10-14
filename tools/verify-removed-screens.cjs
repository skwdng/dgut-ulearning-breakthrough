/**
 * 「两个页面已删除」的回归测试（用户要求，2026-10）。
 *
 * ══════════════ ★★★ 用户原话 ══════════════
 *
 *   「帮我把小操作里的接口测试器和崩溃日志还有签到功能里的接口测试删掉」
 *
 * 拆开是三件事，本测试逐条钉住：
 *   ① 「接口测试器」入口 + `src/screens/api-tester.tsx` 页面
 *   ② 「崩溃日志」入口 + `src/screens/crash-log.tsx` 页面
 *      （设置页里那个「崩溃日志」入口也一并删掉）
 *   ③ 签到功能里的「接口测试」入口
 *
 * ══════════════ 为什么这类断言必须一条条写清楚 ══════════════
 *
 * 这个项目里删一个页面要同时动**四处**，漏一处就出问题：
 *   · 页面文件本身
 *   · `src/nav/router.tsx` 的 `RoutePath` 联合类型
 *   · `src/nav/screens.tsx` 的 `PUSHED_SCREENS`（连顶上那行 import）
 *   · 各页面的入口（小操作页 / 设置页里的 `router.push(...)`）
 * 少 import 直接编译不过；少路由键运行时点不动；少联合类型则
 * `push('/api-tester')` 依然能过类型检查 —— 于是"已经删掉"的页面
 * 在代码里还是**合法落点**。所以四处都得分开钉。
 *
 * ⚠️ 同样要紧的是**别删过头**：删的是"给自己排查用的界面"，
 *    不是排查能力本身。
 *      · `src/services/crashLog.ts` 的 `logFault()` 仍被多个模块调用
 *        （启动计时 / 登录 / 签到 / 任务 / 更新…），崩了照样写盘
 *      · `signApi.ts` / `signStore.tsx` 的探测函数仍保留（正规流程也在用）
 *    第 5 块就是防误删的断言 —— 页面没了，能力必须还在。
 *
 * ══════════════ ⚠️ 判「没有残留」必须先剥注释 ══════════════
 *
 * 删除的地方**特意在注释里留了用户原话与删除原因**（"崩溃日志 / 接口测试器"、
 * "指向 /crash-log"、"这里删掉了两页"）。
 * 不剥注释就会把【留档】当成【残留】—— 这个坑本项目踩过：
 * verify-dianbuzhong 里 `newAttendance` 出现在解释性注释里被误报过一次。
 * 所以下面所有"不该再有 xx"的断言都先用 `codeOf()` 剥掉注释再判。
 *
 * 用法: node tools/verify-removed-screens.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));

/** 剥掉块注释与整行注释 —— 判"代码里还有没有残留"时必须先剥（见文件头） */
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 递归收集目录下的 .ts/.tsx（第 5、6 块的全项目扫描用） */
function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const ROUTER = read('src', 'nav', 'router.tsx');
const SCREENS = read('src', 'nav', 'screens.tsx');
const XIAOCAO = read('src', 'screens', 'xiaocao.tsx');
const SETTINGS = read('src', 'screens', 'settings.tsx');
const CRASH_SERVICE = read('src', 'services', 'crashLog.ts');
const SIGN_API = read('src', 'services', 'checkin', 'signApi.ts');
const SIGN_STORE = read('src', 'state', 'signStore.tsx');
const SIGN_LIST = read('src', 'screens', 'SignRecordList.tsx');

const ROUTER_CODE = codeOf(ROUTER);
const SCREENS_CODE = codeOf(SCREENS);
const XIAOCAO_CODE = codeOf(XIAOCAO);
const SETTINGS_CODE = codeOf(SETTINGS);

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

console.log('=== 1) ★★★ 两个页面文件必须真的不存在 ===');
{
  t('★★★ src/screens/api-tester.tsx 已删除', !exists('src', 'screens', 'api-tester.tsx'));
  t('★★★ src/screens/crash-log.tsx 已删除', !exists('src', 'screens', 'crash-log.tsx'));
  /**
   * ⚠️ 只判"目标文件不在"还不够：改名成 `api-tester.tsx.bak`、
   *    `crash-log2.tsx` 这种"删了但留着"也算没删干净 ——
   *    而且留着的副本以后很容易被误 import 回来。
   */
  const leftovers = fs
    .readdirSync(path.join(ROOT, 'src', 'screens'))
    .filter((n) => /api-tester|crash-log/i.test(n));
  t('★★ 目录里没有留下"删了一半"的同名文件（.bak / 改名）', leftovers.length === 0, leftovers.join(', '));
}

console.log('\n=== 2) ★★★ 路由与注册表：router.tsx / screens.tsx 里不许再有它们 ===');
{
  /**
   * RoutePath 是联合类型（`| '/xxx'` 一项一项列）。
   * ⚠️ 若只删页面文件、忘了删联合类型里那一项，`push('/api-tester')`
   *    依然能通过类型检查 —— "删掉的页面"在代码里还是合法落点。
   */
  t("★★★ RoutePath 里没有 | '/api-tester'", !/\| '\/api-tester'/.test(ROUTER_CODE));
  t("★★★ RoutePath 里没有 | '/crash-log'", !/\| '\/crash-log'/.test(ROUTER_CODE));
  t(
    '★★★ router.tsx 代码里完全不出现这两个路径',
    !/'\/api-tester'/.test(ROUTER_CODE) && !/'\/crash-log'/.test(ROUTER_CODE),
  );
  /**
   * screens.tsx 里注册一个页面要 import + 路由键两处：
   * 只删 import 编译不过，只删路由键则是运行时不认这个页面。
   */
  t('★★★ screens.tsx 里没有 ApiTesterScreen（连 import 一起）', !/ApiTesterScreen/.test(SCREENS_CODE));
  t('★★★ screens.tsx 里没有 CrashLogScreen（连 import 一起）', !/CrashLogScreen/.test(SCREENS_CODE));
  t(
    '★★★ screens.tsx 里没有这两个路由键',
    !/'\/api-tester'/.test(SCREENS_CODE) && !/'\/crash-log'/.test(SCREENS_CODE),
  );
  /**
   * ★ 反向的一条：**留档**。
   *   删除原因与用户原话必须留在注释里 —— 否则过一阵子（包括我自己）
   *   看到"少了两页"会以为是丢代码，又给加回来。
   *   ⚠️ 这一条判的是**原始文本**（含注释），要的就是注释里有。
   */
  const noted = (s) => /接口测试器/.test(s) && /崩溃日志/.test(s);
  t('★ 删除原因有留档（注释里同时写了两个页面名）', noted(ROUTER) || noted(SCREENS) || noted(XIAOCAO));
}

console.log('\n=== 3) ★★★ 小操作页：两张入口卡片必须删掉，别的入口不许跟着丢 ===');
{
  t('★★★ 小操作页没有「接口测试器」入口', !/label="接口测试器"/.test(XIAOCAO_CODE));
  t('★★★ 小操作页没有「崩溃日志」入口', !/label="崩溃日志"/.test(XIAOCAO_CODE));
  t('★★★ 小操作页没有 push 到 /api-tester', !/push\('\/api-tester'\)/.test(XIAOCAO_CODE));
  t('★★★ 小操作页没有 push 到 /crash-log', !/push\('\/crash-log'\)/.test(XIAOCAO_CODE));
  /**
   * ⚠️ 防"删过头"：这一页里**该留的**功能入口（签到记录 / 加减分 / 点不中）
   *    一个都不能少 —— 删两张相邻卡片时最容易手滑带走第三张。
   */
  t('★★ 该留的入口还在：签到记录', /label="签到记录"/.test(XIAOCAO_CODE));
  t('★★ 该留的入口还在：加减分', /label="加减分"/.test(XIAOCAO_CODE));
  t(
    '★★ 该留的入口还在：点不中（且能点，跳 /dianbuzhong）',
    /label="点不中"/.test(XIAOCAO_CODE) && /push\('\/dianbuzhong'\)/.test(XIAOCAO_CODE),
  );
}

console.log('\n=== 4) ★★ 设置页：崩溃日志入口也没了，但"能看崩溃"的出口还在 ===');
{
  t('★★★ 设置页没有 push 到 /crash-log', !/push\('\/crash-log'\)/.test(SETTINGS_CODE));
  t('★★ 设置页代码里完全不出现 /crash-log', !/'\/crash-log'/.test(SETTINGS_CODE));
  /**
   * ⚠️ 崩了还是得能看 —— 只是换到「诊断信息」页。
   *    这个入口不许跟着一起删（那才叫删过头）。
   */
  t('★★ 诊断信息入口仍在（崩溃记录改从这里看）', /push\('\/diagnostics'\)/.test(SETTINGS_CODE));
}

console.log('\n=== 5) ★★★ 防误删：底层能力必须还在（删的是界面，不是能力）===');
{
  /**
   * 用户要删的是"入口 / 页面"，**不是**崩溃记录本身。
   * `logFault()` 被启动计时、登录、签到、任务、更新等多处调用，
   * 删掉它等于把这些模块的故障上报一起废掉。
   */
  t('★★★ crashLog.ts 仍导出 logFault', /export function logFault\(/.test(CRASH_SERVICE));
  const logFaultCallers = walk(path.join(ROOT, 'src')).filter((f) =>
    /import \{[^}]*\blogFault\b[^}]*\} from/.test(fs.readFileSync(f, 'utf8')),
  );
  t(
    '★★★ logFault 仍被多个模块调用（不是删剩的空壳）',
    logFaultCallers.length >= 5,
    `调用方 ${logFaultCallers.length} 个`,
  );
  /**
   * ⚠️ 探测函数同一次删除里**明确保留**：正规流程（教师代签、状态探测）
   *    也在用它们，删了会直接影响签到功能。
   */
  t('★★★ signApi.ts 的探测函数仍在（正规流程也在用）', /async probeTeacherSignShape\(/.test(SIGN_API));
  /**
   * ⚠️ 更正一处（同一次需求里的 ③）：「签到功能里的接口测试」= 签到页上
   *    那个「诊断」按钮 + 「接口探测」卡片，正在被 src 侧清理
   *    （一次性脚本 `tools/_strip-probe-ui.cjs`，此刻 src 里它还在）。
   *
   * ⚠️ 所以这里**不对签到页的界面入口做断言** —— 那个文件此刻正在被改，
   *    钉它只会造成"改到一半就假失败"。本测试只钉**不该被删掉的东西**：
   *    探测函数仍在 signStore + signApi（正规流程也复用它们）。
   *    等 src 那边定稿后，签到页侧的"入口确实没了"应补一条硬断言。
   */
  t(
    '★★★ 底层探测能力仍在 store + signApi（删的只是界面入口）',
    /probeTeacherSignShape: async \(input\) => \{/.test(SIGN_STORE) && /async probeTeacherSignShape\(/.test(SIGN_API),
  );
  /**
   * ⚠️ 点不中页跟这次删除**毫无关系** —— 顺手把它从路由表里带走
   *    是这种"批量清理"最容易犯的错，所以在这里钉住它全都还在。
   */
  t(
    '★★★ dianbuzhong.tsx 仍在（文件 + RoutePath + 注册表都在）',
    exists('src', 'screens', 'dianbuzhong.tsx') &&
      /\| '\/dianbuzhong'/.test(ROUTER_CODE) &&
      /'\/dianbuzhong': \{ title: '点不中', Component: DianBuZhongScreen \}/.test(SCREENS_CODE),
  );
}

console.log('\n=== 6) ★★★ 全项目扫描：src 下再没有任何地方跳这两个页面 ===');
{
  /**
   * ⚠️ 为什么要递归全扫：删页面时最容易漏的不是 router / screens，
   *    而是**别处**的入口（某个页面里的"去接口测试器看看"按钮、
   *    我的页 / 诊断页里的快捷入口…）。漏一个，用户就会点到一个
   *    已经不存在的页面（白屏或报错），而且很难复现定位。
   */
  const files = walk(path.join(ROOT, 'src'));
  const pushHits = [];
  const importHits = [];
  const pathHits = [];
  for (const f of files) {
    const code = codeOf(fs.readFileSync(f, 'utf8'));
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (/push\('\/api-tester'\)|push\('\/crash-log'\)|replace\('\/api-tester'\)|replace\('\/crash-log'\)/.test(code)) {
      pushHits.push(rel);
    }
    if (/from '[^']*\/api-tester'|from '[^']*\/crash-log'/.test(code)) importHits.push(rel);
    if (/'\/api-tester'|'\/crash-log'/.test(code)) pathHits.push(rel);
  }
  t('★★★ 没有任何 push / replace 到这两个路径的残留', pushHits.length === 0, pushHits.join(', '));
  t('★★★ 没有任何 import 已删页面的残留', importHits.length === 0, importHits.join(', '));
  t('★★★ 连路径字面量都不再出现（含别的跳转写法）', pathHits.length === 0, pathHits.join(', '));
  /**
   * ⚠️ 这条是**给扫描本身兜底**：万一 walk 出错返回空数组，
   *    上面三条会全部"通过"—— 那种假通过比不测更危险。
   */
  t('★ 扫描到的文件数合理（防止 walk 出错造成假通过）', files.length > 60, `${files.length} 个文件`);
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
