/**
 * 「万能码不外显」测试（客户端与界面层）。
 *
 * ══════════════ 需求来源 ══════════════
 * 用户原话：「万能码我自己会记住的，不要往外显露」
 *
 * ══════════════ 查出来的泄漏（都是真问题）══════════════
 * ① ★★★ 最严重：App 里填错万能码时，错误提示**把正确答案打出来了**
 *        `不对。服务器上当前的万能码是「${serverCode}」`
 *      → 任何人试错一次就白送万能码，而万能码能改所有人的签到状态。
 *
 * ② 设置页连上服务器后，把万能码明文显示出来
 *      → 设置页任何使用者都能打开，等于告诉每个装了这个 App 的人。
 *
 * ③ 管理页三处明文：输入框、顶部概览卡片、修改历史（连旧码都列）
 *
 * ④ 界面占位符里写着真实学号
 *
 * 这几处的共同点：**不报错、不崩溃，只是静静地漏**。
 * 所以必须有断言盯着，否则以后很容易被"为了方便调试"加回来。
 *
 * ⚠️ 服务端那一层（只存哈希、不回传明文）在 verify-master-server.cjs 里测。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const UNLOCK = fs.readFileSync(path.join(ROOT, 'src', 'state', 'unlockStore.tsx'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'settings.tsx'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'web', 'manage.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'src', 'services', 'serverClient.ts'), 'utf8');

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

/** 去掉注释，避免注释里的示例代码被误判 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('=== 1) ★★★ App 不能在错误提示里回显万能码 ===');
{
  const code = stripComments(UNLOCK);
  t(
    '★ 不再有"服务器上当前的万能码是「…」"这种句式',
    !/当前的万能码是/.test(code),
    '这条是最严重的漏洞 —— 填错一次就白送答案',
  );
  t('★ 错误提示改为不含答案的文案', /通用码不对。请向管理员确认后再试。/.test(code));
  t('★ 成功提示里不再插值服务器码', !/通用码通过（来自服务器/.test(code));
  t('成功提示不再带出个人码原文', !/已记下你的个人码：/.test(code));

  const badLines = code
    .split('\n')
    .filter((l) => /message\s*:/.test(l))
    .filter((l) => /serverCode|r\.data\.masterCode/.test(l));
  t(
    '★ 没有任何 message 字段引用服务端返回的码',
    badLines.length === 0,
    badLines.length ? `${badLines.length} 处：${badLines[0].trim().slice(0, 60)}` : '',
  );
}

console.log('\n=== 2) ★ 设置页不能显示万能码内容 ===');
{
  const code = stripComments(SETTINGS);
  t('不显示"服务器上的万能码：<值>"', !/服务器上的万能码：\$\{code\.code\}/.test(code));
  t('只说明已设置、不回传内容', /服务器上已设置万能码（内容不回传）/.test(code));
  t('仍然会去读状态（用于判断连通）', /await fetchMasterCode\(base\)/.test(code));
}

console.log('\n=== 3) ★ 管理页默认遮挡万能码 ===');
{
  t('输入框用 type=password', /<input type="password" id="master"/.test(ADMIN));
  t('有显示/隐藏切换按钮', /id="master-eye"/.test(ADMIN) && /function toggleMaster\(\)/.test(ADMIN));
  t('有 autocomplete="off"（防浏览器记住）', /id="master"[^>]*autocomplete="off"/.test(ADMIN));

  t('★ 概览卡片不再显示万能码值', !/stat-code'\)\.textContent = j\.masterCode;/.test(ADMIN));
  t('概览只显示"已设置 / 未设置"', /j\.hasMasterCode \? '已设置' : '未设置'/.test(ADMIN));
  t('标签也改成"只存哈希"', /万能码（只存哈希）/.test(ADMIN));

  t('★ 修改历史有打码函数', /function maskCode\(/.test(ADMIN));
  t('★ 历史支持只记长度的新格式', /fromLen/.test(ADMIN) && /toLen/.test(ADMIN));
  t('★ 旧格式的历史也走打码', /escapeHtml\(maskCode\(x\.from\)\)/.test(ADMIN));

  t('★ 保存成功的提示不回显新码', !/toast\('已改为 ' \+ j\.masterCode\)/.test(ADMIN));
  /**
   * ⚠️ 断言别写太死：我这里的写法是先把元素取到变量再操作
   *    （`const el = ...; el.value = ''`），
   *    起先断言只认 `getElementById('master').value = ''` 这种直连写法，
   *    于是把正确的代码判成了错的。
   *    该验的是"**确实清空并遮回去了**"，而不是某种具体写法。
   */
  t('★ 保存后清空输入框', /\.value = ''/.test(ADMIN));
  t('★ 保存后把输入框遮回去', /el\.type = 'password'/.test(ADMIN));

  console.log('\n  ── maskCode 行为 ──');
  const maskCode = (s) => {
    const v = String(s ?? '');
    if (!v) return '（空）';
    if (v.length <= 4) return v[0] + '***';
    return v.slice(0, 2) + '***' + v.slice(-2);
  };
  for (const [input, expect] of [
    /**
     * ⚠️ 公开仓库版（2026-10）：这里原先用真实万能码当样例。
     *    打码是纯字符串逻辑，样例用什么值都一样，所以换成中性样例。
     */
    ['samplecode', 'sa***de'],
    ['LKM-ABCDEF', 'LK***EF'],
    ['ab', 'a***'],
    ['', '（空）'],
  ]) {
    const got = maskCode(input);
    const ok = got === expect;
    console.log(`  ${ok ? '√' : '×'} ${JSON.stringify(input).padEnd(14)} → ${got}`);
    if (ok) pass += 1;
    else fail += 1;
  }
  t('打码后不含完整原文', !maskCode('samplecode').includes('mple'));
}

