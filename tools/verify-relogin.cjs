/**
 * 「重新登录后仍用旧 token」修复的测试。
 *
 * ══════════════ 用户报的现象 ══════════════
 * 「我朋友在很早的版本登陆过一次，我把最新的版本发给他查询就有问题了，
 *   然后给他在最上面的登录口登陆一次也是有问题」
 *
 * 截图里的报错：
 *   `没有取到课程列表。凭据诊断：token=有(32位) userId=13959768
 *    cookie数=13 服务端 HTTP=401 返回={"code":2101,"message":"无效的token"}`
 *
 * ══════════════ 根因 ══════════════
 * `YouxueAdapter` 是**模块级单例**，缓存里装着 token + userId。
 * 判断"能不能复用"时**只比了 account.id**：
 *
 *     if (this.signApi && this.signApiAccountId === account.id) return this.signApi;
 *
 * 同一个人**用同一个学号重新登录**时 id 不变 → 判定"可以复用" →
 * 继续用第一次绑定时的**旧 token** → 401。
 *
 * 所以「重新登录一次」对他完全没效果 —— 这正是他反馈的现象。
 *
 * ══════════════ 修法 ══════════════
 * 把 `account.boundAt`（那次登录的时间戳）也纳入判断。
 * 重新登录会刷新 boundAt → 缓存作废 → 用新 token。
 *
 * ══════════════ 同时修的另一个问题 ══════════════
 * 学号打码只留后 2 位（`2025****24`），
 * 而 `…0114` 和 `…0124` 后 2 位分不清，导致排查时无法确认"当前登的谁"。
 * 改成留后 4 位。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADAPTER = fs.readFileSync(path.join(ROOT, 'src', 'services', 'checkin', 'youxueAdapter.ts'), 'utf8');
const LIST = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'SignRecordList.tsx'), 'utf8');
const CHECKIN = fs.readFileSync(path.join(ROOT, 'src', 'state', 'checkinStore.tsx'), 'utf8');

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

console.log('=== 1) ★ 重新登录必须让缓存失效 ===');
{
  t('★ 有 signApiBoundAt 字段', /private signApiBoundAt/.test(ADAPTER));
  t(
    '★★ 复用条件是 id **且** boundAt 一致',
    /this\.signApiAccountId === account\.id\s*&&[\s\S]{0,300}?this\.signApiBoundAt === \(account\.boundAt \?\? null\)/.test(
      ADAPTER,
    ),
    '只看 id 的话，同账号重新登录会复用旧 token',
  );
  t(
    '★ 构建后记下 boundAt',
    (ADAPTER.match(/this\.signApiBoundAt = account\.boundAt \?\? null;/g) ?? []).length >= 2,
    'persistSession 与 ensureSignApi 两处都要记',
  );
  // 所有清缓存的地方都要清 boundAt
  const clearId = (ADAPTER.match(/this\.signApiAccountId = null;/g) ?? []).length;
  const clearAt = (ADAPTER.match(/this\.signApiBoundAt = null;/g) ?? []).length;
  t(
    '★ 每处清 signApiAccountId 都同时清 signApiBoundAt',
    clearAt >= clearId,
    `accountId 清了 ${clearId} 次，boundAt 清了 ${clearAt} 次`,
  );
  t('★ 注释说明了踩过的坑', /重新登录完全没生效|重新登录会刷新 boundAt/.test(ADAPTER));
}

console.log('\n=== 2) ★ 学号打码要能区分是谁 ===');
{
  /** 复刻打码逻辑 */
  function mask(sid) {
    if (!sid) return '（未知）';
    if (sid.length <= 8) return sid;
    return `${sid.slice(0, 4)}****${sid.slice(-4)}`;
  }

  const CASES = [
    ['2099000000114', '2099****0114'],
    ['2099000000124', '2099****0124'],
    ['2099000000116', '2099****0116'],
  ];
  for (const [input, expect] of CASES) {
    const got = mask(input);
    const ok = got === expect;
    console.log(`  ${ok ? '√' : '×'} ${input} → ${got}`);
    if (ok) pass += 1;
    else fail += 1;
  }

  t('★★ 0114 与 0124 打码后能区分（后 2 位不行）', mask('2099000000114') !== mask('2099000000124'));
  t('★ 0114 与 0116 也能区分', mask('2099000000114') !== mask('2099000000116'));
  t('★ 完整学号没被暴露', !mask('2099000000114').includes('2099000000114'));
  t('源码里改成了后 4 位', /sid\.slice\(-4\)/.test(LIST));
  t('源码里不再用后 2 位', !/sid\.slice\(-2\)/.test(LIST));
}

console.log('\n=== 3) 绑定时仍然会验证 token（之前的修复不能退化）===');
{
  t('★ 仍然有 token 校验块', /★\s*用 token 真的验证一次/.test(ADAPTER));
  t('★ 校验不通过就拒绝绑定', /if \(!tokenOk\) \{[\s\S]{0,900}?ok: false/.test(ADAPTER));
}

console.log('\n=== 4) 401 时给用户能照做的提示 ===');
{
  t('★ 识别 401 / 无效 token', /401\|无效的\\s\*token/.test(CHECKIN) || /401\|无效的\\s\*token/.test(fs.readFileSync(path.join(ROOT, 'src', 'state', 'signStore.tsx'), 'utf8')));
  t('★ 提示去哪重新登录', /优学院 → 换账号 → 用网页登录/.test(fs.readFileSync(path.join(ROOT, 'src', 'state', 'signStore.tsx'), 'utf8')));
}

console.log('\n=== 5) 复刻缓存判断，验证真实场景 ===');
{
  /** 复刻 ensureSignApi 的复用判断 */
  function shouldReuse(cached, account) {
    if (!cached) return false;
    return cached.accountId === account.id && cached.boundAt === (account.boundAt ?? null);
  }

  const A = { id: 'dgut-2099000000114', boundAt: 1000 };

  // 场景：第一次绑定
  let cached = { accountId: A.id, boundAt: A.boundAt, token: 'OLD' };
  t('★ 同一账号、同一次登录 → 复用（正常）', shouldReuse(cached, A) === true);

  // ★ 关键场景：同一个人重新登录（id 相同，boundAt 变新）
  const A2 = { id: 'dgut-2099000000114', boundAt: 2000 };
  t(
    '★★ 同一账号**重新登录** → 不复用（会重建，用新 token）',
    shouldReuse(cached, A2) === false,
    '这正是用户遇到的：重新登录没生效',
  );

  // 旧逻辑作对照：只看 id 的话会复用
  const oldLogic = (c, acc) => Boolean(c) && c.accountId === acc.id;
  t('★ （对照）旧逻辑会错误地复用', oldLogic(cached, A2) === true);

  // 换账号
  const B = { id: 'dgut-2099000000116', boundAt: 3000 };
  t('★ 换账号 → 不复用', shouldReuse(cached, B) === false);

  // 重建后
  cached = { accountId: A2.id, boundAt: A2.boundAt, token: 'NEW' };
  t('★ 重建后恢复正常复用', shouldReuse(cached, A2) === true);
  t('★ 重建后 token 是新的', cached.token === 'NEW');
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
