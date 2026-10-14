/**
 * 「小操作」层级 与 授权门槛 的测试。
 *
 * ══════════════ ★ 用户明确要求的层级（2026-10）══════════════
 * 「小操作类与任务查询同级，都归于优学院类，
 *   然后使用授权码才能使用小操作功能，
 *   小操作功能里面包含上面说的三个功能」
 *
 *   ┌─ 优学院（底部页）──────────────┐
 *   │  📋 任务查询                    │  ← 不需要授权
 *   │  🎛 小操作      [需授权]        │  ← ★ 门槛在这一层
 *   └──────────────────────────────┘
 *                    ↓
 *   ┌─ 小操作 ──────────────────────┐
 *   │  ✓ 签到  /  ± 加减分  /  ⊘ 点不中 │
 *   └──────────────────────────────┘
 *
 * ══════════════ ★★★ 最关键的一条：门槛挂在"页面"而不是"模块" ══════════════
 *
 * 「用授权码才能用小操作」有两种实现方式：
 *
 *   ① 模块级（`youxue.requiresLicense = true`）—— **不行**
 *      `requiresLicense` 是**整模块**生效的（见 computeModuleRuntime）。
 *      挂上去会把「任务查询」也拦住 ——
 *      而用户会话过期时，正是靠任务查询那边去重新登录。
 *      把登录路径也锁上，等于把人锁在门外。
 *
 *   ② **页面级**（`screens/xiaocao.tsx` 套 `<LicensedScreen>`）—— 采用
 *      `LicensedScreen` 读 `useUnlock().entitled`（**授权码**机制）。
 *
 *      ⚠️ 早先它读 `useLicense().licensed` —— 那是**另一套**（远程名单），
 *         而本项目没有名单接口、也没配名单地址，所以那个值**永远是 false**，
 *         表现就是「暂时无法校验 / 不可用」，**有授权码也用不了**。
 *         这个测试现在钉住"必须用授权码那套"。
 *
 * 这个测试就钉住"必须是 ② 不是 ①"。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULES = fs.readFileSync(path.join(ROOT, 'src', 'domain', 'modules.ts'), 'utf8');
const XIAOCAO = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'xiaocao.tsx'), 'utf8');
const YOUXUE = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'tab-youxue.tsx'), 'utf8');
const TABS = fs.readFileSync(path.join(ROOT, 'src', 'nav', 'tabs.tsx'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'src', 'nav', 'shell.tsx'), 'utf8');
const ROUTER = fs.readFileSync(path.join(ROOT, 'src', 'nav', 'router.tsx'), 'utf8');
const SCREENS = fs.readFileSync(path.join(ROOT, 'src', 'nav', 'screens.tsx'), 'utf8');
/** ⚠️ 提到顶层 —— 下面两个块都要用（块作用域的 const 跨不过去，踩过） */
const SCREENS_SRC = SCREENS;

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
const XIAOCAO_CODE = codeOf(XIAOCAO);
const YOUXUE_CODE = codeOf(YOUXUE);

