/**
 * 「别把用户数据弄丢」的回归测试。
 *
 * ══════════════ 起因（真实事故）══════════════
 * 用户说：「我刚打开管理网页为什么我新加的两条记录没了」
 *
 * 查下来是两件事叠在一起：
 *
 *   ① **服务在跑旧代码 + 旧内存**
 *      桌面上的 server.cjs 是 18:10 更新的，
 *      但服务进程是 14:32 启动的 —— 它加载的还是**旧代码**。
 *      证据：那时它连 /api/version、/api/auth-state 都返回 404。
 *      ⚠️ 更坑的是：**服务运行时改磁盘上的 data.json 是没用的**，
 *         它把数据放在内存里，下次保存会把内存里的写回文件，
 *         等于把你改的覆盖掉。
 *
 *   ② **我的重置脚本在用户数据上动刀**
 *      它以前会清空 adminPassword。那是在**用户自己的数据**上动手 ——
 *      口令是他设的，清掉等于替他改了安全设置，
 *      而且他下次就会看到"管理页打不开"（正是他抱怨过的症状）。
 *
 * ══════════════ 这个测试保证什么 ══════════════
 *   · 重置脚本默认只碰开发目录，动别处必须显式 --force
 *   · 动之前一定先备份
 *   · 绝不清空管理口令
 *   · 只删我们自己编的测试学号（9…/8… 开头），真实学号一律保留
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RESET = fs.readFileSync(path.join(ROOT, 'tools', 'reset-server-data.cjs'), 'utf8');
const NODE = process.execPath;

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

console.log('=== 1) ★★ 默认只碰开发目录（防止误删用户真数据）===');
{
  t('★ 有 DEV_FILE 白名单', /const DEV_FILE = path\.resolve\(__dirname, '\.\.', 'server', 'data\.json'\)/.test(RESET));
  t('★★ 非白名单路径直接拒绝', /path\.resolve\(FILE\) !== DEV_FILE && !FORCE/.test(RESET));
  t('★ 拒绝时退出码是 2（能与"正常完成"区分）', /process\.exit\(2\)/.test(RESET));
  t('★ 提示里说明了要加 --force', /加 --force/.test(RESET));

  // 真的跑一遍，确认拒绝
  const fake = path.join(ROOT, '.tmp-not-dev-data.json');
  fs.writeFileSync(fake, JSON.stringify({ masterCode: 'x', users: {} }), 'utf8');
  let code = 0;
  let out = '';
  try {
    out = execFileSync(NODE, [path.join(ROOT, 'tools', 'reset-server-data.cjs'), fake], { encoding: 'utf8' });
  } catch (e) {
    code = e.status ?? 1;
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  t('★★ 实测：对非开发路径退出码为 2', code === 2, `实际 ${code}`);
  t('★ 实测：给出了拒绝提示', /拒绝操作/.test(out));
  // 拒绝之后文件必须原样
  const after = fs.readFileSync(fake, 'utf8');
  t('★★ 实测：被拒绝时文件没被动过', JSON.parse(after).masterCode === 'x');
  fs.unlinkSync(fake);
}

console.log('\n=== 2) ★★ 动之前必须先备份 ===');
{
  t('★★ 有备份逻辑', /copyFileSync\(FILE, backup\)/.test(RESET));
  t('★ 备份文件名带时间戳（不会互相覆盖）', /before-reset-\$\{Date\.now\(\)\}/.test(RESET));
  t('★ 没改动时清掉备份（不留垃圾）', /fs\.unlinkSync\(backup\)/.test(RESET));
  t('★ 改动时把备份名打出来（用户知道去哪找）', /备份：\$\{path\.basename\(backup\)\}/.test(RESET));
}

console.log('\n=== 3) ★★ 绝不清空管理口令 ===');
{
  /**
   * ⚠️ 这是那次事故的直接原因之一。
   *    清口令 = 替用户改了安全设置，而且他下次会看到"管理页打不开"。
   */
  t('★★ 不再把 adminPassword 写成空串', !/adminPassword:\s*''/.test(RESET));
  t('★ 注释里说明了为什么不许改', /不再清空 adminPassword|不许|替他改了安全设置/.test(RESET));
  t('★ 输出里明确标出"保留"', /管理口令：\$\{after\.adminPassword \? '已设置（保留）'/.test(RESET));
  t('★ 保留原口令而非删除（对象展开在赋值之前）', /\.\.\.before,[\s\S]{0,400}?masterCodeHistory:/.test(RESET));
}

console.log('\n=== 4) 只删测试学号，真实学号一律保留 ===');
{
  /**
   * ⚠️ 原先的规则 `/^[89]0{4,}/` 漏掉了 `9900000000001`
   *    （9 后面又跟 9，匹配不上），测试记录会一直留着。
   *    这个是测试抓出来的。
   */
  t('★ 规则改成了 /^(?:9|80{4,})/', /\^\(\?:9\|80\{4,\}\)/.test(RESET));
  t('★ 只删匹配到的，不是清空 users', /for \(const id of testIds\) delete users\[id\]/.test(RESET));
  t('★ 注释记录了原先漏掉的那一类', /9900000000001/.test(RESET));

  // 复刻判定验证
  const isTest = (id) => /^(?:9|80{4,})/.test(id);
  const CASES = [
    ['2099000000109（真实）', '2099000000109', false],
    ['2099000000116（真实）', '2099000000116', false],
    ['2099000000114（真实）', '2099000000114', false],
    ['9900000000001（测试）', '9900000000001', true],
    ['9900000000016（测试）', '9900000000016', true],
    ['9000000000001（测试）', '9000000000001', true],
    ['80000001（测试）', '80000001', true],
    ['8051234567890（8 开头但非连串 0，保留）', '8051234567890', false],
  ];
  for (const [label, id, expect] of CASES) {
    const got = isTest(id);
    const ok = got === expect;
    console.log(`  ${ok ? '√' : '×'} ${label.padEnd(34)} → ${got ? '删' : '保留'}`);
    if (ok) pass += 1;
    else fail += 1;
  }
}

console.log('\n=== 5) ★★ 提醒"服务在跑时改文件没用" ===');
{
  /**
   * ⚠️ 这是最容易踩的坑：
   *    服务把数据放内存里，下次保存会把内存里的写回文件。
   *    所以"服务运行时改磁盘 data.json" = 白改，还会被覆盖回去。
   */
  t('★★ 脚本会提醒重启服务', /记得重启它/.test(RESET));
  t('★ 注释解释了这个机制', /把数据放在内存里|写回文件/.test(RESET));
  t('★ 注释记录了用户那次"记录没了"的根因', /新加的记录没了|服务在跑旧代码/.test(RESET));
}

console.log('\n=== 6) 用户的真实数据文件没被这个测试碰到 ===');
{
  const desktopData = 'C:\\Users\\15248\\Desktop\\LifeKit管理后台\\data.json';
  if (fs.existsSync(desktopData)) {
    const j = JSON.parse(fs.readFileSync(desktopData, 'utf8'));
    const n = Object.keys(j.users ?? {}).length;
    console.log(`  桌面数据文件：${n} 个用户，管理口令 ${j.adminPassword ? '已设置' : '(空)'}`);
    t('★ 桌面数据文件仍然存在且可解析', true);
    t('★ 里面的用户没被删光', n >= 1, `${n} 个`);
    t('★ 管理口令还在（没被清掉）', Boolean(j.adminPassword));
  } else {
    console.log('  · 本机没有那个文件，跳过（正常，交付物在用户机器上）');
  }
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
