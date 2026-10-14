/**
 * 「接口测试器」的**安全边界**测试 —— 页面已删，边界仍在。
 *
 * ══════════════ ★★★ 用户要求删掉了这个页面（2026-10）══════════════
 *
 * 用户原话：
 *   「帮我把小操作里的接口测试器和崩溃日志还有签到功能里的接口测试删掉」
 *
 * → `src/screens/api-tester.tsx` 已删除；`/api-tester` 也从
 *   `router.tsx` 的 RoutePath 与 `screens.tsx` 的 PUSHED_SCREENS 里
 *   拿掉了，小操作页的入口卡片同时删掉。
 *
 * ══════════════ 那这个测试为什么还留着 ══════════════
 *
 * ⚠️ **能力没有随页面一起消失**：
 *   · `signStore.rawApi` 仍在（点不中页 / 其它流程要用它走后端）；
 *   · `signApi.rawRequest` 仍在（探测、给分、删名单都从它走）。
 *   它俩是这个 App 里**唯一能对任意 `/apps/...` 路径发写请求**的东西 ——
 *   页面没了不等于后门没了，所以安全边界必须继续钉住。
 *
 * 所以本测试现在管两件事：
 *   ① ★★★ 后端那两道闸（授权 + 范围）不许被顺手删掉；
 *   ② ★★★ 页面 / 路由 / 入口**确实删干净了**，不许悄悄加回来。
 *
 * ⚠️ 所有"不该再有 xx"的断言都先**剥注释**再判：
 *    源码注释里特意留了用户原话与删除原因（"接口测试器"、"已删"），
 *    不剥注释就会把【留档】当成【残留】（本项目踩过同类坑）。
 *
 * 用法: node tools/verify-api-tester.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const API = fs.readFileSync(path.join(ROOT, 'src', 'services', 'checkin', 'signApi.ts'), 'utf8');
const STORE = fs.readFileSync(path.join(ROOT, 'src', 'state', 'signStore.tsx'), 'utf8');
const PROBE = fs.readFileSync(path.join(ROOT, 'src', 'services', 'checkin', 'probeActivityApi.ts'), 'utf8');
const ROUTER = fs.readFileSync(path.join(ROOT, 'src', 'nav', 'router.tsx'), 'utf8');
const SCREENS = fs.readFileSync(path.join(ROOT, 'src', 'nav', 'screens.tsx'), 'utf8');
const XIAOCAO = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'xiaocao.tsx'), 'utf8');

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
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('=== 1) ★★★ 安全边界：授权 + 配额必须都过（页面删了，边界还在）===');
{
  const STORE_CODE = codeOf(STORE);
  /**
   * ⚠️ 核心：`rawApi` 是能写数据的入口，必须走 `denyStatusChange`
   *    （它内部先 `denyReason()` 再查 scope，两道闸）。
   *    如果绕过它，未授权的人就能直接 POST 改数据。
   */
  t('★★★ rawApi 走了 denyStatusChange（授权 + 范围）', /rawApi: async \(input\) => \{[\s\S]{0,300}?denyStatusChange\(\)/.test(STORE_CODE));
  t('★★★ 被拒时直接返回，不请求', /const denied = denyStatusChange\(\)[\s\S]{0,200}?if \(denied\) \{[\s\S]{0,200}?return \{/.test(STORE_CODE));
  t('★★ 建不起接口时也说清原因（复用 explainNoApi）', /rawApi[\s\S]{0,600}?explainNoApi\(\)/.test(STORE_CODE));
  t('★ 注释说明了为什么必须过闸（否则成后门）', /后门/.test(STORE));
}

console.log('\n=== 2) ★★ signApi.rawRequest 只允许这四种方法 ===');
{
  const API_CODE = codeOf(API);
  t('★★ 方法类型是受限联合（不是任意 string）', /method\?: 'GET' \| 'POST' \| 'PUT' \| 'DELETE'/.test(API));
  t('★ GET 不带 body（否则 fetch 会报错）', /method !== 'GET' \? \{ json: input\.body \}/.test(API_CODE));
  t('★★ 异常被捕获并返回（不抛给界面）', /请求异常：\$\{\(e as Error\)\.message\}/.test(API_CODE));
  t('★ 支持完整 URL（以 http 开头就直用）', /input\.path\.startsWith\('http'\)/.test(API_CODE));
}

console.log('\n=== 3) ★★★ 页面 / 路由 / 入口：确认删干净且不许加回来 ===');
{
  /**
   * 用户原话见文件头。这一块就是"新需求本身"的断言 ——
   * ⚠️ 注意断言方向**反过来了**：原来是"存在 /api-tester"，现在是"不存在"。
   */
  t('★★★ 页面文件已删除', !fs.existsSync(path.join(ROOT, 'src', 'screens', 'api-tester.tsx')));
  t('★★★ RoutePath 里没有 /api-tester', !/'\/api-tester'/.test(codeOf(ROUTER)));
  t('★★★ PUSHED_SCREENS 里没有 ApiTesterScreen（连 import 一起）', !/ApiTesterScreen/.test(codeOf(SCREENS)));
  t(
    '★★★ 小操作页没有入口（文案与跳转都没有）',
    !/push\('\/api-tester'\)/.test(codeOf(XIAOCAO)) && !/label="接口测试器"/.test(codeOf(XIAOCAO)),
  );
  /** ★ 反向：删除原因要留档（注释里引用用户原话），免得以后被"恢复"回来 */
  t('★ 删除原因有留档（注释里写了用户原话）', /接口测试器/.test(ROUTER) && /接口测试器/.test(SCREENS));
}

console.log('\n=== 4) ★★ 模板用的路径是实测确认过的（页面删了，知识没丢）===');
{
  /**
   * ⚠️ 这些路径是**本机实测**得到的（405/400 响应），不是猜的。
   *    原来它们躺在接口测试器的模板里；页面删掉后，
   *    路径与结论必须继续留在 `probeActivityApi.ts`（探测模块还在用）
   *    或 `signApi.ts`（点不中的正规流程在用）。
   */
  for (const p of [
    '/apps/selectperson/getDetail',
    '/apps/selectperson/randomChoosePerson',
    '/apps/selectperson/giveMark',
    '/apps/selectperson/updateSelectRange',
  ]) {
    t(`★★ 实测路径 ${p} 仍有留档（探测模块或 signApi）`, PROBE.includes(p) || API.includes(p));
  }
  /**
   * ⚠️ `classscore/getDetail` **绝不能当请求路径用** ——
   *    它要的是**打分活动自己的 id**，拿选人活动的 id 去读会得到
   *    `{"message":"未知参数错误"}`（用户实测踩过）。
   *    模板已随页面删除，但这条"别再猜回去"的教训要继续钉住。
   */
  t('★★★ 没有把 classscore/getDetail 当请求路径用', !/classscore\/getDetail/.test(codeOf(PROBE) + codeOf(API)));
  t('★★ 注释留了"不再猜第四轮"的理由', /不想再猜第四轮/.test(API) || /不想再猜第四轮/.test(STORE));
}

console.log('\n=== 5) ★★ 接线：点不中页的路由仍完整（别被这次删除带走的邻居）===');
{
  /** ★ 点不中页面也必须注册进路由 —— 它跟这次删除无关，删的时候容易手滑带走 */
  t('★★ RoutePath 里有 /dianbuzhong', /\| '\/dianbuzhong'/.test(ROUTER));
  t('★★ PUSHED_SCREENS 注册了 DianBuZhongScreen', /'\/dianbuzhong': \{ title: '点不中', Component: DianBuZhongScreen \}/.test(SCREENS));
  t('★★ 小操作页入口能点（跳 /dianbuzhong）', /router\.push\('\/dianbuzhong'\)/.test(XIAOCAO));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
