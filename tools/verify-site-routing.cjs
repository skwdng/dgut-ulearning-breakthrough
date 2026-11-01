/**
 * 回归测试：**多站点 URL 解析**（`resolvePath`）。
 *
 * ══════════════ 用户需求（原话）══════════════
 *
 *   「现在有一个优学院走的中国站点不是东莞理工站点的，怎么改」
 *   「我的意思是直接在上面加一个中国站点的登陆方式」
 *
 * ══════════════ 为什么这条测试最关键 ══════════════
 *
 * 优学院同一套后端有**两种对外暴露方式**：
 *
 *   ① 路径前缀（东莞理工）
 *        https://lms.dgut.edu.cn/apps/newAttendance/signByTea
 *   ② 子域名（优学院中国站）
 *        https://apps.ulearning.cn/newAttendance/signByTea
 *                                ↑ 注意 `/apps` 那一段**没有了**
 *
 * 如果映射错了，症状是 404 / 401 —— 而且**界面上的错误信息
 * 完全指不出是"路径拼错了"**（这个项目已经因为类似原因排查过很多轮）。
 *
 * 所以把映射规则钉死：
 *   · pathPrefix → lms 域名 + 原路径（前缀**保留**）
 *   · subdomain  → 服务子域名 + 路径（前缀**去掉**）
 *   · 非服务前缀（/static /courseweb /umobile）→ 一律 lms
 *
 * ══════════════ 怎么测的 ══════════════
 *
 * `src/config/sites.ts` 是**零依赖**的纯 TS，所以可以直接用 TypeScript
 * 自带的 `transpileModule` 转成 JS 再求值 —— 不需要额外的运行器。
 *
 * 用法: node tools/verify-site-routing.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'config', 'sites.ts');

/** 把 sites.ts 转成 CommonJS 并求值，拿到真实实现（不是复刻） */
function loadSites() {
  const code = fs.readFileSync(SRC, 'utf8');
  const out = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'require', out)(mod.exports, mod, require);
  return mod.exports;
}

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

let S;
try {
  S = loadSites();
} catch (e) {
  console.error(`  XX  无法加载 sites.ts：${e.message}`);
  process.exit(1);
}

const { SITE_DGUT, SITE_ULEARNING_CN, resolvePath, hostsOfSite, getSiteConfig } = S;

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('   多站点 URL 解析（resolvePath）');
console.log('  ══════════════════════════════════════════════');
console.log('');

console.log('=== 1) 两个站点都存在且模式正确 ===');
t('东莞理工 = 路径前缀模式', SITE_DGUT.apiMode === 'pathPrefix', SITE_DGUT.apiMode);
t('中国站 = 子域名模式', SITE_ULEARNING_CN.apiMode === 'subdomain', SITE_ULEARNING_CN.apiMode);
t('两个站点的 code 不同', SITE_DGUT.code !== SITE_ULEARNING_CN.code);
t('未知 code 回退到东莞理工', getSiteConfig('__不存在__').code === SITE_DGUT.code);

console.log('');
console.log('=== 2) ★★★ 路径前缀模式：前缀保留 ===');
{
  const cases = [
    ['/apps/user/getUserByUserID/1', 'https://lms.dgut.edu.cn/apps/user/getUserByUserID/1'],
    ['/courseapi/courses/students?pn=1', 'https://lms.dgut.edu.cn/courseapi/courses/students?pn=1'],
    ['/apps/newAttendance/signByTea', 'https://lms.dgut.edu.cn/apps/newAttendance/signByTea'],
  ];
  for (const [input, want] of cases) {
    const got = resolvePath(SITE_DGUT, input);
    t(`DGUT ${input.slice(0, 34)}`, got === want, got);
  }
}

console.log('');
console.log('=== 3) ★★★ 子域名模式：前缀**去掉**、换成子域 ===');
{
  const cases = [
    ['/apps/user/getUserByUserID/1', 'https://apps.ulearning.cn/user/getUserByUserID/1'],
    ['/courseapi/courses/students?pn=1', 'https://courseapi.ulearning.cn/courses/students?pn=1'],
    ['/apps/newAttendance/signByTea', 'https://apps.ulearning.cn/newAttendance/signByTea'],
    [
      '/classroomapi/wisdomClassroom/student/getClassroomList?ocId=1',
      'https://classroomapi.ulearning.cn/wisdomClassroom/student/getClassroomList?ocId=1',
    ],
    ['/utestapi/x/y', 'https://utestapi.ulearning.cn/x/y'],
  ];
  for (const [input, want] of cases) {
    const got = resolvePath(SITE_ULEARNING_CN, input);
    t(`CN ${input.slice(0, 38)}`, got === want, got);
  }
}