console.log('=== 1) ★★ 层级：小操作与任务查询同级，都归于优学院 ===');
{
  t('★★ 优学院页同时有「任务」和「小操作」两个入口', /label="任务"/.test(YOUXUE_CODE) && /label="小操作"/.test(YOUXUE_CODE));
  t('★ 任务入口跳 /youxue-task', /push\('\/youxue-task'\)/.test(YOUXUE_CODE));
  t('★ 小操作入口跳 /xiaocao', /push\('\/xiaocao'\)/.test(YOUXUE_CODE));
  /** ⚠️ 两者必须是**同级**（同一个 Section 的 Col 里），不能嵌套 */
  const sectionStart = YOUXUE_CODE.indexOf('title="功能"');
  const seg = sectionStart >= 0 ? YOUXUE_CODE.slice(sectionStart, sectionStart + 1600) : '';
  t('★★ 两个入口在同一个 Section 里（同级，不是嵌套）', seg.includes('任务') && seg.includes('小操作'));
  t('★ 小操作不是底部页（从 TABS 里拿掉了）', !/key: 'checkin', label: '小操作'/.test(SHELL));
  t('★ 底部栏现在是 首页/优学院/外卖/AI', /label: '首页'/.test(SHELL) && /label: '优学院'/.test(SHELL) && !/key: 'checkin'/.test(SHELL));
  t('★ /xiaocao 注册成了二级页', /'\/xiaocao': \{ title: '小操作'/.test(SCREENS));
  t('★ RoutePath 里有 /xiaocao', /\| '\/xiaocao'/.test(ROUTER));
}

console.log('\n=== 2) ★★★ 门槛在页面级，不在模块级 ===');
{
  /**
   * ⚠️ 模块级会连「任务查询」一起拦住 —— 那是登录失败时的唯一出路。
   */
  const yxStart = MODULES.indexOf("key: 'youxue'");
  const yxSeg = yxStart >= 0 ? MODULES.slice(yxStart, yxStart + 1400) : '';
  t('★★★ 优学院模块**没有** requiresLicense', !/requiresLicense:\s*true/.test(yxSeg));
  t('★★ 注释说明了为什么不挂在模块上（会拦住任务查询）', /会连「任务查询」一起拦住|任务查询.*也.*拦住/.test(MODULES));

  /** ★ 门槛落在页面上 */
  t('★★★ 小操作页套了 LicensedScreen', /import \{ LicensedScreen \}/.test(XIAOCAO) && /<LicensedScreen>/.test(XIAOCAO));

  /**
   * ══════════════ ★★★ 闸门必须按「授权码」判，不能按「远程名单」判 ══════════════
   *
   * 踩过的坑：闸门原先读 `useLicense().licensed`（远程名单那套），
   * 而本项目没有名单接口、也没配名单地址 →
   * `licensed` **永远是 false** → **有授权码也用不了**，
   * 界面显示「暂时无法校验 / 名单条目：未获取 / 不可用」。
   *
   * 现在读 `useUnlock().entitled`（授权码机制）。
   * 这条断言就钉住它别被改回去。
   */
  {
    const LS = fs.readFileSync(path.join(ROOT, 'src', 'components', 'LicensedScreen.tsx'), 'utf8');
    const LS_CODE = codeOf(LS);
    t('★★★ LicensedScreen 用 useUnlock（授权码），不用 useLicense（远程名单）', /useUnlock\(\)/.test(LS_CODE) && !/useLicense\(\)/.test(LS_CODE));
    t('★★★ 判据是 entitled', /const \{ entitled \} = useUnlock\(\)/.test(LS_CODE));
    t('★★ 注释记录了这个坑（否则以后有人会改回去）', /永远是 false/.test(LS) && /不管有没有授权码都用不了/.test(LS));

    const LG = fs.readFileSync(path.join(ROOT, 'src', 'components', 'LicenseGate.tsx'), 'utf8');
    const LG_CODE = codeOf(LG);
    /** 闸门页必须给**填码框** —— 否则用户不知道该怎么办 */
    t('★★★ 闸门页有授权码输入框', /TextInput/.test(LG_CODE) && /请输入授权码/.test(LG_CODE));
    t('★★★ 闸门页调 unlock 的 submit', /actions\.submit\(/.test(LG_CODE));
    t('★★ 成功状态判的是 granted（不是 ok）', /r\.status === 'granted'/.test(LG_CODE));
    t('★★ 没生效时不给功能内容（不透露"已解锁"）', /!unlocked \?/.test(LG_CODE));
    t('★ 说明了怎么拿码（找管理员要对应学号的码）', /怎么拿到授权码/.test(LG));
    t('★★ 说明只控制小操作，任务查询不受影响', /任务查询不受影响/.test(LG));
  }

  /** 未授权时优学院页要能看出「需授权」（但**不能**藏起来，否则找不到开通入口） */
  t('★★ 未授权时入口仍显示并标「需授权」', /需授权/.test(YOUXUE_CODE));
  t('★ 标「需授权」用的是 entitled 状态', /const \{ entitled \} = useUnlock\(\)/.test(YOUXUE));
  t('★★ 未授权也不会隐藏入口（否则用户不知道去哪开通）', !/entitled \?[\s\S]{0,80}?EntryBlock[\s\S]{0,80}?: null/.test(YOUXUE_CODE));
}

console.log('\n=== 3) ★★ 小操作里是那三个功能 ===');
{
  t('★★ 有「签到记录」入口', /label="签到记录"/.test(XIAOCAO_CODE));
  t('★★ 有「加减分」', /label="加减分"/.test(XIAOCAO_CODE));
  t('★★ 有「点不中」', /label="点不中"/.test(XIAOCAO_CODE));
  t('★ 三个都在同一个页面里', (XIAOCAO_CODE.match(/<OpRow/g) ?? []).length >= 3);
  /**
   * ══════════════ ⚠️ 这条断言随功能落地而变（2026-10）══════════════
   *
   * 原来要求「开发中」正好 **2 个**（加减分 + 点不中）。
   * 但「点不中」已经实装（挪到 `/dianbuzhong` 专页），所以现在只剩
   * **1 个**（加减分）。
   *
   * ⚠️ 教训：把"有几个占位标记"写死成精确数字，一旦功能落地就会误报。
   *    所以这里改成"**至少 1 个、且点不中不再是开发中**"，
   *    这样以后加减分也实装时不会又炸。
   */
  {
    const devCount = (XIAOCAO_CODE.match(/text: '开发中'/g) ?? []).length;
    t('★ 未完成的仍标「开发中」（加减分还在开发中）', devCount >= 1, `开发中 ${devCount} 个`);
    /** ★ 点不中已实装 → 入口必须能点（有 onPress 到 /dianbuzhong） */
    t('★★★ 点不中已实装 → 入口可点（跳 /dianbuzhong）', /router\.push\('\/dianbuzhong'\)/.test(XIAOCAO_CODE));
    t('★★ 点不中入口不再带"开发中"标记', !/label="点不中"[\s\S]{0,200}?text: '开发中'/.test(XIAOCAO_CODE));
  }
  t('★ 未完成的不可点（disabled）', /disabled/.test(XIAOCAO_CODE));
  /**
   * ══════════════ ★★★ 必须跳 /sign-qr，不能跳 /checkin ══════════════
   *
   * 踩过的坑：原来跳 `/checkin`，而那是「自动签到设置页」
   * （开关 / 策略 / 单日上限 / 立即检测）——
   * 用户点「签到」看到的是设置页，**找不到改状态和接口探测按钮**，
   * 于是反馈「找不到接口检测按钮」。
   *
   * 正确的落点是 `/sign-qr`（签到记录列表），
   * 接口探测按钮就在那个页面里。
   */
  t('★★★ 签到入口跳 /sign-qr（签到记录列表，探测按钮在这里）', /push\('\/sign-qr'\)/.test(XIAOCAO_CODE));
  t('★★★ 不再跳 /checkin（那是自动签到设置页）', !/push\('\/checkin'\)/.test(XIAOCAO_CODE));
  t('★★ 注释记录了这个坑（否则会被改回去）', /找不到改状态和接口探测|找不到改状态/.test(XIAOCAO));
  t('★★ 说明了两个功能为什么还没好（不含糊）', /为什么还没好/.test(XIAOCAO));
  /**
   * ══════════════ ★★★ 断言方向反过来：入口要"不在"（2026-10）══════════════
   *
   * 用户原话：
   *   「帮我把小操作里的接口测试器和崩溃日志还有签到功能里的接口测试删掉」
   *
   * ⚠️ 这条原来是"崩溃日志入口在小操作页（就近，因为签到在这）"——
   *    即要求入口**存在**。现在用户明确要删，所以断言反过来了：
   *    入口文案与跳转**都不许再有**。
   *    （只删 push 不删卡片会留一个点不动的入口，只删卡片不删 push
   *      则下次谁把卡片加回来就悄悄复活了 —— 两样都要判。）
   *
   * ⚠️ 判的是 `XIAOCAO_CODE`（已剥注释）：
   *    源码注释里**故意**留了"这里原来还有两张卡片：崩溃日志 / 接口测试器"
   *    作留档，不剥注释就会把留档当成残留。
   */
  t('★★★ 崩溃日志入口已按用户要求删除', !/label="崩溃日志"/.test(XIAOCAO_CODE) && !/push\('\/crash-log'\)/.test(XIAOCAO_CODE));
  t('★★★ 接口测试器入口已按用户要求删除', !/label="接口测试器"/.test(XIAOCAO_CODE) && !/push\('\/api-tester'\)/.test(XIAOCAO_CODE));
  /** ★ 删除原因要留档（注释里引用用户原话），否则以后会被当成"丢代码"加回来 */
  t('★ 删除原因有留档（注释里引用了用户原话）', /接口测试器/.test(XIAOCAO) && /崩溃日志/.test(XIAOCAO));
}

console.log('\n=== 3b) ★★★ 授权门槛在**路由层**，覆盖所有签到类页面 ===');
{
  /**
   * ══════════════ 这是补一个我自己造成的漏洞 ══════════════
   *
   * 原先门槛只挂在 `/checkin` 上，`/sign-qr` 等页面**自己没有门槛** ——
   * 它们靠"必须先过 /checkin 才跳进来"这条链间接受保护：
   *     小操作 → /checkin（有门槛）→ /sign-qr
   * 后来把 `/checkin` 整个删掉，链路变成：
   *     小操作 → /sign-qr        ← ❌ 门槛没了
   * 而改状态走的是教师接口，**服务端不校验"改的是不是自己"** ——
   * 所以这道闸是唯一的防线，漏了就等于功能白送。
   */
  t('★★★ 有 licensed() 包装函数（路由层加门槛）', /function licensed\(/.test(SCREENS_SRC));
  for (const route of ['/sign-qr', '/sign-location', '/sign-oneshot', '/checkin-manual', '/checkin-log']) {
    const re = new RegExp(`'${route.replace(/\//g, '\\/')}':\\s*\\{[^}]*licensed\\(`);
    t(`★★★ ${route} 经过授权门槛`, re.test(SCREENS_SRC));
  }
  t('★★ 注释说明了为什么要放路由层（漏一个就是漏洞）', /漏一个就是漏洞|唯一的防线/.test(SCREENS_SRC));
}

console.log('\n=== 3c) ★★ 自动签到已按用户要求移除 ===');
{
  /**
   * 用户原话：「就是我要加功能之前的那种样子，**不要自动签到**」
   *
   * ⚠️ 注意分寸：删的是**页面与开关**，不是整个 checkinStore ——
   *    signStore / taskStore / unlockStore / licenseStore 都从它取 `account`。
   *    而轮询本身受 `autoEnabled` 闸住（默认 false），不去开就永远不跑，
   *    所以底层留着是惰性的、无害的。
   */
  const STORE = fs.readFileSync(path.join(ROOT, 'src', 'state', 'checkinStore.tsx'), 'utf8');

  t('★★ 自动签到页面文件已删除', !fs.existsSync(path.join(ROOT, 'src', 'screens', 'checkin.tsx')));
  t('★★ 路由表里没有 /checkin', !/'\/checkin':/.test(SCREENS_SRC));
  t('★★ RoutePath 里没有 /checkin', !/\| '\/checkin'/.test(ROUTER));
  /**
   * ⚠️ 断言名里别用单引号（这是单引号字符串）—— 上一版写成
   *    `push('/checkin')` 直接造成语法错误。用中文引号或双引号包。
   */
  t('★★ 全项目没有跳 /checkin 的残留', !/push\('\/checkin'\)/.test(SCREENS_SRC + XIAOCAO + YOUXUE));

  /** ★ 底层必须留着 —— 删了会让四个 store 拿不到 account */
  t('★★★ checkinStore 仍导出 account（四个 store 依赖它）', /account/.test(STORE));
  t('★★★ 轮询仍受 autoEnabled 闸住（不开就不跑）', /if \(!account \|\| !s\.autoEnabled\) return;/.test(STORE));
  t('★★ autoEnabled 默认 false', /autoEnabled: false/.test(STORE));

  /** ★ 界面上不该再出现"开启自动签到"这种做不到的指引 */
  const manual = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'checkin-manual.tsx'), 'utf8');
  const logSrc = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'checkin-log.tsx'), 'utf8');
  const profileSrc = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'profile.tsx'), 'utf8');
  t('★★ 手动签到页不再叫用户"开启自动签到"', !/请先开启自动签到|请回到签到页开启自动签到/.test(manual));
  t('★ 手动签到页改指「小操作 → 签到记录」', /小操作 → 签到记录/.test(manual));
  t('★★ 签到日志空态不再提自动签到', !/开启自动签到后/.test(logSrc));
  t('★★ 我的页不再显示"自动签到监控中/未开启"', !/自动签到监控中|自动签到未开启/.test(profileSrc));
}

console.log('\n=== 4) 签到模块已删除，但签到功能本身没丢 ===');
{
  t('★★ 模块注册表里没有 checkin', !/key: 'checkin'/.test(MODULES));
  t('★ ModuleKey 类型里没有 checkin', !/\| 'checkin'/.test(MODULES));
  t('★ TopTabKey 里没有 checkin', !/TopTabKey = [^;]*checkin/.test(ROUTER));
  t('★ TAB_SCREENS 里没有 checkin', !/checkin: XiaoCao/.test(TABS));
  /** ⚠️ 签到功能本身还在（只是落点换成了签到记录列表） */
  t('★★ 签到记录页仍在路由表里', /'\/sign-qr': \{ title: '签到记录'/.test(SCREENS));
  t('★★ 签到记录页经过授权门槛', /'\/sign-qr':\s*\{[^}]*licensed\(/.test(SCREENS));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
