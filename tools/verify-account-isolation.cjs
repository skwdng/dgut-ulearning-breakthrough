/**
 * 账号隔离测试：换账号后**不能**再看到上一个账号的数据。
 *
 * ══════════ 真实踩过的坑 ══════════
 * 用户反馈：「为什么我从自己账号登录到别人的账号，数据还是显示我的」
 *
 * 根因有三条，这个测试把它们逐条钉住：
 *   ① signStore 的缓存 key 是全局的（不分账号）
 *   ② checkinStore 的 courses/tasks/history 缓存 key 也是全局的
 *   ③ 换账号时没有重置内存 state —— 而换账号的路径不止一条
 *      （手动解绑会清，直接用另一个学号登录不会清）
 *
 * 这些是"纯逻辑"问题，可以从源码结构上验证，不需要跑 App。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

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

console.log('=== 1) signStore：缓存按账号分 key ===');
{
  const s = read('state/signStore.tsx');
  t('overview 缓存 key 带 userId', /STORE_KEYS\.signOverview\}\.\$\{account\.userId\}/.test(s));
  t('不再直接写全局 signOverview key', !/store\.set\(STORE_KEYS\.signOverview,/.test(s));
  /**
   * 全局 key 可以**读**（为了把旧版本的数据搬到新 key），
   * 但**必须校验归属**才敢用 —— 而且校验通过后立刻搬走并删掉旧 key。
   */
  const legacyRead = /store\.get<SignOverview \| null>\(STORE_KEYS\.signOverview, null\)/.test(s);
  t('读旧全局 key 时校验归属', !legacyRead || /legacy\.user\?\.userId === account\.userId/.test(s));
  t('搬走后删除旧全局 key', !legacyRead || /store\.remove\(STORE_KEYS\.signOverview\)/.test(s));
  t('旧 key 是别人的数据时也删掉', !legacyRead || /if \(legacy\) void store\.remove\(STORE_KEYS\.signOverview\)/.test(s));
  t('读取时校验缓存归属（userId 必须匹配）', /cached\.user\?\.userId !== account\.userId/.test(s));
  t('写入时校验归属', /state\.overview\.user\?\.userId !== account\?\.userId/.test(s));
}

console.log('\n=== 2) signStore：切换账号时重置内存 state ===');
{
  const s = read('state/signStore.tsx');
  t('有 RESET 动作', /type: 'RESET'/.test(s));
  t('RESET 会清空 overview', /case 'RESET':\s*\n\s*return \{ \.\.\.initialState/.test(s));
  t('读取 effect 依赖 account.userId（账号一变就重跑）', /\}, \[overviewKey, account\?\.userId\]\);/.test(s));
  t('没有 userId 时直接 RESET', /if \(!overviewKey \|\| !account\?\.userId\) \{\s*\n\s*dispatch\(\{ type: 'RESET' \}\)/.test(s));
}

console.log('\n=== 3) checkinStore：身份变化守卫 ===');
{
  const s = read('state/checkinStore.tsx');
  t('SET_ACCOUNT 比较新旧 account.id', /const prevId = state\.account\?\.id \?\? null;/.test(s) && /const nextId = action\.account\?\.id \?\? null;/.test(s));
  t('身份变化时清空 courses', /courses: changed \? \[\] : state\.courses/.test(s));
  t('身份变化时清空 tasks', /tasks: changed \? \[\] : state\.tasks/.test(s));
  t('身份变化时清空 history', /history: changed \? \[\] : state\.history/.test(s));
  t('身份变化时重置统计', /stats: changed \? \{ todayDone: 0/.test(s));
  t('身份变化时清掉上次的错误', /lastError: changed \? null : state\.lastError/.test(s));
  t('身份变化时重置限流冷却', /cooldownUntil: changed \? 0 : state\.cooldownUntil/.test(s));
  t('身份未变时不误清', /if \(prevId === nextId\) return \{ \.\.\.state, account: action\.account \};/.test(s));
}

console.log('\n=== 4) checkinStore：账号数据按 id 分 key ===');
{
  const s = read('state/checkinStore.tsx');
  t('courses 写入带 account.id', /STORE_KEYS\.courses\}\.\$\{id\}/.test(s));
  t('tasks 写入带 account.id', /STORE_KEYS\.tasks\}\.\$\{id\}/.test(s));
  t('history 写入带 account.id', /STORE_KEYS\.history\}\.\$\{id\}/.test(s));
  t('读取时也按 account.id 取', /const suffix = account\?\.id \? `\.\$\{account\.id\}` : '';/.test(s));
  t('没账号时不覆盖任何账号数据', /if \(!id\) return; \/\/ 没账号 → 不覆盖任何账号的数据/.test(s));
}

console.log('\n=== 5) storage：history key 已定义 ===');
{
  const s = read('services/storage.ts');
  t('有 history key', /history: 'history'/.test(s));
}

