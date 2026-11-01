/**
 * 「登录入口」与「上报」的回归测试。
 *
 * ══════════════ 用户反馈 ══════════════
 * 「在最上端的登录优学院入口进不去，我换了密码也不能从那里登，
 *   报错红色的字，只能从下面的用网页登录，别人也一样」
 *
 * ══════════════ 实测查到的根因 ══════════════
 * 学校 CAS 改成了 **JS 动态渲染登录方式**，
 * 静态 HTML 里**根本没有 password 输入框**。
 * 见 tools/diagnose-cas-form.cjs 打出来的两个页面：
 *
 *   手机 UA → username 提示「请输入手机号」+ dynamicCode「短信验证码」，
 *             cllt=dynamicLogin
 *   桌面 UA → cllt=fidoLogin，username-fido / responseJson-fido（指纹登录）
 *   两个页面：**都没有 type=password 字段**
 *
 * 而 App 那条"原生登录"是**拼表单提交密码** ——
 * 原理上不可能成功（密码框要 JS 跑起来才有）。
 *
 * ⚠️ 所以不该把它放在主入口让所有人撞一次墙。
 *
 * ══════════════ 顺带查出的第二个 bug ══════════════
 * 网页登录那条路**没有上报到管理服务端** ——
 * 而它现在是主入口，等于"用网页登录的人在管理页里看不到"。
 * 这类"两条路径行为不一致"的 bug 很隐蔽。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BIND = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'youxue-bind.tsx'), 'utf8');
const WEB = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'youxue-web-login.tsx'), 'utf8');

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

/** 剥掉注释，只检查真正的代码 */
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const BIND_CODE = codeOf(BIND);

console.log('=== 1) ★★ 绑定页不再放"学号+密码"表单（它原理上不可能成功）===');
{
  t('★★ 没有密码输入框', !/label="密码"/.test(BIND_CODE));
  t('★★ 没有学号输入框', !/label="学号"/.test(BIND_CODE));
  t('★★ 没有调用 nativeLogin（那条路走不通）', !/nativeLogin\(/.test(BIND_CODE));
  t('★ 没有 bindWithSession（登录动作不在这个页面了）', !/bindWithSession/.test(BIND_CODE));
  /**
   * ══════════════ ★★★ 这条改过两次 ══════════════
   *
   * 最初钉「主入口就是网页登录」，按钮文案「打开登录页面」。
   * 多站点改造时变成两个按钮（东莞理工 / 优学院中国站）。
   *
   * 用户最新要求（2026-10）：
   *   「登录优学院下面这一块只留打开登录页面按钮，下面的全部删掉」
   * → 又回到**一个按钮**，文案固定「打开登录页面」，两站说明/当前站点都删了。
   *
   * 要盯的核心没变：**页面本身不放学号密码表单**，登录一律走网页。
   */
  t('★★ 主入口仍是网页登录（只有一个「打开登录页面」按钮）', /label="打开登录页面"/.test(BIND_CODE));
  t(
    '★★ 登录页不再列站点说明（用户要求只留按钮）',
    !/东莞理工学院（学校统一认证）/.test(BIND_CODE) && !/当前站点：/.test(BIND_CODE),
  );
  t('★ 跳转集中于 pickSiteAndLogin（不在按钮上散着写）', /const pickSiteAndLogin/.test(BIND_CODE));
  t('★ 跳转目标仍是 /youxue-web-login', /router\.push\('\/youxue-web-login'\)/.test(BIND_CODE));

  /**
   * ★ 登录入口只能有一处跳转。
   *   多站点后仍然是 1 处（都在 pickSiteAndLogin 里），
   *   如果变成 2 处说明有人又加了"备用入口"。
   */
  const pushes = (BIND_CODE.match(/router\.push\('\/youxue-web-login'\)/g) ?? []).length;
  t('★ 只有一处跳转（两个按钮共用它，不再有"备用"第二处）', pushes === 1, `${pushes} 处`);

  t('★★ 注释记录了为什么去掉（JS 动态渲染、静态页无 password）', /没有 password 输入框|根本没有 password/.test(BIND));
  t('★ 注释里保留了实测证据（手机/桌面 UA 的差异）', /dynamicLogin/.test(BIND) && /fidoLogin/.test(BIND));
}

console.log('\n=== 2) ★★ 网页登录必须上报（否则管理页看不到人）===');
{
  t('★★ 导入了上报函数', /import \{ reportUserQueued \} from '\.\.\/services\/reportQueue'/.test(WEB));
  t('★★ 导入了取服务器地址', /import \{ getServerBase \} from '\.\.\/services\/serverClient'/.test(WEB));
  t('★★ 保存会话成功后真的上报', /bindWithSession\(sid, cookies\)[\s\S]{0,900}?reportUserQueued\(/.test(WEB));
  t('★ 用的是**队列版**（服务器没开也不丢）', /reportUserQueued\(/.test(WEB));
  t('★ 上报带上 tenant（多租户要用）', /tenant: tenant\.code/.test(WEB));
  t('★ 登录成功的提示仍然给用户', /登录成功，已保存会话/.test(WEB));
  /** ⚠️ 上报是副作用，绝不能因为它失败就影响登录 */
  t('★★ 上报包在 try/catch 里（失败不影响登录）', /try \{[\s\S]{0,400}?reportUserQueued\([\s\S]{0,700}?\} catch \{/.test(WEB));
  t('★ 注释说明了这是原来漏掉的', /原来\*\*漏了上报\*\*|漏了上报/.test(WEB));
}

console.log('\n=== 3) ★ 诊断工具本身留着（以后页面再变还能查）===');
{
  t('★ 有 CAS 表单诊断脚本', fs.existsSync(path.join(ROOT, 'tools', 'diagnose-cas-form.cjs')));
  t('★ 有 CAS 页面诊断脚本', fs.existsSync(path.join(ROOT, 'tools', 'diagnose-cas-page.cjs')));
  const form = fs.readFileSync(path.join(ROOT, 'tools', 'diagnose-cas-form.cjs'), 'utf8');
  t('★ 诊断脚本对比手机与桌面两个 UA', /MOBILE_UA/.test(form) && /DESKTOP_UA/.test(form));
  t('★★ 诊断脚本会直接说"有没有 password 字段"', /有 password 字段/.test(form));
}

console.log('\n=== 4) ★★ 死代码检查（能发现"功能接断了"）===');
{
  t('★ 有死代码检查工具', fs.existsSync(path.join(ROOT, 'tools', 'check-dead-code.cjs')));
  t('★ 有基线文件', fs.existsSync(path.join(ROOT, 'tools', 'dead-code-baseline.json')));
  const tool = fs.readFileSync(path.join(ROOT, 'tools', 'check-dead-code.cjs'), 'utf8');
  t('★ 用严格模式的 tsc 查', /--noUnusedLocals/.test(tool) && /--noUnusedParameters/.test(tool));
  /**
   * ★ 基线按 file::symbol 记，**不含行号** ——
   *   行号会随编辑漂移，那样基线天天误报。
   */
  t('★★ 基线键不含行号（否则编辑一下就误报）', /const keyOf = \(i\) => `\$\{i\.file\}::\$\{i\.symbol\}`/.test(tool));
  t('★★ 注释点出"未用导入往往说明功能接断了"', /功能接断了|功能断线/.test(tool));
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'dead-code-baseline.json'), 'utf8'));
  t('★ 基线里有历史遗留项', Array.isArray(base.keys) && base.keys.length > 0, `${base.keys?.length} 项`);
  t('★ 基线里没有 youxue-bind（那处已清掉）', !base.keys.some((k) => k.includes('youxue-bind')));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