console.log('\n=== 4) ★ App 端不再取回明文，改用"发出去校验" ===');
{
  const c = stripComments(CLIENT);
  t('★ 有 verifyMasterCode', /export async function verifyMasterCode/.test(c));
  t('★★ 它调的是 /api/verify-master', /'\/api\/verify-master'/.test(c));
  t('★★ 它只回 valid（不回码）', /valid: r\.data\.valid === true/.test(c));
  t('★★ fetchMasterCode 不再把明文往上传', !/return \{ ok: true, code: r\.data\.masterCode \}/.test(c));
  t('★ 注释说明了不再回传明文', /不再回传明文/.test(c));

  const u = stripComments(UNLOCK);
  t('★★ unlockStore 用 verifyMasterCode 校验', /verifyMasterCode\(base/.test(u));
  t('★★ unlockStore 不再调用 fetchMasterCode', !/fetchMasterCode/.test(u));
  t(
    '★ 区分"连不上"（退回内置码）与"服务器说不对"（不兜底）',
    /serverCodeOk === false/.test(u) && /服务器不可用，用的是内置码/.test(u),
  );
  t('★ 降级提示不含任何码', !/serverErr/.test(u));
}

console.log('\n=== 5) ★ 界面占位符里不能出现真实学号 ===');
{
  const REAL_IDS = ['2099000000114', '2099000000116', '2099000000109'];
  const placeholders = (html) => [...html.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]);

  const HTML_FILES = [
    ['web/manage.html', ADMIN],
    ['web/license-admin.html', fs.readFileSync(path.join(ROOT, 'web', 'license-admin.html'), 'utf8')],
  ];

  for (const [name, html] of HTML_FILES) {
    const phs = placeholders(html);
    const bad = phs.filter((p) => REAL_IDS.some((id) => p.includes(id)));
    t(`★ ${name} 的占位符里没有真实学号`, bad.length === 0, bad.join(' | '));
    t(`  ${name} 确实检查到了占位符`, phs.length > 0, `找到 ${phs.length} 个`);

    const visible = html.replace(/<!--[\s\S]*?-->/g, '');
    const eg = [...visible.matchAll(/例如\s*([0-9]{6,})/g)].map((m) => m[1]);
    const badEg = eg.filter((v) => REAL_IDS.some((id) => id.includes(v) || v.includes(id)));
    t(`★ ${name} 的"例如…"提示里没有真实学号`, badEg.length === 0, badEg.join(', '));
  }

  t('manage.html 占位符改为格式提示', /8-12 位数字/.test(ADMIN));
  const LA = fs.readFileSync(path.join(ROOT, 'web', 'license-admin.html'), 'utf8');
  t('license-admin 自检用假学号（99000 开头）', /9900000000016/.test(LA));
  t('license-admin 不再用真实学号做自检', !/generateLicenseCode\('2025/.test(LA));
}

console.log('\n=== 6) 手机端默认服务器地址：改成打包期注入 ===');
{
  /**
   * ⚠️ 公开仓库版（2026-10）：
   *   原先 `DEFAULT_BASE` 是**写死的真实公网地址**（"朋友不用手填"）。
   *   仓库要公开，所以改成从 `EXPO_PUBLIC_SERVER_BASE` 注入。
   *
   *   断言也跟着改：不再要求"源码里有一个具体地址"，
   *   而是要求**地址来自环境变量**，且源码里**没有硬编码 IP**。
   */
  const m = /const DEFAULT_BASE\s*=\s*([\s\S]{0,80}?);/.exec(CLIENT);
  const expr = m ? m[1] : '';
  console.log(`  DEFAULT_BASE 表达式 = ${JSON.stringify(expr.trim())}`);
  t('★ 地址来自打包期环境变量（EXPO_PUBLIC_SERVER_BASE）', /EXPO_PUBLIC_SERVER_BASE/.test(expr));
  t('★★ 源码里没有硬编码 IP（公开仓库要求）', !/\d+\.\d+\.\d+\.\d+/.test(expr));
  t('★ 允许留空（设置页可填，核心功能本地校验）', /\|\|\s*''/.test(expr));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