console.log('\n=== 6) ★ 适配器单例：signApi 必须绑定账号（本次真正的根因）===');
{
  /**
   * 用户反馈：「换账号后查询还都是我的数据，连解绑后重新查也是我的数据」
   *
   * 根因：YouxueAdapter 是**模块级单例**，它缓存 this.signApi
   *（里面装着 token + userId），原先写成
   *     if (this.signApi) return this.signApi;
   * 完全不看 account 是谁 → 换账号后继续用上一个人的会话来查。
   *
   * 这是最隐蔽的一层：上面那些 key 隔离都改对了，
   * 但只要会话客户端复用错人，查出来的数据就还是旧账号的。
   */
  const s = read('services/checkin/youxueAdapter.ts');

  t('有 signApiAccountId 字段（记住 signApi 属于谁）', /private signApiAccountId: string \| null = null;/.test(s));
  /**
   * ⚠️ 这条断言**不要钉死整行写法**。
   *
   * 踩过两次：
   *   · 最早只比 account.id → 换账号时会复用上一个人的会话（已修）
   *   · 后来加了 boundAt → 同账号重新登录时也要重建（又修了一次）
   * 每次改判断条件，钉死格式的断言都会误报失败，
   * 而"失败"看起来像功能坏了，其实只是格式变了。
   *
   * 所以要验的是"**复用前必须校验账号归属**"，而不是某一种写法：
   *   条件块里出现 signApiAccountId === account.id 即算通过。
   */
  t(
    '★ 复用前校验账号一致',
    /if \([\s\S]{0,400}?this\.signApiAccountId === account\.id[\s\S]{0,400}?\)\s*\{?\s*\n?\s*return this\.signApi;/.test(s),
  );
  t('★ 复用条件里还带了 boundAt（同账号重新登录也要重建）', /this\.signApiBoundAt === \(account\.boundAt \?\? null\)/.test(s));
  t('★ 账号不一致时先丢弃', /this\.signApi = null;\s*\n\s*this\.signApiAccountId = null;/.test(s));
  t('建好后记下归属', /this\.signApiAccountId = account\.id;/.test(s));

  // 所有清空点都要一起清归属
  const clears = [...s.matchAll(/this\.signApi = null;/g)].length;
  const clearsId = [...s.matchAll(/this\.signApiAccountId = null;/g)].length;
  t(`清空 signApi 时同步清归属（${clears} 处 / 归属 ${clearsId} 处）`, clearsId >= clears);

  t('unbind 会丢弃会话客户端', /async unbind\(accountId: string\)[\s\S]{0,300}this\.signApi = null;/.test(s));
  t('importSession 入口先丢弃旧客户端', /async importSession\(input: SessionImportInput\)[\s\S]{0,200}this\.signApi = null;/.test(s));

  /**
   * persistSession 里：即使 token/userId 不全也要先清 ——
   * 否则"本次会话不完整"时会静默沿用旧账号的 API。
   */
  t(
    'persistSession 无条件先清（再按需重建）',
    /无论 token\/userId 是否齐全，都要清掉上一个账号的 signApi[\s\S]{0,200}this\.signApi = null;/.test(s),
  );
}

console.log('\n=== 7) ★ 查询结果归属校验（最后一道防线）===');
{
  const s = read('state/signStore.tsx');
  t('比对返回的 userId 与当前账号', /const gotId = overview\.user\?\.userId;/.test(s) && /const wantId = account\.userId;/.test(s));
  t('不一致时丢弃结果并报错', /gotId !== wantId/.test(s) && /已丢弃这次结果/.test(s));
  t('不一致时记录故障日志', /\[签到查询\] 账号不匹配/.test(s));
  t('★ 不一致时不会 dispatch SET_OVERVIEW', (() => {
    // SET_OVERVIEW 必须出现在比对之后
    const check = s.indexOf('gotId !== wantId');
    const set = s.indexOf("dispatch({ type: 'SET_OVERVIEW', overview })", check);
    return check > 0 && set > check;
  })());

  /** 复刻守卫判断 */
  function accept(gotId, wantId) {
    if (gotId && wantId && gotId !== wantId) return false;
    return true;
  }
  t('★ 拿到别人的 userId → 拒绝', accept(90990001, 88888888) === false);
  t('自己的 userId → 接受', accept(90990001, 90990001) === true);
  t('拿不到 userId → 接受（不因此阻断）', accept(undefined, 90990001) === true);
}

console.log('\n=== 9) ★ 登录前必须清 cookie（本次真正的根因）===');
{
  /**
   * 用户反馈：「换别人的账号登录，查的还是我的数据」。
   *
   * 崩溃日志暴露真相：
   *     key=account.cred.dgut-2099000000114  userId=90990001  ← 学号是朋友的，userId 是自己的
   * userId 来自 USER_INFO cookie，说明**cookie 没换**，
   * 登录 114 实际上拿到的还是 116 的会话。
   * 更糟的是：罐子里有有效会话时 CAS 会直接跳票，根本不校验新填的账号密码。
   */
  const wc = read('services/webCookie.ts');

  t('★ nativeLogin 前会清空 cookie', /export async function nativeLogin[\s\S]{0,1200}?await clearCookies\(\);/.test(wc));
  t('清 cookie 在调用原生 login 之前', (() => {
    const fn = wc.indexOf('export async function nativeLogin');
    const clear = wc.indexOf('await clearCookies();', fn);
    const call = wc.indexOf('m.login(', fn);
    return fn > 0 && clear > fn && call > clear;
  })());

  const ad = read('services/checkin/youxueAdapter.ts');

  console.log('');
  console.log('  --- 身份一致性双保险 ---');
  t('有 parseStudentIdFromCookies', /export function parseStudentIdFromCookies/.test(ad));
  /**
   * ⚠️ 校验必须用**归一化后**的学号比较。
   *    实测踩过：cookie 里是 `dgut2099000000114`，输入是 `2099000000114`，
   *    同一个账号却因前缀不等被判为"串号"，合法会话被拒。
   *    归一化逻辑本身另有专门测试（verify-student-id.cjs）。
   */
  t('★ 会话学号与请求学号不符时拒绝保存', /studentIdInCookie !== reqNorm/.test(ad));
  t('比较前先归一化请求学号', /const reqNorm = normalizeStudentIdForCompare\(studentId\);/.test(ad));
  t('拒绝时返回明确的错误说明', /拿到的会话属于另一个学号/.test(ad));
  t('拒绝时记录故障日志', /\[绑定\] ★ 会话与学号不符/.test(ad));
  t('USER_INFO 里解析学号（多个字段名兜底）', /loginName[\s\S]{0,120}studentId/.test(ad));

  const cs = read('state/checkinStore.tsx');
  t('bindWithSession 返回 userId', /bindWithSession\([\s\S]{0,200}userId\?:\s*number/.test(cs));
  t('绑定日志里带上 userId', /绑定成功（会话导入）.*userId=/.test(cs));

  const bind = read('screens/youxue-bind.tsx');
  /**
   * ⚠️ 这两条原来检查 `youxue-bind.tsx`（学号+密码登录页）。
   *    2026-10 学校 CAS 改成 JS 动态渲染登录方式后，
   *    那个页面不再有登录表单、改由 `youxue-web-login.tsx` 承担，
   *    所以这两句提示语**跟着搬到了网页登录页**。
   *
   *    ★ 断言本身一点都不该删 —— 正是它抓出了"搬家时漏了 userId 显示"。
   *      没有这个值，用户就看不出"我登的到底是谁"，
   *      而"换账号后还是我的数据"那次就是靠它定位的。
   */
  const loginPages = read('screens/youxue-web-login.tsx');
  t('★ 登录成功后把 userId 显示给用户', /服务端认到的 userId/.test(loginPages));
  t('同时显示本次登录的学号', /本次登录学号/.test(loginPages));
  t('★ 这两句提示语在**当前实际用的**登录页里', /服务端认到的 userId/.test(loginPages) && /本次登录学号/.test(loginPages));

  console.log('');
  console.log('  --- 串号判据（复刻）---');
  /**
   * 复刻校验：cookie 里的学号 != 请求的学号 → 拒绝。
   * 注意"解析不到学号"时**不拒绝**（不能因为解析失败就挡人）。
   */
  function sessionMatches(requested, inCookie) {
    if (!inCookie) return true; // 解析不到 → 不阻断
    return inCookie === requested;
  }
  t('★ 请求 114 但 cookie 是 116 → 拒绝', sessionMatches('2099000000114', '2099000000116') === false);
  t('请求 116 cookie 也是 116 → 通过', sessionMatches('2099000000116', '2099000000116') === true);
  t('解析不到学号 → 通过（不阻断）', sessionMatches('2099000000114', undefined) === true);
}

console.log('\n=== 10) 账号身份标识唯一性（模拟 reducer 判据）===');
{
  /** 复刻 account.id 的构造（youxueAdapter: `${tenant}-${studentId}`） */
  const accountId = (tenant, studentId) => `${tenant}-${studentId}`;
  t('同一学号 id 相同', accountId('dgut', '2099000000116') === accountId('dgut', '2099000000116'));
  t('★ 不同学号 id 不同（守卫能识别）', accountId('dgut', '2099000000116') !== accountId('dgut', '2099000000999'));
  t('null 与有值不同', accountId('dgut', 'x') !== null);

  /** 复刻守卫的核心判断 */
  function shouldClear(prev, next) {
    return (prev ?? null) !== (next ?? null);
  }
  t('★ A → B 要清空', shouldClear(accountId('dgut', 'A'), accountId('dgut', 'B')) === true);
  t('★ B → A 要清空', shouldClear(accountId('dgut', 'B'), accountId('dgut', 'A')) === true);
  t('A → A 不清空', shouldClear(accountId('dgut', 'A'), accountId('dgut', 'A')) === false);
  t('解绑（A → null）要清空', shouldClear(accountId('dgut', 'A'), null) === true);
  t('首次登录（null → A）要清空', shouldClear(null, accountId('dgut', 'A')) === true);
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