console.log('');
console.log('=== 4) ★★ 非服务前缀 → 一律落 lms ===');
{
  /** 两种模式都必须这样：静态资源和 H5 入口不在服务网关下 */
  for (const [label, site] of [
    ['DGUT', SITE_DGUT],
    ['CN', SITE_ULEARNING_CN],
  ]) {
    const got = resolvePath(site, '/static/course_web/a.js');
    t(`${label} /static → lms`, got === `${site.services.lms}/static/course_web/a.js`, got);
  }
}

console.log('');
console.log('=== 5) ★ 已是绝对地址则不重复拼 ===');
{
  const abs = 'https://example.com/x';
  t('绝对地址原样返回', resolvePath(SITE_DGUT, abs) === abs);
  t('绝对地址（中国站）原样返回', resolvePath(SITE_ULEARNING_CN, abs) === abs);
}

console.log('');
console.log('=== 6) ★★ 中国站没有 CAS / appHost（校级专属）===');
t('中国站没有 auth', !SITE_ULEARNING_CN.services.auth);
t('中国站没有 appHost', !SITE_ULEARNING_CN.appHost);
t('东莞理工有 auth', Boolean(SITE_DGUT.services.auth));
t('东莞理工有 CAS 回调路径', Boolean(SITE_DGUT.casServicePath));

console.log('');
console.log('=== 7) ★★★ cookie 宿主列表 ===');
{
  const dgutHosts = hostsOfSite(SITE_DGUT);
  t('DGUT 宿主含 lms.dgut.edu.cn', dgutHosts.includes('lms.dgut.edu.cn'), dgutHosts.join(','));
  t('DGUT 宿主含 auth.dgut.edu.cn', dgutHosts.includes('auth.dgut.edu.cn'));
  /**
   * ★★★ 这条是**真 bug 的回归**（2026-10）：
   *
   * 多站点改造时 `hostsOfSite()` 只遍历 `services`，漏掉了 `appHost` ——
   * 而东莞理工的登录/会话 cookie 恰恰落在**应用中心** `application.dgut.edu.cn`。
   * 后果：登录成功，但"读取会话 / 读取课程"失败（旧代码写死过这个域名）。
   *
   * 所以钉死：DGUT 的宿主列表**必须**含应用中心域名。
   */
  t(
    '★★★ DGUT 宿主必须含应用中心 application.dgut.edu.cn（否则登录后读取失败）',
    dgutHosts.includes('application.dgut.edu.cn'),
    dgutHosts.join(','),
  );
  t('★★ 宿主列表必须含登录门户域名（portalUrl）', dgutHosts.includes('application.dgut.edu.cn'));

  const cnHosts = hostsOfSite(SITE_ULEARNING_CN);
  t('CN 宿主含 apps.ulearning.cn', cnHosts.includes('apps.ulearning.cn'), cnHosts.join(','));
  t('CN 宿主含 courseapi.ulearning.cn', cnHosts.includes('courseapi.ulearning.cn'));
  t('CN 宿主含登录门户 www.ulearning.cn', cnHosts.includes('www.ulearning.cn'), cnHosts.join(','));
  t('CN 宿主**不含** dgut 域名', !cnHosts.some((h) => h.includes('dgut')));
  t('宿主列表不含空串', !dgutHosts.includes('') && !cnHosts.includes(''));
}

console.log('');
console.log('=== 8) ★★★ 登录入口地址 ===');
t('DGUT 登录入口是学校门户', SITE_DGUT.portalUrl.includes('application.dgut.edu.cn'), SITE_DGUT.portalUrl);
t(
  'CN 登录入口是优学院官网登录页',
  SITE_ULEARNING_CN.portalUrl.includes('ulearning.cn'),
  SITE_ULEARNING_CN.portalUrl,
);

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  为什么这条测试值得留着：');
console.log('    "路径里要不要 /apps 前缀"这种差异**从报错信息上看不出来**，');
console.log('    只会表现为 404 / 401。没有钉子的话，以后改一次请求封装');
console.log('    就可能把中国站的映射改回带前缀 —— 而且要等用户报错才发现。');
console.log('  ══════════════════════════════════════════════');
console.log('');

console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
